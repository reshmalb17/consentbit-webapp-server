// src/handlers/webflowOAuth.js
//
// Webflow App OAuth 2.0 (Data Client) — two browser-facing GET endpoints:
//
//   GET /api/webflow/oauth/authorize  → redirects the user to Webflow's consent
//                                        screen (or returns the URL as JSON with
//                                        ?format=json).
//   GET /api/webflow/oauth/callback   → Webflow redirects back here with ?code;
//                                        we exchange it for an access token, fetch
//                                        the authorized sites/user, persist them in
//                                        the CONSENT_WEBAPP D1 database, then redirect
//                                        the user back to the app.
//
// Storage: CONSENT_WEBAPP D1 (tables WebflowOAuthState / WebflowOAuthToken /
//          WebflowOAuthSite — see services/db.js).
//
// Config (wrangler.toml [vars] + secrets):
//   WEBFLOW_CLIENT_ID            – OAuth client id (secret). Set per env: test value in the
//                                  default env, live value with `--env production`.
//                                  (Legacy fallback: webflow_TEST_CLIENT_ID.)
//   WEBFLOW_CLIENT_SECRET        – OAuth client secret (secret). Same per-env rule.
//                                  (Legacy fallback: WEBFLOW_CLIENT_TEST_SECRET.)
//   WEBFLOW_OAUTH_SCOPES         – space-separated scopes (optional; sensible default)
//   WEBFLOW_OAUTH_REDIRECT_URI   – must EXACTLY match the Redirect URI in the Webflow
//                                  App settings. If unset, derived from the request origin.
//   WEBFLOW_APP_REDIRECT         – where to send the user after install (optional).

import {
  createWebflowOAuthState,
  consumeWebflowOAuthState,
  saveWebflowOAuthToken,
  resolveWebflowOAuthToken,
  invalidateWebflowOAuthToken,
  getSubscriptionBySiteId,
  getEffectivePlanForOrganization,
  canonicalEmbedOrigin,
  buildEmbedScriptUrl,
  getBannerCustomization,
} from '../services/db.js';
import { capturePostHogEvent } from '../services/posthog.js';

const TAG = '[webflow-oauth]';

const AUTHORIZE_URL = 'https://webflow.com/oauth/authorize';
const TOKEN_URL = 'https://api.webflow.com/oauth/access_token';
const SITES_URL = 'https://api.webflow.com/v2/sites';
const AUTH_INFO_URL = 'https://api.webflow.com/v2/token/authorized_by';

// `sites:write` is required to publish a site via POST /v2/sites/{id}/publish
// (see handlers/webflowPublish.js). Tokens minted before this scope was added
// must be re-authorized to gain publish permission.
const DEFAULT_SCOPES = 'sites:read sites:write authorized_user:read custom_code:read custom_code:write';

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Hosts allowed to serve the ConsentBit banner script. Mirrors the client-side
 * allowlist (lib/scriptUrl.js) so the install-snippet URL is validated on BOTH
 * ends: any consentbit.com subdomain, localhost (dev), and any origin the
 * operator has explicitly pinned via env (CDN_BASE_URL / API_BASE_URL /
 * WEBAPP_PUBLIC_URL — covers the test workers.dev host).
 */
function isTrustedEmbedHost(host, env) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (h === 'consentbit.com' || h.endsWith('.consentbit.com')) return true;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  for (const key of ['CDN_BASE_URL', 'API_BASE_URL', 'WEBAPP_PUBLIC_URL']) {
    const val = env?.[key];
    if (!val) continue;
    try {
      if (new URL(val).hostname.toLowerCase() === h) return true;
    } catch { /* ignore malformed env URL */ }
  }
  return false;
}

