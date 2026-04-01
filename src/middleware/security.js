/**
 * src/middleware/security.js
 *
 * Centralised security middleware for the consent-manager Cloudflare Worker.
 *
 *  1.  SQL Injection prevention  — sanitize inputs before they touch any query path
 *  2.  XSS prevention            — strip dangerous HTML/script patterns from all string inputs
 *  3.  CSRF protection           — require X-Requested-With: XMLHttpRequest on mutating requests
 *  4.  Data exposure prevention  — strip sensitive field names from every JSON response
 *  5.  Rate limiting             — sliding-window per IP (200 req/min global)
 *  6.  CORS enforcement          — handled in utils/cors.js (env-aware allowlist)
 *  7.  Brute-force protection    — strict per-IP rate limit on auth/onboarding endpoints (10/min)
 *  8.  MitM / transport security — HSTS, X-Frame-Options, CSP, nosniff headers
 *  9.  Unauthenticated access    — requireSession() helper used by protected handlers
 * 10.  Response encoding         — all protected JSON responses are base64-wrapped so raw
 *                                  field names and values never appear in plaintext over the wire
 */

// ---------------------------------------------------------------------------
// 5 & 7 — Rate Limiting  (sliding-window, in-memory per isolate)
// ---------------------------------------------------------------------------

/** @type {Map<string, { count: number, windowStart: number }>} */
const _rl = new Map();

/**
 * Check whether a request key is within its allowed rate window.
 *
 * @param {string} key       Unique bucket key, e.g. "1.2.3.4:global"
 * @param {number} limitPerMin  Max requests allowed in a 60-second window
 * @returns {{ ok: boolean, remaining: number, limit: number, retryAfter?: number }}
 */
export function checkRateLimit(key, limitPerMin) {
  const now = Date.now();

  // Prune stale entries to prevent unbounded Map growth on long-lived isolates
  if (_rl.size > 20_000) {
    for (const [k, v] of _rl) {
      if (now - v.windowStart > 60_000) _rl.delete(k);
    }
  }

  const entry = _rl.get(key);
  if (!entry || now - entry.windowStart >= 60_000) {
    _rl.set(key, { count: 1, windowStart: now });
    return { ok: true, remaining: limitPerMin - 1, limit: limitPerMin };
  }

  if (entry.count >= limitPerMin) {
    const retryAfter = Math.ceil((60_000 - (now - entry.windowStart)) / 1000);
    return { ok: false, remaining: 0, limit: limitPerMin, retryAfter };
  }

  entry.count++;
  return { ok: true, remaining: limitPerMin - entry.count, limit: limitPerMin };
}

/** Build a 429 response for an exceeded rate limit. */
export function rateLimitedResponse(result) {
  const body = encodeEnvelope({
    success: false,
    error: 'Too many requests. Please slow down and try again.',
    code: 'RATE_LIMIT',
  });
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(result.retryAfter ?? 60),
      'X-RateLimit-Limit': String(result.limit ?? 0),
      'X-RateLimit-Remaining': '0',
    },
  });
}

// ---------------------------------------------------------------------------
// 3 — CSRF Protection (custom-header double-submit pattern)
// ---------------------------------------------------------------------------

/**
 * Verify that a mutating request carries the expected custom header.
 *
 * Browsers never auto-inject custom headers in cross-origin requests without
 * an explicit CORS preflight — and our CORS allowlist prevents unauthorised
 * preflights from succeeding — making this an effective CSRF guard.
 *
 * All requests from the webapp (browser or server-side proxy) must set:
 *   X-Requested-With: XMLHttpRequest
 */
export function validateCsrf(request) {
  return request.headers.get('X-Requested-With') === 'XMLHttpRequest';
}

// ---------------------------------------------------------------------------
// 1 & 2 — Input Sanitization (XSS + SQL injection patterns)
// ---------------------------------------------------------------------------

