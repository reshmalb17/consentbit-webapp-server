// handlers/legacyConsentLogsFramer.js
//
// Framer-specific variant of legacyConsentLogs.js.
// Reads consent events from env.CONSENT_STORE_FRAMER (keyed by platformSiteId,
// value is a JSON array of consent records). Output shape matches
// /api/legacy-consent-logs so the dashboard can render the same way.

import { getSessionById } from '../services/db.js';
import { transformEntry } from './legacyConsentHelpers.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Read the Framer consent array from CONSENT_STORE_FRAMER for a given platformSiteId.
 * Returns [] if no entry / unparseable.
 */
async function getFramerConsentRows(kv, platformSiteId) {
  if (!kv || !platformSiteId) return [];
  try {
    const raw = await kv.get(`consent:${platformSiteId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Normalize: copy visitorId into _visitorId so transformEntry/PDF lookups work.
    return parsed.map((entry) => ({
      ...entry,
      _visitorId: entry._visitorId || entry.visitorId || null,
    }));
  } catch (err) {
    console.error('[legacyConsentLogsFramer] KV parse failed', err?.message);
    return [];
  }
}

/**
 * GET /api/legacy-consent-logs-framer
 *
 * Same response shape as /api/legacy-consent-logs but data comes from
 * CONSENT_STORE_FRAMER instead of R2/WEBFLOW_AUTHENTICATION.
 *
 * Query: siteId, year?, month?, limit?, offset?
 */
export async function handleLegacyConsentLogsFramer(request, env) {
  const db = env.CONSENT_WEBAPP;

  const sid = getSessionIdFromCookie(request);
  if (!sid) return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });

  const session = await getSessionById(db, sid).catch(() => null);
  if (!session) return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });

  const userId = session.userId ?? session.user_id;
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  const site = await db
    .prepare(
      `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerUserId
       WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);

  if (!site) return Response.json({ success: false, error: 'Site not found or access denied' }, { status: 404 });

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  if (!platformSiteId) {
    return Response.json({ success: false, error: 'Site is missing platformSiteId' }, { status: 400 });
  }

  const kv = env.CONSENT_STORE_FRAMER;
  if (!kv) {
    return Response.json({ success: false, error: 'CONSENT_STORE_FRAMER KV not configured' }, { status: 503 });
  }

  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  let entries = await getFramerConsentRows(kv, platformSiteId);

  if (year && month) {
    const paddedMonth = month.padStart(2, '0');
    entries = entries.filter((entry) => {
      const ts = entry.timestamp || entry.preferences?.lastUpdated || entry.metadata?.timestamp;
      if (!ts) return false;
      const d = new Date(ts);
      return String(d.getFullYear()) === String(year) && String(d.getMonth() + 1).padStart(2, '0') === paddedMonth;
    });
  }

  const consents = entries.map((e) => transformEntry(e, siteId));
  consents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = consents.length;
  const page = consents.slice(offset, offset + limit);

  return Response.json({
    success: true,
    consents: page,
    cookies: [],
    customCookieRules: [],
    total,
    limit,
    offset,
  });
}
