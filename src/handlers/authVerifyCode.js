import {
  getLatestValidEmailVerificationCode,
  incrementEmailVerificationAttempts,
  consumeEmailVerificationCode,
  getUserByEmail,
  createUser,
  createSession,
  getOrganizationsForUser,
  getOrCreateOrganizationForUser,
  listSites,
  getSubscriptionBySiteId,
  getEffectivePlanForOrganization,
  buildEmbedScriptUrl,
  canonicalEmbedOrigin,
} from '../services/db.js';
import { sendWelcomeEmail } from '../services/email.js';
import { sendScanReportForId } from '../services/scanReport.js';
import { recordScanClaim } from './scanClaims.js';
import { markUserEmailVerified } from '../services/db.js';
import { pwDebug } from '../utils/pwDebug.js';
// No hashing happens here: a signup password is hashed in request-code and parked on
// the OTP row, and this handler only moves that hash onto the account it creates.

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function pickSiteLicenseKey(site) {
  const k = site?.apiKey ?? site?.apikey ?? site?.api_key ?? site?.licenseKey ?? site?.licensekey ?? '';
  return k != null ? String(k).trim() : '';
}

async function buildDashboardInit(db, env, request, user, orgsInitial) {
  let orgs = orgsInitial;
  if (!orgs || orgs.length === 0) {
    const orgName = user.name ? `${user.name}'s Organization` : 'My Organization';
    const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
    orgs = [org];
  }
  const organizationId = orgs[0]?.id ?? orgs[0]?.organizationId ?? null;
  const embedOrigin = canonicalEmbedOrigin(request, env);

  const [sites, { planId: effectivePlanId }] = await Promise.all([
    listSites(db, { organizationId: organizationId || undefined }),
    getEffectivePlanForOrganization(db, organizationId, env),
  ]);

  const sitesWithPlan = await Promise.all(
    (sites || []).map(async (site) => {
      const siteId = site?.id;
      const cdnId = site?.cdnScriptId ?? site?.cdnscriptid;
      const scriptUrl = site?.embedScriptUrl || buildEmbedScriptUrl(embedOrigin, cdnId);
      const sub = siteId ? await getSubscriptionBySiteId(db, siteId) : null;
      const sitePlanId = String(sub?.planId ?? sub?.planid ?? 'free').toLowerCase();
      return {
        ...site,
        scriptUrl,
        licenseKey: pickSiteLicenseKey(site),
        planId: sitePlanId,
        subscriptionId: sub?.id ?? null,
        stripeSubscriptionId: sub?.stripeSubscriptionId ?? sub?.stripesubscriptionid ?? null,
        subscriptionCurrentPeriodEnd: sub?.currentPeriodEnd ?? sub?.currentperiodend ?? null,
        subscriptionCancelAtPeriodEnd: Number(sub?.cancelAtPeriodEnd ?? sub?.cancelatperiodend ?? 0) === 1 ? 1 : 0,
        interval: sub?.interval ?? sub?.billing_interval ?? null,
      };
    })
  );

  return {
    authenticated: true,
    user: { id: user.id, email: user.email, name: user.name },
    organizations: orgs,
    sites: sitesWithPlan,
    effectivePlanId: effectivePlanId || 'free',
  };
}