/** First trusted origin among the candidates (env pin, then the request origin). */
function trustedServeOrigin(env, requestOrigin) {
  const pin = String(env?.CDN_BASE_URL || env?.API_BASE_URL || '').trim().replace(/\/+$/, '');
  for (const cand of [pin, requestOrigin]) {
    if (!cand) continue;
    try {
      if (isTrustedEmbedHost(new URL(cand).hostname, env)) return cand.replace(/\/+$/, '');
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Validate a built install-snippet URL. If its host is already trusted, keep it.
 * Otherwise — e.g. the site's frozen embedScriptUrl points at the raw *.workers.dev
 * origin rather than the vanity domain — canonicalize it onto a trusted origin
 * (env pin, else the current request origin), since the same worker serves the
 * script there. Only when no trusted origin is available do we keep the original
 * (logged) rather than break install.
 */
function sanitizeEmbedScriptUrl(scriptUrl, env, cdnScriptId, requestOrigin) {
  if (!scriptUrl) return null;
  let u;
  try { u = new URL(String(scriptUrl)); } catch { return null; }
  // Trusted if on the consentbit allowlist OR it's the worker's OWN request host
  // (e.g. the *.workers.dev test origin serving its own script) — on Cloudflare the
  // request host is always a configured worker domain, so it is inherently trusted.
  let reqHost = null;
  try { reqHost = requestOrigin ? new URL(requestOrigin).hostname.toLowerCase() : null; } catch { /* ignore */ }
  if (isTrustedEmbedHost(u.hostname, env) || (reqHost && u.hostname.toLowerCase() === reqHost)) {
    return u.toString();
  }

  const origin = trustedServeOrigin(env, requestOrigin);
  if (origin && cdnScriptId) {
    return `${origin}/consentbit/${cdnScriptId}/script.js`;
  }
  console.warn(`${TAG} embed scriptUrl host not trusted and no trusted origin to re-pin to (kept): ${u.hostname}`);
  return u.toString();
}

function resolveRedirectUri(env, url) {
  if (env.WEBFLOW_OAUTH_REDIRECT_URI) return env.WEBFLOW_OAUTH_REDIRECT_URI;
  return `${url.origin}/api/webflow/oauth/callback`;
}

/**
 * Only allow post-install redirect (`returnTo`) to hosts we control or Webflow's own —
 * prevents an open redirect (…/authorize?returnTo=https://evil.com). Returns the URL
 * if allowed, else '' (callers fall back to WEBFLOW_APP_REDIRECT / the Designer).
 */
function safeReturnTo(returnTo, env) {
  if (!returnTo) return '';
  let u;
  try { u = new URL(returnTo); } catch { return ''; }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return '';
  const h = u.hostname.toLowerCase();
  const ok =
    h === 'webflow.com' || h.endsWith('.webflow.com') ||
    h.endsWith('.webflow-ext.com') ||
    h === 'consentbit.com' || h.endsWith('.consentbit.com') ||
    h.endsWith('.consentbit-webapp-frontend-test.pages.dev') || h === 'consentbit-webapp-frontend-test.pages.dev' ||
    isLocal;
  if (ok) return u.toString();
  for (const key of ['WEBFLOW_APP_REDIRECT', 'WEBAPP_PUBLIC_URL', 'CHECKOUT_BASE_URL']) {
    const val = env?.[key];
    if (!val) continue;
    try { if (new URL(val).hostname.toLowerCase() === h) return u.toString(); } catch { /* ignore */ }
  }
  return '';
}

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function redirect(location) {
  // Built with `new Response` (mutable) so downstream security/CORS wrappers
  // can attach headers — `Response.redirect()` returns an immutable response.
  return new Response(null, { status: 302, headers: { Location: location } });
}

function finishToApp(env, { ok, error, sites, returnTo }) {
  const base = returnTo || env.WEBFLOW_APP_REDIRECT || env.WEBAPP_PUBLIC_URL || '';
  if (!base) {
    // No app URL configured — return a plain JSON result instead of redirecting.
    return Response.json({ success: !!ok, sites: sites ?? 0, error: error || null });
  }
  let dest;
  try {
    dest = new URL(base);
  } catch {
    return Response.json({ success: !!ok, sites: sites ?? 0, error: error || null });
  }
  dest.searchParams.set('webflow_oauth', ok ? 'success' : 'error');
  if (error) dest.searchParams.set('error', error);
  if (typeof sites === 'number') dest.searchParams.set('sites', String(sites));
  return redirect(dest.toString());
}

// ── 1. authorize — kick off the OAuth flow ──────────────────────────────────

export async function handleWebflowOAuthAuthorize(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  // Canonical name is WEBFLOW_CLIENT_ID; fall back to the legacy webflow_TEST_CLIENT_ID
  // so existing secrets keep working. Set the env-appropriate value per Cloudflare env
  // (test value in the default env, live value in --env production).
  const clientId = env.WEBFLOW_CLIENT_ID || env.webflow_TEST_CLIENT_ID;
  if (!clientId) {
    console.error(`${TAG} WEBFLOW_CLIENT_ID (or legacy webflow_TEST_CLIENT_ID) is not set`);
    return Response.json({ success: false, error: 'OAuth not configured' }, { status: 503 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    console.error(`${TAG} CONSENT_WEBAPP D1 binding is missing`);
    return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  }

  const url = new URL(request.url);
  const state = randomState();
  // Validate returnTo against a host allowlist before storing it (open-redirect guard).
  const returnTo = safeReturnTo(url.searchParams.get('returnTo') || '', env);
  const redirectUri = resolveRedirectUri(env, url);
  const scope = env.WEBFLOW_OAUTH_SCOPES || DEFAULT_SCOPES;

  console.log(`${TAG} → /authorize`, {
    clientIdSet: !!clientId,
    redirectUri,
    scope,
    returnTo: returnTo || '(none)',
    state: state.slice(0, 8) + '…',
    format: url.searchParams.get('format') || 'redirect',
  });

  // Persist state for CSRF validation in the callback (short-lived).
  await createWebflowOAuthState(db, { state, returnTo, ttlMinutes: 10 });
  console.log(`${TAG} state stored in D1 (10 min ttl)`);

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', state);

  // Let the app fetch the URL (to open in a popup/new tab) instead of redirecting.
  if (url.searchParams.get('format') === 'json') {
    console.log(`${TAG} returning authorize URL as JSON`);
    return Response.json({ success: true, url: authUrl.toString(), state });
  }
  console.log(`${TAG} redirecting user to Webflow consent screen`);
  return redirect(authUrl.toString());
}

// ── 1b. status — is this site authorized? (with KV→D1 backfill) ──────────────
//
//   GET /api/webflow/oauth/status?siteId=<webflowSiteId>[&verify=false]
//
// The v2 app calls this to find out whether a site already has a usable Webflow
// token. It is the single place the migration is enforced:
//   • D1 has the site            → authorized (source 'db')
//   • only KV has it (live v1)   → backfilled into D1, authorized (source 'kv-backfill')
//                                   — no re-auth; the KV token is already valid
//   • neither                    → not authorized → app sends user to /authorize
// When verify is on (default) the token is checked against Webflow; if it was
// revoked (HTTP 401) it is invalidated everywhere and reported unauthorized.
// opts.authenticated — true only when reached via the token-gated /api/wf/oauth/status
// route. The legacy public /api/webflow/oauth/status call (authenticated=false) must
// NOT return account PII (email / billingEmail): anyone can call it with just a
// siteId, so leaking those was the reviewer's High-severity finding. Non-PII routing
// fields (authorized/registered/plan/scriptUrl/…) stay, as the hosted checkout page
// relies on them and they identify no person.
export async function handleWebflowOAuthStatus(request, env, opts = {}) {
  const { authenticated = false } = opts;
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    console.error(`${TAG} CONSENT_WEBAPP D1 binding is missing`);
    return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  }

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId') || url.searchParams.get('site_id') || '';
  if (!siteId) {
    return Response.json({ success: false, error: 'Missing siteId' }, { status: 400 });
  }

  const authorizeUrl = `${url.origin}/api/webflow/oauth/authorize`;

  // D1-first → KV-fallback → backfill into D1 (migrates live v1 users, no re-auth).
  const row = await resolveWebflowOAuthToken(db, env.WEBFLOW_AUTHENTICATION, siteId);
  if (!row?.accessToken) {
    console.log(`${TAG} status: ${siteId} not authorized (no token in D1 or KV)`);
    return Response.json({ success: true, authorized: false, authorizeUrl });
  }
  console.log(`${TAG} status: ${siteId} authorized via ${row.source}`);

  // Verify the token is still live (catches uninstalled/revoked tokens). Skip with
  // ?verify=false for a fast existence-only check.
  if (url.searchParams.get('verify') !== 'false') {
    try {
      const res = await fetch(AUTH_INFO_URL, {
        headers: { Authorization: `Bearer ${row.accessToken}`, Accept: 'application/json' },
      });
      if (res.status === 401) {
        console.warn(`${TAG} status: token for ${siteId} was revoked — invalidating`);
        await invalidateWebflowOAuthToken(db, env.WEBFLOW_AUTHENTICATION, siteId);
        return Response.json({ success: true, authorized: false, revoked: true, authorizeUrl });
      }
    } catch (e) {
      // Network blip verifying — don't lock the user out; report authorized.
      console.warn(`${TAG} status: token verify failed (non-fatal)`, e?.message || e);
    }
  }

  // ── Registration + plan ───────────────────────────────────────────────────
  // A Site row keyed by this Webflow siteId means a plan was already selected
  // (free-register creates the row immediately; paid checkout does too). The app
  // uses this to route on launch:
  //   authorized && !registered  → show the Select Plan page
  //   authorized &&  registered  → show the Customize/editor page
  let registered = false;
  let webappSiteId = null;
  let plan = null;
  let version = null;
  let scriptUrl = null;
  let cdnScriptId = null;
  let bannerCreated = false; // true once a BannerCustomization row exists (Save written)
  let ownerEmail = null;     // authoritative "Account Owner" from D1 (org owner user)
  try {
    const site = await db
      .prepare('SELECT id, organizationId, version, cdnScriptId, embedScriptUrl FROM Site WHERE platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
      .bind(siteId)
      .first();
    if (site) {
      registered = true;
      webappSiteId = site.id;
      version = site.version ?? null;
      cdnScriptId = site.cdnScriptId ?? null;
      // Has the user already saved a banner for this site? (drives Create vs Update CTA)
      try { bannerCreated = !!(await getBannerCustomization(db, site.id)); } catch (_) {}
      // The CDN script URL the verifier looks for on the published page (same one
      // injected at registration): the stored embed URL, else build it.
      scriptUrl =
        site.embedScriptUrl ||
        buildEmbedScriptUrl(canonicalEmbedOrigin(request, env) || url.origin, site.cdnScriptId) ||
        `${url.origin}/consentbit/${site.cdnScriptId}/script.js`;
      // Integrity guard: only ever hand back a script URL on a ConsentBit-controlled
      // host. If the built URL derived from an unexpected request host, re-pin it to a
      // configured CDN origin (or drop it) rather than emit an untrusted <script src>.
      scriptUrl = sanitizeEmbedScriptUrl(scriptUrl, env, site.cdnScriptId, url.origin);
      // Plan: active site subscription → org effective plan → 'free'.
      const sub = await getSubscriptionBySiteId(db, site.id);
      let planId = sub ? (sub.planId ?? sub.planid ?? null) : null;
      if (!planId && site.organizationId) {
        try {
          const orgResult = await getEffectivePlanForOrganization(db, site.organizationId, env);
          planId = orgResult?.planId || null;
        } catch (_) { /* default to free below */ }
      }
      plan = planId && ['basic', 'essential', 'growth'].includes(planId) ? planId : 'free';
      // Account Owner = the organization's owner user in D1 (the real account holder),
      // NOT the billing email stamped at checkout. This is the authoritative source.
      if (site.organizationId) {
        try {
          const owner = await db
            .prepare(
              `SELECT u.email FROM OrganizationMember m JOIN User u ON u.id = m.userId
               WHERE m.organizationId = ?1 AND lower(m.role) = 'owner' LIMIT 1`,
            )
            .bind(site.organizationId)
            .first();
          if (owner?.email) ownerEmail = String(owner.email).trim().toLowerCase();
        } catch (_) { /* fall back to KV email below */ }
      }
    }
    console.log(`${TAG} status: ${siteId} registered=${registered} plan=${plan ?? 'none'} version=${version ?? 'null'} bannerCreated=${bannerCreated}`);
  } catch (e) {
    console.warn(`${TAG} status: registration lookup failed (non-fatal)`, e?.message || e);
  }

  // Workspace email from the OAuth record — used to prefill the checkout page.
  // Same KV read also backs the plan fallback below (single KV lookup).
  // Account Owner: the D1 org-owner user (authoritative). Only fall back to the KV
  // billing/OAuth email when there's no registered site/owner yet.
  let email = ownerEmail || null;
  let billingEmail = null;
  try {
    const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(siteId);
    if (kvRaw) {
      const kvEntry = typeof kvRaw === 'string' ? JSON.parse(kvRaw) : kvRaw;
      // Billing email (stamped at checkout) — used for checkout prefill, kept separate
      // from the Account Owner above.
      if (kvEntry?.billingEmail) billingEmail = String(kvEntry.billingEmail).trim().toLowerCase();
      if (!email) email = billingEmail || (kvEntry?.email ? String(kvEntry.email).trim().toLowerCase() : null);
      // Plan fallback: the D1 Subscription/org plan is primary. If the DB has no
      // paid plan for this site (plan is null or 'free'), fall back to the plan
      // stamped on the KV entry (written by checkout / the Stripe webhook).
      if ((!plan || plan === 'free') && kvEntry?.plan) {
        const kvPlan = String(kvEntry.plan).trim().toLowerCase();
        if (['basic', 'essential', 'growth'].includes(kvPlan)) {
          plan = kvPlan;
          console.log(`${TAG} status: ${siteId} plan from KV fallback=${kvPlan} (no paid plan in D1)`);
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Free-plan availability (account-level) ────────────────────────────────
  // The free tier allows one site per account. If this account (email) already
  // has a Site on a DIFFERENT platformSiteId, registering THIS site as free would
  // hit SITE_LIMIT_REACHED — surface it upfront so the app disables the free plan.
  // (Only meaningful before this site is registered; skip when already registered.)
  let freeUsed = false;
  try {
    if (email && !registered) {
      const user = await db.prepare('SELECT id FROM User WHERE email = ?1').bind(email).first();
      if (user) {
        const org = await db.prepare(
          `SELECT o.id FROM Organization o
           LEFT JOIN OrganizationMember ou ON ou.organizationId = o.id
           WHERE ou.userId = ?1
           ORDER BY o.createdAt ASC LIMIT 1`
        ).bind(user.id).first();
        if (org) {
          const sites = await db
            .prepare('SELECT platformSiteId FROM Site WHERE organizationId = ?1 LIMIT 5')
            .bind(org.id)
            .all();
          const list = sites?.results || [];
          freeUsed = list.some((s) => s.platformSiteId && s.platformSiteId !== siteId);
        }
      }
    }
    console.log(`${TAG} status: ${siteId} freeUsed=${freeUsed}`);
  } catch (e) {
    console.warn(`${TAG} status: freeUsed check failed (non-fatal)`, e?.message || e);
  }

  // webflow_app_opened — funnel step 1, captured SERVER-SIDE here (the app hits this
  // status endpoint on launch). KV dedup with a ~30-min window per site prevents
  // over-counting the repeated status calls the app fires on window focus/visibility
  // (refreshAccount). Only for authorized+registered sites we can attribute to an account
  // (email); this endpoint is Webflow-only so no platform check is needed.
  console.log(`[PostHog DEBUG] webflow_app_opened guard: siteId=${siteId} authenticated=${authenticated} registered=${registered} email=${email || 'NONE'}`);
  if (authenticated && registered && email) {
    try {
      const kv = env.WEBFLOW_AUTHENTICATION;
      const seen = kv ? await kv.get(`appopen:${siteId}`) : null;
      console.log(`[PostHog DEBUG] webflow_app_opened dedup: appopen:${siteId} seen=${seen ? 'YES (skipping)' : 'no (will fire)'}`);
      if (!seen) {
        let wfUserId = null;
        try {
          const rawAuth = kv ? await kv.get(siteId) : null;
          if (rawAuth) {
            const e = typeof rawAuth === 'string' ? JSON.parse(rawAuth) : rawAuth;
            wfUserId = e?.userId || null;
          }
        } catch { /* no user id available */ }
        await capturePostHogEvent(env, email, 'webflow_app_opened', {
          site_id: siteId,
          webflow_user_id: wfUserId,
          plan: plan || null,
          platform: 'webflow',
        });
        if (kv) await kv.put(`appopen:${siteId}`, '1', { expirationTtl: 1800 });
      }
    } catch { /* analytics only */ }
  }

  // Account PII is returned ONLY on the authenticated route. The public legacy call
  // gets the non-PII routing fields with email/billingEmail withheld.
  return Response.json({
    success: true, authorized: true, source: row.source, registered, webappSiteId,
    plan, version, scriptUrl, cdnScriptId, bannerCreated, freeUsed,
    email: authenticated ? email : null,
    billingEmail: authenticated ? billingEmail : null,
  });
}

// ── 2. callback — exchange code → token, store, return to app ────────────────

export async function handleWebflowOAuthCallback(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  console.log(`${TAG} ← /callback`, {
    hasCode: !!code,
    state: state ? state.slice(0, 8) + '…' : '(none)',
    providerError: providerError || '(none)',
  });

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    console.error(`${TAG} CONSENT_WEBAPP D1 binding is missing`);
    return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  }

  if (providerError) {
    console.warn(`${TAG} provider returned error: ${providerError}`);
    // No user identity yet (the user denied/failed before token exchange) — track as
    // an anonymous failure so the drop-off is still counted in the funnel.
    await capturePostHogEvent(env, crypto.randomUUID(), 'oauth_completed', {
      status: 'failed', error: providerError, platform: 'webflow',
    });
    return finishToApp(env, { ok: false, error: providerError });
  }
  if (!code) {
    console.warn(`${TAG} missing authorization code`);
    return Response.json({ success: false, error: 'Missing authorization code' }, { status: 400 });
  }

  // State handling:
  //  • App-initiated install (we sent the user to /authorize) → state is present,
  //    validate it for CSRF.
  //  • Webflow-initiated install (user clicks Install in Webflow / the Marketplace)
  //    → Webflow calls this redirect URI with a code but NO state. That is expected
  //    and allowed; there's nothing to CSRF-validate.
  let returnTo = '';
  if (state) {
    const stateRow = await consumeWebflowOAuthState(db, state);
    if (!stateRow) {
      console.warn(`${TAG} invalid or expired state — rejecting`);
      return Response.json({ success: false, error: 'Invalid or expired state' }, { status: 400 });
    }
    returnTo = stateRow.returnTo || '';
    console.log(`${TAG} app-initiated install; state OK, returnTo=${returnTo || '(none)'}`);
  } else {
    console.log(`${TAG} Webflow-initiated install (no state) — proceeding without CSRF check`);
  }

  const clientId = env.WEBFLOW_CLIENT_ID || env.webflow_TEST_CLIENT_ID;
  const clientSecret = env.WEBFLOW_CLIENT_SECRET || env.WEBFLOW_CLIENT_TEST_SECRET;
  if (!clientId || !clientSecret) {
    console.error(`${TAG} client credentials missing (need WEBFLOW_CLIENT_ID + WEBFLOW_CLIENT_SECRET, or legacy webflow_TEST_CLIENT_ID + WEBFLOW_CLIENT_TEST_SECRET)`);
    return Response.json({ success: false, error: 'OAuth not configured' }, { status: 503 });
  }

  // Exchange the authorization code for an access token.
  // Send redirect_uri ONLY when WE initiated the flow (state present) — our
  // /authorize step included it, so the token step must match. For a
  // Webflow-initiated install the authorize step had no redirect_uri, so
  // including one here triggers `invalid_redirect_uri`; omit it instead.
  const redirectUri = resolveRedirectUri(env, url);
  const tokenBody = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
  };
  if (state) tokenBody.redirect_uri = redirectUri;
  console.log(`${TAG} exchanging code for token`, {
    tokenUrl: TOKEN_URL,
    redirectUri: state ? redirectUri : '(omitted — Webflow-initiated)',
  });
  let tokenJson;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(tokenBody),
    });
    tokenJson = await res.json().catch(() => ({}));
    if (!res.ok || !tokenJson.access_token) {
      console.error(`${TAG} token exchange failed (HTTP ${res.status})`, tokenJson);
      await capturePostHogEvent(env, crypto.randomUUID(), 'oauth_completed', {
        status: 'failed', error: 'token_exchange_failed', platform: 'webflow',
      });
      return Response.json({ success: false, error: 'Token exchange failed' }, { status: 502 });
    }
    console.log(`${TAG} token exchange OK`, {
      httpStatus: res.status,
      tokenType: tokenJson.token_type || 'bearer',
      tokenLength: tokenJson.access_token.length, // never log the token itself
      scope: tokenJson.scope || '(not returned)',
    });
  } catch (e) {
    console.error(`${TAG} token exchange error`, e);
    return Response.json({ success: false, error: 'Token exchange error' }, { status: 502 });
  }

  const accessToken = tokenJson.access_token;

  // Fetch the sites this token can access + who authorized it (best-effort).
  let sites = [];
  let authorizedBy = null;
  try {
    const sres = await fetch(SITES_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (sres.ok) {
      const sjson = await sres.json();
      sites = Array.isArray(sjson.sites) ? sjson.sites : [];
      console.log(`${TAG} fetched ${sites.length} site(s)`,
        sites.map((s) => ({ id: s.id, name: s.displayName, shortName: s.shortName })));
    } else {
      console.warn(`${TAG} sites fetch returned HTTP ${sres.status}`);
    }
  } catch (e) {
    console.warn(`${TAG} sites fetch failed`, e);
  }
  try {
    const ures = await fetch(AUTH_INFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (ures.ok) {
      authorizedBy = await ures.json();
      console.log(`${TAG} authorized_by`, {
        userId: authorizedBy?.user?.id || authorizedBy?.id || '(unknown)',
        email: authorizedBy?.email || authorizedBy?.user?.email || '(n/a)',
      });
    } else {
      console.warn(`${TAG} authorized_by fetch returned HTTP ${ures.status}`);
    }
  } catch {
    /* non-fatal */
  }

  // Persist token (one row per user) + per-site index in CONSENT_WEBAPP.
  const userKey = authorizedBy?.user?.id || authorizedBy?.id || sites[0]?.id || state;
  console.log(`${TAG} persisting token to D1`, { userKey, siteCount: sites.length });
  try {
    await saveWebflowOAuthToken(db, {
      userKey,
      accessToken,
      tokenType: tokenJson.token_type || 'bearer',
      scope: tokenJson.scope || env.WEBFLOW_OAUTH_SCOPES || DEFAULT_SCOPES,
      authorizedBy,
      sites: sites.map((s) => ({ id: s.id, displayName: s.displayName, shortName: s.shortName })),
    });
  } catch (e) {
    console.error(`${TAG} failed to persist token`, e);
    return Response.json({ success: false, error: 'Failed to store authorization' }, { status: 500 });
  }

  // Mirror the token into WEBFLOW_AUTHENTICATION KV (keyed by site id) so the rest
  // of the live system — banner customization, script injection, the Stripe
  // webhook — which all read `accessToken` from KV keeps working for users who
  // authorize through v2. Merge into the existing entry so we never clobber
  // fields set by other paths (plan, webappSiteId, cdnScriptId, …).
  if (env.WEBFLOW_AUTHENTICATION && sites.length) {
    const wfUserId = authorizedBy?.user?.id || authorizedBy?.id || null;
    const wfEmail = authorizedBy?.email || authorizedBy?.user?.email || null;
    await Promise.all(
      sites.map(async (s) => {
        if (!s?.id) return;
        try {
          const raw = await env.WEBFLOW_AUTHENTICATION.get(s.id);
          const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
          await env.WEBFLOW_AUTHENTICATION.put(
            s.id,
            JSON.stringify({
              ...existing,
              accessToken,
              ...(wfUserId ? { userId: wfUserId } : {}),
              ...(wfEmail ? { email: wfEmail } : {}),
            }),
          );
        } catch (kvErr) {
          console.warn(`${TAG} KV mirror failed for site ${s.id}`, kvErr?.message || kvErr);
        }
      }),
    );
    console.log(`${TAG} mirrored accessToken into WEBFLOW_AUTHENTICATION KV for ${sites.length} site(s)`);
  }

  // Where to send the user after install:
  //   1. returnTo (app-initiated flow)
  //   2. WEBFLOW_APP_REDIRECT (explicit override in wrangler.toml)
  //   3. the Webflow Designer for the site they just installed on
  const installedSite = sites[0];
  const designerUrl = installedSite?.shortName
    ? `https://webflow.com/design/${installedSite.shortName}`
    : '';
  const dest = returnTo || env.WEBFLOW_APP_REDIRECT || designerUrl;

  console.log(`${TAG} ✓ done — authorized ${sites.length} site(s) for ${userKey}; redirecting to ${dest || '(none → JSON)'}`);

  // Track oauth_completed server-side, before returning to the app extension. The
  // authorized user's email is the distinct_id, so this merges into the same PostHog
  // person as every later backend event (banner_verified, banner_settings_updated, …).
  const phUserId = authorizedBy?.user?.id || authorizedBy?.id || null;
  const phEmail = authorizedBy?.email || authorizedBy?.user?.email || null;
  await capturePostHogEvent(env, phEmail || userKey, 'oauth_completed', {
    status: 'success',
    webflow_user_id: phUserId,
    sites: sites.length,
    platform: 'webflow',
  });

  return finishToApp(env, { ok: true, sites: sites.length, returnTo: dest });
}
