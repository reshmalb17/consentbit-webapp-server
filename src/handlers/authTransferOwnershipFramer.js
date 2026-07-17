// src/handlers/authTransferOwnershipFramer.js
//
// Account ownership transfer for the FRAMER plugin (/api/framer/transfer-ownership/request).
//
// Self-contained copy of the transfer-ownership REQUEST step (step 1), tailored to
// Framer. It mirrors the shared logic in authTransferOwnership.js but is kept in its
// own file so the Webflow/dashboard handler stays untouched.
//
// Flow (unchanged from the other platforms):
//   1) [THIS FILE] The current owner submits the new owner's email + name.
//      POST /api/framer/transfer-ownership/request  { siteId, newEmail, newName }
//      → we resolve the account owner for that Framer site and email an
//        authorization LINK to the CURRENT (old) owner's email.
//   2) The old owner clicks the link, which lands on the accounts web app and calls
//      POST /api/auth/transfer-ownership/authorize  { token }.
//      → that endpoint is platform-agnostic (token only) and is REUSED as-is; there
//        is no Framer-specific copy of it. It renames the account in place and revokes
//        all sessions.
//
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY — READ BEFORE EXTENDING
//
// This route is intentionally UNAUTHENTICATED (siteId-keyed), matching the other
// /api/framer/* routes. That is safe here for one specific reason: the authorization
// link is emailed ONLY to the resolved current owner, and the transfer completes only
// when THEY click it. A caller who knows a siteId can therefore, at worst, cause an
// authorization email to be sent to the real owner (who must still approve) — they
// cannot themselves complete a transfer.
//
// Two deliberate hardening choices vs. blindly copying the shared core:
//   • The authorization-link origin is forced server-side to the accounts web app.
//     We do NOT honour a client-supplied appOrigin — letting the caller choose where
//     a live-token link points would be a phishing vector.
//   • Only ONE pending transfer per owner is kept (older ones are cancelled first),
//     limiting how much an anonymous caller can spam the owner's inbox.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getUserByEmail,
  createOwnershipTransfer,
  cancelPendingOwnershipTransfers,
} from '../services/db.js';

const TAG = '[framer-transfer-ownership]';

// The hosted page that serves /transfer-ownership/authorize (the email link target).
// env.WEBAPP_PUBLIC_URL wins if configured, so prod can override without a code change.
const DEFAULT_ACCOUNTS_ORIGIN = 'https://accounts.consentbit.com';

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

// The origin the authorization email link points at. Forced server-side — the client
// cannot influence it (see SECURITY note).
function resolveAccountsOrigin(env) {
  const configured = (env.WEBAPP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) {
    try { return new URL(configured).origin; } catch (_) { /* fall through */ }
  }
  return DEFAULT_ACCOUNTS_ORIGIN;
}

// Resolve the ConsentBit account owner (User row) for a Framer site: the owner member
// of the site's organization. Accepts either the internal Site.id (webAppSiteId) or the
// Framer platformSiteId. Returns { id, email, name } or null.
async function resolveFramerSiteOwner(db, siteId) {
  if (!siteId) return null;
  try {
    return await db
      .prepare(
        `SELECT u.id, u.email, u.name
           FROM Site s
           JOIN OrganizationMember m ON m.organizationId = s.organizationId AND lower(m.role) = 'owner'
           JOIN User u ON u.id = m.userId
          WHERE s.id = ?1 OR s.platformSiteId = ?1
          ORDER BY s.createdAt ASC
          LIMIT 1`,
      )
      .bind(siteId)
      .first();
  } catch (e) {
    console.warn(`${TAG} resolveFramerSiteOwner failed:`, e?.message || e);
    return null;
  }
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

// ── Step 1 (Framer): current owner requests the transfer ────────────────────
// POST /api/framer/transfer-ownership/request  { siteId, newEmail, newName }
export async function handleFramerTransferOwnershipRequest(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const siteId = String(body?.siteId || '').trim();
  const newEmail = String(body?.newEmail || '').trim().toLowerCase();
  const newName = String(body?.newName || '').trim();

  if (!siteId) {
    return Response.json({ success: false, error: 'siteId required' }, { status: 400 });
  }

  // Resolve the current owner for this Framer site.
  const owner = await resolveFramerSiteOwner(db, siteId);
  if (!owner) {
    return Response.json({ success: false, error: 'No account owner found for this site.' }, { status: 404 });
  }

  // Validate the new-owner details.
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
    return Response.json(
      { success: false, error: 'That email already has a ConsentBit account. Ownership can only be transferred to an email without an existing account.' },
      { status: 409 },
    );
  }

  const userId = owner.id ?? owner.userId;

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

  // Public token = "<id>.<secret>". id locates the row; secret is verified by hash.
  const token = `${row.id}.${secret}`;
  const origin = resolveAccountsOrigin(env);
  const link = `${origin}/transfer-ownership/authorize?token=${encodeURIComponent(token)}`;

  const subject = 'Authorize the ownership transfer of your ConsentBit account';
  const text = `Hello${owner.name ? ` ${owner.name}` : ''},\n\nWe received a request to transfer ownership of your ConsentBit account to ${newName} (${newEmail}).\n\nIf you made this request, authorize it here:\n${link}\n\nThis link expires in ${ttlMinutes} minutes. If you did not request this, ignore this email and your account stays unchanged.\n\nBest regards,\nConsentBit Team\n`;
  const html = authEmailHtml({ ownerName: owner.name, newEmail, newName, link, ttlMinutes });

  const hasBrevoConfig = Boolean(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL);

  if (!hasBrevoConfig) {
    // Dev fallback: no email provider configured — return the link so it can be tested.
    console.warn(`${TAG} ⚠️ DEV fallback — Brevo not configured; returning link in response.`);
    return Response.json(
      { success: true, message: 'DEV: email not configured; use the link below', authorizeLink: link, expiresAt: row.expiresAt },
      { status: 200 },
    );
  }

  // The link goes only to the current owner, so send in the background and respond now.
  ctx.waitUntil(
    sendEmailViaBrevo(env, { to: owner.email, name: owner.name, subject, text, html })
      .then(() => console.log(`${TAG} ✅ authorization email sent to owner`))
      .catch((e) => console.error(`${TAG} ❌ email send failed:`, e?.message || e)),
  );

  return Response.json(
    { success: true, sentTo: owner.email, expiresAt: row.expiresAt },
    { status: 200 },
  );
}
