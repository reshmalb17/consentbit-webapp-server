// src/utils/cors.js
//
// CORS enforcement (security measure #6).
// The allowed-origin list is augmented at runtime from env.WEBAPP_PUBLIC_URL
// so the same worker binary can serve dev and production without redeployment.

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  
];

// Known production frontends (kept minimal; env.WEBAPP_PUBLIC_URL remains the primary source of truth).
const KNOWN_PROD_ORIGINS = [
  'https://accounts.consentbit.com',
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

// Headers that the webapp is allowed to send with credentialed requests.
// X-Requested-With is required for CSRF protection.
const ALLOW_HEADERS  = 'Content-Type, X-Requested-With, X-CB-Client';
const ALLOW_METHODS  = 'GET, HEAD, POST, OPTIONS';
const MAX_AGE        = '86400'; // 24 h preflight cache

/**
 * Add CORS headers to a protected response (allowlist-only, with credentials).
 * Pass `env` so the production origin is included in the check.
 */
export function withCors(response, request, env) {
  const origin  = request.headers.get('Origin');
  const allowed = getAllowedOrigins(env);
  const headers = new Headers(response.headers);

  if (origin && allowed.includes(origin)) {
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

  // Do not reflect Origin on error responses (prevents "allow any origin" on 4xx/5xx).
  // Successful public calls still get per-origin CORS so customer sites can call from their own domains.
  if (origin && response.status < 400) {
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

  // Endpoints accessible from any customer-site origin (embed CDN calls)
  const PUBLIC_PATHS = new Set([
    '/api/consent',
    '/api/scan-scripts',
    '/api/scan-cookies',
    '/api/pageview',
    '/api/scan-site',
    '/api/scan-pending',
  ]);

  const isPublic = PUBLIC_PATHS.has(url.pathname);
  const allowed  = getAllowedOrigins(env);

  if (origin && (isPublic || allowed.includes(origin))) {
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
