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
// Note: hashPassword removed — system is fully passwordless (OTP via email only)

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
    ]);

    // If a cookie-scan id was handed off, read it from the shared scanner DB,
    // render the PDF locally and email it — fully in the background.
    if (scanId && ctx?.waitUntil) {
      ctx.waitUntil(sendScanReportForId(env, { to: email, name: userPrefetch.name || '', scanId }));
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

  // Consume OTP + create user in parallel — createUser only needs email+name from the row (already have both)
  const [, user] = await Promise.all([
    consumeEmailVerificationCode(db, row.id),
    createUser(db, { email, name }),
  ]);

  // Create session, then respond immediately (see login-path note above — dashboardInit is
  // built lazily by /api/auth/dashboard-init, which also creates the org on first load).
  const session = await createSession(db, { userId: user.id });

  // Send welcome email in the background — non-blocking
  sendWelcomeEmail(env, ctx, { to: user.email, name: user.name || '' });

  // If a cookie-scan id was handed off from the scanner page, read it from the shared
  // scanner DB, render the PDF locally and email it — fully in the background.
  if (scanId && ctx?.waitUntil) {
    ctx.waitUntil(sendScanReportForId(env, { to: user.email, name: user.name || '', scanId }));
  }

  return Response.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name } },
    { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${session.id}; ${cookieFlags}` } },
  );
}

