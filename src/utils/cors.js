// src/utils/cors.js
//
// CORS enforcement (security measure #6).
// The allowed-origin list is augmented at runtime from env.WEBAPP_PUBLIC_URL
// so the same worker binary can serve dev and production without redeployment.

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost:3000',
  'https://localhost:5173',
  'http://localhost:1337',
];

// Known production frontends (kept minimal; env.WEBAPP_PUBLIC_URL remains the primary source of truth).
const KNOWN_PROD_ORIGINS = [
  'https://accounts.consentbit.com',
  // Cloudflare Pages test frontend (apex project domain). Preview/hash builds are
  // covered by the *.consentbit-webapp-frontend-test.pages.dev pattern below.
  'https://consentbit-webapp-frontend-test.pages.dev',
];

/**
 * Origin patterns where the host segment is dynamic per-plugin/per-build.
 * Framer plugins serve from a fresh subdomain on plugins.framercdn.com each time
 * the plugin is rebuilt, so we can't put exact origins in the allowlist.
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.plugins\.framercdn\.com$/i,
  // Webflow Designer Extensions serve the app UI from a per-app subdomain on
  // webflow-ext.com (assigned by Webflow, changes per app/build) — same situation as
  // Framer plugins above, so match the host pattern rather than an exact origin.
  /^https:\/\/[a-z0-9-]+\.webflow-ext\.com$/i,
  // Cloudflare Pages preview deployments of the test frontend get a per-build
  // hash subdomain (e.g. https://abc123.consentbit-webapp-frontend-test.pages.dev).
  /^https:\/\/[a-z0-9-]+\.consentbit-webapp-frontend-test\.pages\.dev$/i,
];

/**
 * Build the authoritative allowed-origin list for a given request context.
 * Production origin is read from env.WEBAPP_PUBLIC_URL so it never needs to
 * be hard-coded here.
 */
function getAllowedOrigins(env) {
  const origins = [...DEV_ORIGINS, ...KNOWN_PROD_ORIGINS];
  const prod = env?.WEBAPP_PUBLIC_URL || env?.ALLOWED_ORIGIN;
  if (prod) {
    try {
      const o = new URL(prod).origin;
      if (!origins.includes(o)) origins.push(o);
    } catch { /* ignore malformed URL */ }
  }
  return origins;
}

/** True if the origin matches an exact allowlist entry or one of the dynamic patterns. */
function isOriginAllowed(origin, env) {
  if (!origin) return false;
  if (getAllowedOrigins(env).includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

// Headers that the webapp is allowed to send with credentialed requests.
// X-Requested-With is required for CSRF protection.
const ALLOW_HEADERS  = 'Content-Type, X-Requested-With, X-CB-Client, Authorization, X-Webflow-Site-Id';
const ALLOW_METHODS  = 'GET, HEAD, POST, DELETE, OPTIONS';
const MAX_AGE        = '86400'; // 24 h preflight cache

/**
 * Add CORS headers to a protected response (allowlist-only, with credentials).
 * Pass `env` so the production origin is included in the check.
 */
export function withCors(response, request, env) {
  const origin  = request.headers.get('Origin');
  const headers = new Headers(response.headers);

  if (origin && isOriginAllowed(origin, env)) {
    headers.set('Access-Control-Allow-Origin',      origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }

  return new Response(response.body, { status: response.status, headers });
}

/**
 * Add CORS headers to a public response (any origin allowed, no credentials).
 * Used by endpoints called from customer CDN scripts.
 */
export function withPublicCors(response, request) {
  const origin  = request.headers.get('Origin');
  const headers = new Headers(response.headers);

  // Always reflect Origin on public endpoints — callers (CDN scripts, Webflow extension) must be
  // able to read error responses to handle failures gracefully. Error bodies contain no secrets.
  if (origin) {
    headers.set('Access-Control-Allow-Origin',  origin);
    headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
    headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
    headers.set('Vary', 'Origin');
  }

  return new Response(response.body, { status: response.status, headers });
}

/**
 * Handle OPTIONS preflight for both public and protected endpoints.
 * Pass `env` to resolve production origin for protected endpoints.
 */
export function handleOptions(request, env) {
  const origin  = request.headers.get('Origin');
  const url     = new URL(request.url);
  const headers = new Headers();

  // Endpoints accessible from any origin (embed CDN calls + Webflow Designer extension,
  // whose per-build origin can't be allowlisted). MUST stay in sync with PUBLIC_PATHS in
  // src/index.js — a path missing here fails its CORS preflight ("Failed to fetch") even
  // though the actual request would be allowed.
  const PUBLIC_PATHS = new Set([
    '/api/consent',
    '/api/framer-consent',
    '/api/scan-scripts',
    '/api/scan-cookies',
    '/api/pageview',
    '/api/scan-site',
    '/api/scan-site-consented',
    '/api/scan-pending',
    '/api/v2/webflow-free-register',
    '/api/payment/subscription',
    '/api/webflow/billing',
    '/api/webflow/cancel-subscription',
    '/api/webflow/switch-interval',
    '/api/webflow/script-cleanup',
    // Framer plugin billing surface — see handlers/framerBilling.js.
    '/api/framer/billing',
    '/api/framer/cancel-subscription',
    '/api/framer/switch-interval',
    // Framer account ownership transfer — see handlers/authTransferOwnershipFramer.js.
    '/api/framer/transfer-ownership/request',
    '/api/webflow/publish',
    '/api/webflow/domains',
    '/api/banner-customization',
    '/api/licenses/activate-license',
    '/api/licenses/check-domain-script',
    '/api/checkout-token',
    '/api/v2/webflow-checkout-token',
    // Legacy aliases without /api/ prefix (backwards-compat for older bundles)
    '/licenses/activate-license',
    '/licenses/check-domain-script',
  ]);

  const isPublic = PUBLIC_PATHS.has(url.pathname);

  if (origin && (isPublic || isOriginAllowed(origin, env))) {
    headers.set('Access-Control-Allow-Origin',  origin);
    headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
    headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
    headers.set('Access-Control-Max-Age',       MAX_AGE);
    headers.set('Vary', 'Origin');
    if (!isPublic) {
      headers.set('Access-Control-Allow-Credentials', 'true');
    }
  }

  return new Response(null, { status: 204, headers });
}
