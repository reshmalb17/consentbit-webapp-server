// src/utils/consentLimits.js
//
// Input limits for the public consent-ingest routes (/api/consent, /api/framer-consent).
// Every visitor's browser posts here, so there is nothing to authenticate with; these
// limits keep a forged request from storing unbounded or nonsense data in the
// customer's consent log (their compliance evidence).
//
// Every limit was set from the live Consent table (2026-10-01, ~238k rows), so no
// banner version in the wild — standard, IAB or Framer — is rejected by them:
//   status        accepted | rejected | given | partial  (denied/withdrawn documented)
//   regulation    gdpr | ccpa
//   bannerType    gdpr | ccpa | cpa | vcdpa | ucpa | ctdpa | iab  — US state laws keep
//                 being added, so this is a format check, not a fixed list
//   consentMethod banner | gpc | preferences
//   largest IAB TCF payload ≈ 26 KB, consent categories JSON ≤ 183 chars, deviceId 36.

export const MAX_CONSENT_BODY_BYTES = 128 * 1024; // ~5x the largest real IAB consent

const ALLOWED_STATUS = new Set(['accepted', 'rejected', 'given', 'partial', 'denied', 'withdrawn']);
const SHORT_CODE = /^[a-z0-9_-]{1,32}$/i;

/**
 * Read and parse the JSON body with a size cap. Content-Length can be absent or wrong,
 * so the text is measured after reading.
 * → { ok: true, body } | { ok: false, status, error }
 */
export async function readConsentBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_CONSENT_BODY_BYTES) return { ok: false, status: 413, error: 'Consent payload too large' };
  let text;
  try { text = await request.text(); } catch (_) { return { ok: false, status: 400, error: 'Invalid JSON body' }; }
  if (text.length > MAX_CONSENT_BODY_BYTES) return { ok: false, status: 413, error: 'Consent payload too large' };
  try { return { ok: true, body: JSON.parse(text) }; } catch (_) { return { ok: false, status: 400, error: 'Invalid JSON body' }; }
}

const tooLong = (v, max) => v != null && String(v).length > max;

/** null if the standard (/api/consent) fields are acceptable, else the reason. */
export function invalidConsentFields(f) {
  if (!ALLOWED_STATUS.has(String(f.status).toLowerCase())) return 'status';
  for (const key of ['regulation', 'bannerType', 'consentMethod']) {
    if (f[key] != null && !SHORT_CODE.test(String(f[key]))) return key;
  }
  if (tooLong(f.deviceId, 128)) return 'deviceId';
  if (tooLong(f.expiresAt, 40)) return 'expiresAt';
  if (f.consentCategoriesJson != null && f.consentCategoriesJson.length > 8 * 1024) return 'consent';
  for (const key of ['law', 'consentLanguage', 'consentModel', 'noticeVersion', 'policyVersion', 'langWanted']) {
    if (tooLong(f[key], 64)) return key;
  }
  return null;
}

/** null if the Framer (/api/framer-consent) fields are acceptable, else the reason. */
export function invalidFramerConsentFields(f) {
  if (!SHORT_CODE.test(String(f.bannerType))) return 'bannerType';
  if (tooLong(f.visitorId, 128)) return 'visitorId';
  if (tooLong(f.clientId, 255)) return 'clientId';
  if (tooLong(f.platformSiteId, 128)) return 'siteId';
  return null;
}
