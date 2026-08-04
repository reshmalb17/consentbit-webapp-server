// src/middleware/consentAccess.js
//
// Authorization for the PUBLIC consent-data endpoints:
//   GET /api/consent-logs, /api/consent-csv, /api/consent-pdf
//
// These return end-user consent PII keyed by the internal Site.id. They must NOT
// be readable by siteId alone. The legitimate callers already carry credentials:
//   • The web-app dashboard reaches them through its own Next.js proxy, which
//     FORWARDS the user's session cookie (sid) to this worker.
//   • Exported-CSV rows embed direct PDF links that carry a short-lived signed
//     download token (utils/signedToken.js) instead of a cookie, because those
//     links open cross-origin where the web-app cookie is not sent.
//
// So we gate here at the ROUTER level (not inside the handlers): the handlers are
// shared with the token-gated /api/wf/consent-* routes, which authenticate via the
// Webflow ID token and carry no sid cookie — adding a cookie check inside the
// handler would break that path.

import { getSessionById } from '../services/db.js';
import { verifyDownloadToken } from '../utils/signedToken.js';
import { requireActiveSubscriptionForConsentReport } from '../services/subscriptionGate.js';

function sidFromCookie(request) {
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? m[1].trim() : null;
}

// True when a valid web-app session's user belongs to the organization that owns
// `siteId` (the internal Site.id these handlers key on).
async function sessionOwnsSite(request, env, siteId) {
  const db = env.CONSENT_WEBAPP;
  if (!db || !siteId) return false;
  const sid = sidFromCookie(request);
  if (!sid) return false;
  const session = await getSessionById(db, sid);
  if (!session?.userId) return false;
  const owns = await db
    .prepare(
      `SELECT 1 FROM Site s
       JOIN OrganizationMember om ON om.organizationId = s.organizationId
       WHERE s.id = ?1 AND om.userId = ?2 LIMIT 1`,
    )
    .bind(siteId, session.userId)
    .first()
    .catch(() => null);
  return !!owns;
}

// Gate for /api/consent-logs and /api/consent-csv — require a session that owns
// the requested site AND an active subscription on it. Returns { ok } or
// { ok:false, status, error }.
export async function requireConsentSession(request, env) {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId') || url.searchParams.get('site_id');
  if (!siteId) return { ok: false, status: 400, error: 'siteId is required' };
  if (!(await sessionOwnsSite(request, env, siteId))) {
    return { ok: false, status: 401, error: 'Authentication required.' };
  }
  // Owning the site is not enough — consent reports are a paid deliverable.
  return requireActiveSubscriptionForConsentReport(env, siteId);
}

// Gate for /api/consent-pdf — a valid session that owns the site, OR a valid signed
// download token bound to this exact siteId+consentId (the CSV-embedded links).
// Either way the site must still hold an active subscription: a previously exported
// CSV must not keep minting consent records after the plan lapses.
export async function requireConsentPdfAccess(request, env) {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId') || url.searchParams.get('site_id');
  const consentId = url.searchParams.get('consentId');
  if (!siteId || !consentId) return { ok: false, status: 400, error: 'siteId and consentId required' };

  const token = url.searchParams.get('token');
  const authorized =
    (token && env.JWT_SECRET && await verifyDownloadToken(env.JWT_SECRET, token, siteId, consentId)) ||
    (await sessionOwnsSite(request, env, siteId));
  if (!authorized) return { ok: false, status: 401, error: 'Authentication required.' };

  return requireActiveSubscriptionForConsentReport(env, siteId);
}
