import {
  getSessionById,
  getUserById,
  getUserByEmail,
  createOwnershipTransfer,
  getOwnershipTransferById,
  cancelPendingOwnershipTransfers,
  incrementOwnershipTransferAttempts,
  markOwnershipTransferAuthorized,
  renameUserAccount,
  deleteSessionsForUser,
  updateUserBillingEmail,
  getOrganizationsForUser,
  getSubscriptionsByOrganization,
} from '../services/db.js';
import { capturePostHogEvent } from '../services/posthog.js';

/**
 * Move billing identity to the new owner: the stored billing email and, on every Stripe
 * customer behind this account's subscriptions, the customer `email` and `name`.
 *
 * Without this the account changed hands but invoices, receipts and Stripe's dashboard
 * kept showing the PREVIOUS owner — so billing mail went to someone who no longer owns
 * the account.
 *
 * Deliberately best-effort and isolated: the rename has already been committed by the
 * time this runs, and a Stripe outage or a stale customer id must not turn a completed
 * transfer into an error for the user. Anything that fails is logged and skipped, so it
 * can be reconciled manually.
 */
async function moveBillingIdentity(db, env, userId, newEmail, newName) {
  const result = { billingEmailUpdated: false, stripeCustomersUpdated: 0, errors: [] };

  try {
    await updateUserBillingEmail(db, userId, newEmail);
    result.billingEmailUpdated = true;
  } catch (e) {
    result.errors.push('billingEmail: ' + (e?.message || e));
  }

  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) {
    result.errors.push('stripe: STRIPE_SECRET_KEY not configured');
    return result;
  }

  // One account can own several organizations, each with several subscriptions, and
  // those can share a Stripe customer — dedupe so each customer is patched once.
  let customerIds = [];
  try {
    const orgs = await getOrganizationsForUser(db, userId);
    const seen = new Set();
    for (const org of orgs) {
      const subs = await getSubscriptionsByOrganization(db, org.id);
      for (const sub of subs) {
        const cid = sub?.stripeCustomerId;
        if (cid && !seen.has(cid)) { seen.add(cid); customerIds.push(cid); }
      }
    }
  } catch (e) {
    result.errors.push('subscription lookup: ' + (e?.message || e));
    return result;
  }

  for (const customerId of customerIds) {
    try {
      const body = new URLSearchParams({ email: newEmail });
      if (newName) body.set('name', newName);
      const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        result.errors.push(`stripe ${customerId}: ${data?.error?.message || res.status}`);
        continue;
      }
      result.stripeCustomersUpdated++;
    } catch (e) {
      result.errors.push(`stripe ${customerId}: ${e?.message || e}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Account ownership transfer
//
// Flow:
//   1) The signed-in (current) owner submits the new owner's email + name.
//      POST /api/auth/transfer-ownership/request
//      → we email an authorization LINK to the CURRENT (old) email.
//   2) The old owner clicks the link, which lands on the app and calls
//      POST /api/auth/transfer-ownership/authorize with the token.
//      → we rename the account in place (email + name → new owner) and revoke
//        every session, so the old email can no longer log in and the new email
//        owns all sites / subscription / consent data (all reference userId).
// ---------------------------------------------------------------------------

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomToken() {
  // 256 bits of entropy — infeasible to guess.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendEmailViaBrevo(env, { to, name, subject, text, html }) {
  const apiKey = env.BREVO_API_KEY;
  const fromEmail = env.BREVO_FROM_EMAIL;
  const fromName = env.BREVO_FROM_NAME || 'ConsentBit';

  if (!apiKey) throw new Error('BREVO_API_KEY not configured');
  if (!fromEmail) throw new Error('BREVO_FROM_EMAIL not configured');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey, accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: to, name: name || to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Brevo send failed: ${res.status} ${t}`.slice(0, 300));
  }
}

/**
 * Build the base origin of the app the authorization link should point at.
 * Prefer an explicit origin supplied by the browser (its own location.origin,
 * validated to look like an http(s) URL), then WEBAPP_PUBLIC_URL, then the
 * request origin as a last resort.
 */
function resolveAppOrigin(request, env, suppliedOrigin) {
  const candidate = (suppliedOrigin || '').trim();
  if (candidate) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch (_) { /* fall through */ }
  }
  const configured = (env.WEBAPP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  try { return new URL(request.url).origin; } catch (_) { return ''; }
}