/**
 * Sanitize a single string value: remove/neutralise the most dangerous
 * XSS vectors and common SQL injection probe characters.
 *
 * Note: SQL injection is already prevented by D1 parameterized queries;
 * this is an additional defence-in-depth layer.
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;

  // Remove complete <script>…</script> blocks
  let s = str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '');
  // Remove remaining <script …> open tags
  s = s.replace(/<\s*script[^>]*>/gi, '');
  // Neutralise javascript: / vbscript: / data:text/html URI schemes
  s = s.replace(/\b(javascript|vbscript)\s*:/gi, '$1%3A');
  s = s.replace(/\bdata\s*:\s*text\s*\/\s*html/gi, 'data%3Atext/html');
  // Strip inline DOM event handlers  (onclick=, onload=, …)
  s = s.replace(/\bon\w+\s*=/gi, 'data-x=');
  // Remove dangerous HTML tags
  s = s.replace(/<\s*(?:iframe|object|embed|applet|base|form|meta\s+http-equiv)[^>]*>/gi, '');
  // Neutralise SQL comment sequences and stacked-query semicolons
  s = s.replace(/--(?=\s*[\w'"])/g, '&#x2D;&#x2D;');
  s = s.replace(/;\s*(?=(?:select|insert|update|delete|drop|alter|create|exec|union)\s)/gi, '&#x3B;');

  return s;
}

/** Recursively sanitize all string values in a parsed JSON object/array. */
export function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeObject(v);
    }
    return out;
  }
  return obj;
}

/**
 * Clone a Request after sanitizing its JSON body.
 * Non-JSON requests are returned unchanged.
 */
export async function sanitizeRequestBody(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return request;

  let raw;
  try { raw = await request.text(); } catch { return request; }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Return as-is so the handler can return its own 400
    return new Request(request.url, { method: request.method, headers: request.headers, body: raw });
  }

  const clean = sanitizeObject(parsed);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(clean),
  });
}

// ---------------------------------------------------------------------------
// 4 — Data Exposure Prevention
// ---------------------------------------------------------------------------

/**
 * Field names that must NEVER appear in API responses, regardless of context.
 * The strip is recursive so nested objects are also cleaned.
 */
const SENSITIVE_KEYS = new Set([
  'passwordHash',   'password_hash',  'passwordhash',
  'apiKey',         'api_key',        'apikey',
  'sessionId',      'session_id',     'sessionid',
  'codeHash',       'code_hash',
  'secret',
  'stripeSecretKey','stripe_secret_key',
  'rawPassword',    'raw_password',
  'accessToken',    'access_token',
  'refreshToken',   'refresh_token',
]);

function stripSensitive(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripSensitive);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    out[k] = stripSensitive(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 10 — Response Encoding (base64 transport envelope)
// ---------------------------------------------------------------------------

/**
 * Encode a plain JS value into the base64 transport envelope.
 * The client decodes with: JSON.parse(decodeURIComponent(escape(atob(data.d))))
 */
function encodeEnvelope(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { d: btoa(binary) };
}

/**
 * Consume a JSON response, strip sensitive fields, re-wrap in the base64
 * envelope, and return a new Response.  Non-JSON responses pass through.
 */
export async function wrapAndEncodeResponse(response) {
  const ct = response.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return response;

  let json;
  try { json = await response.json(); } catch { return response; }

  const safe     = stripSensitive(json);
  const envelope = encodeEnvelope(safe);

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Content-Encoded', '1'); // client-side hint to decode

  return new Response(JSON.stringify(envelope), { status: response.status, headers });
}

// ---------------------------------------------------------------------------
// 8 — MitM / Transport Security Headers
// ---------------------------------------------------------------------------

/**
 * Apply a full set of hardened HTTP security headers to a Headers object.
 * Call this on every /api/ response before returning it to the client.
 */
export function applySecurityHeaders(headers) {
  // Enforce HTTPS for one year across all sub-domains (MitM / downgrade protection)
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  // Prevent MIME-type sniffing
  headers.set('X-Content-Type-Options', 'nosniff');
  // Disallow framing (clickjacking)
  headers.set('X-Frame-Options', 'DENY');
  // Legacy XSS filter (modern browsers ignore this but it doesn't hurt)
  headers.set('X-XSS-Protection', '1; mode=block');
  // Restrict referrer info to same origin
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict browser feature APIs
  headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
  // API-only: no HTML rendered from this origin, so lock down everything
  headers.set('Content-Security-Policy', "default-src 'none'");
  // Strip origin-fingerprinting response headers
  headers.delete('Server');
  headers.delete('X-Powered-By');
  headers.delete('CF-Ray'); // avoid leaking Cloudflare infra details to attackers
  return headers;
}

/** Return a new Response with security headers applied. */
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers);
  return new Response(response.body, { status: response.status, headers });
}

// ---------------------------------------------------------------------------
// 9 — Unauthenticated Access guard (used inside handlers)
// ---------------------------------------------------------------------------

/**
 * Extract a session ID from the incoming request cookies.
 * Returns null when the cookie is absent or empty.
 */
export function extractSessionId(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? m[1].trim() : null;
}
