/**
 * GA4 Measurement Protocol sender — the server-side twin of services/posthog.js.
 *
 * Used for the funnel steps that can only be observed on the backend:
 *   step 5  script_generated        (onboardingFirstSetup / stripeWebhook)
 *   step 7  installation_verified   (verify + scan cron)
 *   step 10 subscription_activated  (Stripe webhook)
 *
 * Requires two env values:
 *   GA4_MEASUREMENT_ID — e.g. "G-GMTRK01CHJ" (plain var, same id the webapp uses)
 *   GA4_API_SECRET     — created in GA4 Admin → Data streams → Measurement Protocol
 *                        API secrets. MUST be a Wrangler secret, not a var.
 * If either is missing every call is a silent no-op, so this is safe to deploy
 * before the secret exists.
 */

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive the GA4 identity for an email. `userId` is the same SHA-256 hash the
 * webapp sets via gtag user_id (lib/ga.ts), so a server event and the browser
 * session resolve to one GA4 user under the User-ID reporting identity.
 *
 * `clientId` is a deterministic stand-in shaped like a gtag client id. It is NOT
 * the visitor's real `_ga` cookie value, so a server event starts its own
 * session — pass the real one through `opts.clientId` whenever the caller has it.
 */
export async function ga4IdentityForEmail(email) {
  const hash = await sha256Hex(String(email).trim().toLowerCase());
  const a = parseInt(hash.slice(0, 9), 16);
  const b = parseInt(hash.slice(9, 18), 16);
  return { clientId: `${a}.${b}`, userId: hash };
}

// GA4 rejects null/undefined and truncates strings at 100 chars.
function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue; // $groups/$set are PostHog-only
    out[key] = typeof value === 'string' ? value.slice(0, 100) : value;
  }
  return out;
}

/**
 * Send one GA4 event for the user identified by `email`.
 * @param {object} opts - { clientId, sessionId } to join a real browser session.
 */
export async function captureGa4Event(env, email, eventName, params = {}, opts = {}) {
  const measurementId = env.GA4_MEASUREMENT_ID;
  const apiSecret = env.GA4_API_SECRET;
  if (!measurementId || !apiSecret || !email) return;

  try {
    const identity = await ga4IdentityForEmail(email);
    const body = {
      client_id: opts.clientId || identity.clientId,
      user_id: identity.userId,
      events: [
        {
          name: eventName,
          params: {
            ...cleanParams(params),
            // Without this GA4 counts the event but reports 0 engaged sessions.
            engagement_time_msec: 1,
            ...(opts.sessionId ? { session_id: String(opts.sessionId) } : {}),
          },
        },
      ],
    };

    const url = `${GA4_ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // A successful MP hit returns 204 with an empty body. Validation errors are
    // only visible on the /debug/mp/collect endpoint, never here.
    if (res.status !== 204 && res.status !== 200) {
      console.warn(`[GA4] "${eventName}" unexpected status ${res.status}`);
    }
  } catch (e) {
    console.warn(`[GA4] capture failed for "${eventName}":`, e?.message);
  }
}