function authEmailHtml({ ownerName, newEmail, newName, link, ttlMinutes }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#ffffff;border-radius:12px;padding:32px 28px;border:1px solid #e5e7eb;">
      <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hello${ownerName ? ` ${ownerName}` : ''},</p>
      <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">We received a request to <strong>transfer ownership</strong> of your ConsentBit account to:</p>
      <div style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin:0 0 22px;">
        <p style="margin:0 0 4px;color:#111827;font-size:15px;font-weight:600;">${newName ? `${newName}` : newEmail}</p>
        <p style="margin:0;color:#6b7280;font-size:14px;">${newEmail}</p>
      </div>
      <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">If you made this request, click the button below to authorize it. After that, this account (all its sites, subscription and consent data) will belong to the new owner, and you will be signed out.</p>
      <p style="margin:0 0 24px;text-align:center;">
        <a href="${link}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#007AFF;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;">Authorize transfer</a>
      </p>
      <p style="margin:0 0 18px;color:#9ca3af;font-size:13px;line-height:1.6;">This link expires in ${ttlMinutes} minutes. If you did not request this, ignore this email and your account stays unchanged.</p>
      <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
    </div>
  </div>
  </body></html>`;
}

// Resolve the ConsentBit account owner (User row) for a Webflow site: the owner
// member of the site's organization. Returns { id, email, name } or null.
async function resolveWebflowSiteOwner(db, webflowSiteId) {
  if (!webflowSiteId) return null;
  try {
    return await db
      .prepare(
        `SELECT u.id, u.email, u.name
           FROM Site s
           JOIN OrganizationMember m ON m.organizationId = s.organizationId AND lower(m.role) = 'owner'
           JOIN User u ON u.id = m.userId
          WHERE s.platformSiteId = ?1
          ORDER BY s.createdAt ASC
          LIMIT 1`,
      )
      .bind(webflowSiteId)
      .first();
  } catch (e) {
    console.warn('[TransferOwnership] resolveWebflowSiteOwner failed:', e?.message || e);
    return null;
  }
}

// ── Step 1: current owner requests the transfer ────────────────────────────
// Session-authenticated entry point (webapp dashboard).
export async function handleTransferOwnershipRequest(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  const session = await getSessionById(db, sid);
  if (!session) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  const userId = session.userId ?? session.user_id;
  const owner = await getUserById(db, userId);
  if (!owner) return Response.json({ success: false, error: 'User not found' }, { status: 404 });

  return processTransferRequest(request, env, ctx, owner);
}

// Webflow-App entry point (Designer extension). Identity comes from the resolved
// Webflow ID token (see middleware/webflowIdentity.js) instead of a session cookie;
// the account owner is the owner member of the current site's organization. The
// authorization link still goes only to that owner's email — the real gate — so a
// non-owner collaborator cannot complete a transfer.
export async function handleWfTransferOwnershipRequest(request, env, ctx, identity) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const webflowSiteId = identity?.webflowSiteId
    || request.headers.get('X-Webflow-Site-Id')
    || request.headers.get('x-webflow-site-id');
  const owner = await resolveWebflowSiteOwner(db, webflowSiteId);
  if (!owner) {
    return Response.json({ success: false, error: 'No account owner found for this site.' }, { status: 404 });
  }

  return processTransferRequest(request, env, ctx, owner, { platform: 'webflow' });
}

// Shared core: given the resolved current owner, validate the request, email the
// authorization link to the owner, and record the pending transfer.
async function processTransferRequest(request, env, ctx, owner, opts = {}) {
  const db = env.CONSENT_WEBAPP;
  const userId = owner.id ?? owner.userId;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const newEmail = String(body?.newEmail || '').trim().toLowerCase();
  const newName = String(body?.newName || '').trim();
  const appOrigin = String(body?.appOrigin || '').trim();

  if (!isValidEmail(newEmail)) {
    return Response.json({ success: false, error: 'A valid new owner email is required' }, { status: 400 });
  }
  if (!newName) {
    return Response.json({ success: false, error: 'New owner name is required' }, { status: 400 });
  }
  if (newEmail === String(owner.email || '').trim().toLowerCase()) {
    return Response.json({ success: false, error: 'The new owner email must be different from the current one' }, { status: 400 });
  }

  // Reject if the target email already has its own ConsentBit account (v1: no merge).
  const clash = await getUserByEmail(db, newEmail);
  if (clash) {
    return Response.json({ success: false, error: 'That email already has a ConsentBit account. Ownership can only be transferred to an email without an existing account.' }, { status: 409 });
  }

  // Only one active request at a time.
  await cancelPendingOwnershipTransfers(db, userId);

  const secret = randomToken();
  const tokenHash = await sha256Hex(secret);
  const ttlMinutes = Number(env.OWNERSHIP_TRANSFER_TTL_MINUTES || 60) || 60;

  const row = await createOwnershipTransfer(db, {
    userId,
    currentEmail: owner.email,
    newEmail,
    newName,
    tokenHash,
    ttlMinutes,
  });

  // ownership_transfer_sent — the authorization invite is about to be sent (Webflow flow
  // only). recipient_domain_match = does the new owner's email domain match the current
  // owner's email domain (i.e. an in-org transfer vs. handing off to an outside party)?
  if (opts.platform === 'webflow' && owner.email) {
    try {
      const domainOf = (e) => String(e || '').split('@')[1] || '';
      await capturePostHogEvent(env, owner.email, 'ownership_transfer_sent', {
        recipient_domain_match: domainOf(newEmail) === domainOf(owner.email),
        platform: 'webflow',
      });
    } catch { /* analytics only */ }
  }

  // Public token = "<id>.<secret>". id locates the row; secret is verified by hash.
  const token = `${row.id}.${secret}`;
  const origin = resolveAppOrigin(request, env, appOrigin);
  const link = `${origin}/transfer-ownership/authorize?token=${encodeURIComponent(token)}`;

  const subject = 'Authorize the ownership transfer of your ConsentBit account';
  const text = `Hello${owner.name ? ` ${owner.name}` : ''},\n\nWe received a request to transfer ownership of your ConsentBit account to ${newName} (${newEmail}).\n\nIf you made this request, authorize it here:\n${link}\n\nThis link expires in ${ttlMinutes} minutes. If you did not request this, ignore this email and your account stays unchanged.\n\nBest regards,\nConsentBit Team\n`;
  const html = authEmailHtml({ ownerName: owner.name, newEmail, newName, link, ttlMinutes });

  const hasBrevoConfig = Boolean(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL);

  if (!hasBrevoConfig) {
    // Dev fallback: no email provider configured — return the link so it can be tested.
    console.warn('[TransferOwnership] ⚠️ DEV fallback — Brevo not configured; returning link in response.');
    return Response.json(
      { success: true, message: 'DEV: email not configured; use the link below', authorizeLink: link, expiresAt: row.expiresAt },
      { status: 200 },
    );
  }

  // The link goes only to the current owner (the authenticated user), so send in the
  // background and respond immediately.
  ctx.waitUntil(
    sendEmailViaBrevo(env, { to: owner.email, name: owner.name, subject, text, html })
      .then(() => console.log('[TransferOwnership] ✅ authorization email sent to owner'))
      .catch((e) => console.error('[TransferOwnership] ❌ email send failed:', e?.message || e)),
  );

  return Response.json(
    { success: true, sentTo: owner.email, expiresAt: row.expiresAt },
    { status: 200 },
  );
}

// ── Step 2: old owner clicks the link → authorize & rename in place ─────────
export async function handleTransferOwnershipAuthorize(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let token = '';
  try {
    const body = await request.json();
    token = String(body?.token || '').trim();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  if (!token) {
    // Also accept ?token= for convenience.
    try { token = String(new URL(request.url).searchParams.get('token') || '').trim(); } catch (_) {}
  }
  if (!token || !token.includes('.')) {
    return Response.json({ success: false, error: 'Invalid or missing authorization token' }, { status: 400 });
  }

  const [id, secret] = token.split('.');
  const row = await getOwnershipTransferById(db, id);
  if (!row) {
    return Response.json({ success: false, error: 'This authorization link is invalid.' }, { status: 400 });
  }

  if (row.status === 'authorized') {
    return Response.json({ success: false, error: 'This transfer has already been authorized.' }, { status: 409 });
  }
  if (row.status !== 'pending') {
    return Response.json({ success: false, error: 'This transfer request is no longer valid.' }, { status: 400 });
  }

  const attempts = Number(row.attempts ?? 0);
  if (attempts >= 5) {
    return Response.json({ success: false, error: 'Too many attempts for this link.' }, { status: 429 });
  }

  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    return Response.json({ success: false, error: 'This authorization link has expired. Please start the transfer again.' }, { status: 410 });
  }

  const computed = await sha256Hex(secret || '');
  if (!secret || computed !== row.tokenHash) {
    await incrementOwnershipTransferAttempts(db, id);
    return Response.json({ success: false, error: 'This authorization link is invalid.' }, { status: 400 });
  }

  // Guard against a race where the target email registered an account after the
  // request was created (email is UNIQUE — renaming into it would fail).
  const clash = await getUserByEmail(db, row.newEmail);
  if (clash && clash.id !== row.userId) {
    return Response.json({ success: false, error: 'That email now has its own ConsentBit account, so the transfer cannot be completed.' }, { status: 409 });
  }

  // Perform the in-place rename — this is the actual ownership transfer.
  const updated = await renameUserAccount(db, row.userId, { email: row.newEmail, name: row.newName });
  await markOwnershipTransferAuthorized(db, id);

  // Carry the billing identity across too: the stored billing email plus the Stripe
  // customer's email/name. Runs after the rename is committed and never throws, so a
  // Stripe failure leaves the transfer itself intact (see moveBillingIdentity).
  const billing = await moveBillingIdentity(db, env, row.userId, row.newEmail, row.newName);
  if (billing.errors.length) {
    console.warn('[TransferOwnership] billing identity partially moved', {
      userId: row.userId,
      billingEmailUpdated: billing.billingEmailUpdated,
      stripeCustomersUpdated: billing.stripeCustomersUpdated,
      errors: billing.errors,
    });
  }

  // Revoke all sessions so the old owner is signed out everywhere.
  await deleteSessionsForUser(db, row.userId);

  return Response.json(
    {
      success: true,
      message: 'Ownership transferred successfully.',
      newOwner: { email: updated?.email ?? row.newEmail, name: updated?.name ?? row.newName },
    },
    { status: 200 },
  );
}