export async function handleAuthVerifyCode(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body?.email || '').trim().toLowerCase();
  const purpose = body?.purpose === 'signup' ? 'signup' : 'login';
  const code = String(body?.code || '').trim();
  // Optional cookie-scan id handed off from the scanner landing page (sent in the body).
  const scanId = (body?.scanId || '').trim();
  console.log('[AuthVerifyCode] purpose:', purpose, '| scanId received:', scanId || '(none)');
  if (!isValidEmail(email)) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return Response.json({ success: false, error: 'Valid 6-digit code is required' }, { status: 400 });
  }

  const salt = env.OTP_SECRET || 'dev-otp-secret';
  const hasBrevoConfig = Boolean(env.BREVO_API_KEY);
  const cookieFlags = hasBrevoConfig
    ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

  if (purpose === 'login') {
    // Fetch OTP row + user + hash in parallel — none depend on each other
    const [row, userPrefetch, computed] = await Promise.all([
      getLatestValidEmailVerificationCode(db, { email, purpose }),
      getUserByEmail(db, email),
      sha256Hex(`${purpose}|${email}|${code}|${salt}`),
    ]);

    if (!row?.id) return Response.json({ success: false, error: 'Code expired or not found' }, { status: 400 });

    const attempts = Number(row.attempts ?? row.Attempts ?? 0);
    const maxAttempts = Number(env.OTP_MAX_ATTEMPTS || 5) || 5;
    if (attempts >= maxAttempts) return Response.json({ success: false, error: 'Too many attempts. Request a new code.' }, { status: 429 });

    const expected = row.codeHash ?? row.codehash;
    if (!expected || computed !== expected) {
      await incrementEmailVerificationAttempts(db, row.id);
      return Response.json({ success: false, error: 'Invalid code' }, { status: 400 });
    }

    if (!userPrefetch) return Response.json({ success: false, error: 'No account found for this email. Please sign up.' }, { status: 404 });

    // Consume OTP + create session, then respond immediately.
    // dashboardInit is intentionally NOT built on the verify path: it runs several extra
    // D1 queries (sites, subscriptions, plan) that can push verify past the Next proxy
    // timeout, causing the first attempt to be canceled before the code is consumed
    // (so the user has to submit the same code twice). The dashboard fetches the same
    // data itself via /api/auth/dashboard-init on mount, which also creates the org if needed.
    const [, session] = await Promise.all([
      consumeEmailVerificationCode(db, row.id),
      createSession(db, { userId: userPrefetch.id }),
      // Logging in by emailed code proves the address just as signup does — clears the
      // unverified flag for anyone who signed up with a password and never clicked.
      markUserEmailVerified(db, userPrefetch.id).catch(() => {}),
    ]);

    // If a cookie-scan id was handed off, read it from the shared scanner DB,
    // render the PDF locally and email it — fully in the background.
    if (scanId && ctx?.waitUntil) {
      ctx.waitUntil(sendScanReportForId(env, { to: email, name: userPrefetch.name || '', scanId }));
      // Record who this scan belongs to. The scanner stores no identity of its
      // own, so this claim is the only thing that ever links a checked URL to a
      // person — and it can only be captured here, at the moment the address is
      // proven. Best-effort: never fail a login over bookkeeping.
      ctx.waitUntil(
        recordScanClaim(env.COOKIE_SCANNER_DB, {
          scanId,
          email,
          userId: userPrefetch.id,
          purpose: 'login',
        })
      );
    }

    return Response.json(
      { success: true },
      { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${session.id}; ${cookieFlags}` } },
    );
  }

  // purpose === 'signup'
  // Fetch OTP row + hash in parallel
  const [row, computed] = await Promise.all([
    getLatestValidEmailVerificationCode(db, { email, purpose }),
    sha256Hex(`${purpose}|${email}|${code}|${salt}`),
  ]);

  if (!row?.id) return Response.json({ success: false, error: 'Code expired or not found' }, { status: 400 });

  const attempts = Number(row.attempts ?? row.Attempts ?? 0);
  const maxAttempts = Number(env.OTP_MAX_ATTEMPTS || 5) || 5;
  if (attempts >= maxAttempts) return Response.json({ success: false, error: 'Too many attempts. Request a new code.' }, { status: 429 });

  const expected = row.codeHash ?? row.codehash;
  if (!expected || computed !== expected) {
    await incrementEmailVerificationAttempts(db, row.id);
    return Response.json({ success: false, error: 'Invalid code' }, { status: 400 });
  }

  const name = (row.name || '').trim() || (body?.name || '').trim() || null;
  // Set only when the signup form supplied a password (already PBKDF2-hashed in
  // request-code). Absent for OTP-only signups, which stay passwordless.
  const parkedPasswordHash = (row.passwordHash ?? row.passwordhash) || null;
  pwDebug('verify-code:row', { email, rowId: row.id, purpose, hasParkedHash: !!parkedPasswordHash, hashLen: parkedPasswordHash ? String(parkedPasswordHash).length : 0 });

  // Consume OTP + create user in parallel — createUser only needs email+name from the row (already have both)
  const [, user] = await Promise.all([
    consumeEmailVerificationCode(db, row.id),
    // Reached only when no account existed, so this OTP is the account's creation.
    // /api/auth/request-code + /verify-code are the webapp's own login flow; the
    // plugins register through SyncPlugin / webflowFreeRegister instead.
    createUser(db, {
      email,
      name,
      signupSource: 'webapp',
      // Omitted entirely when absent so createUser keeps its 'passwordless' default.
      ...(parkedPasswordHash ? { passwordHash: parkedPasswordHash } : {}),
    }),
  ]);

  pwDebug('verify-code:user-created', { userId: user.id, email: user.email, passwordSet: !!parkedPasswordHash });

  // Entering a code we emailed to this address IS proof of ownership, so this account
  // never needs the separate confirmation link the direct-signup path sends.
  // Non-fatal: a failure here must not break an otherwise-successful signup.
  try {
    await markUserEmailVerified(db, user.id);
  } catch (e) {
    console.error('[VerifyCode] markUserEmailVerified failed', e?.message || String(e));
  }

  // Create session, then respond immediately (see login-path note above — dashboardInit is
  // built lazily by /api/auth/dashboard-init, which also creates the org on first load).
  const session = await createSession(db, { userId: user.id });

  // Send welcome email in the background — non-blocking
  sendWelcomeEmail(env, ctx, { to: user.email, name: user.name || '' });

  // If a cookie-scan id was handed off from the scanner page, read it from the shared
  // scanner DB, render the PDF locally and email it — fully in the background.
  if (scanId && ctx?.waitUntil) {
    ctx.waitUntil(sendScanReportForId(env, { to: user.email, name: user.name || '', scanId }));
    // See the login path above — this is the only point identity is recoverable.
    ctx.waitUntil(
      recordScanClaim(env.COOKIE_SCANNER_DB, {
        scanId,
        email: user.email,
        userId: user.id,
        purpose: 'signup',
      })
    );
  }

  return Response.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name } },
    { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${session.id}; ${cookieFlags}` } },
  );
}

