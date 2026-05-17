// handlers/legacyConsentLogs.js
import { getSessionById } from '../services/db.js';
import { buildSearchKeys, getConsentRowsFromR2, getConsentRowsFromKV, transformEntry } from './legacyConsentHelpers.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * GET /api/legacy-consent-logs   (all-time)
 * GET /api/legacy-consent-monthly (monthly filtered)
 *
 * Returns consent logs for a legacy (webflow/framer) site read directly from
 * R2 (Cookie-Preferences.json + consent-v2/ keys) with KV fallback.
 */
export async function handleLegacyConsentLogs(request, env) {
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
      `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid, s.legacySource
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerUserId
       WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2 AND (s.isLegacy = 1 OR s.platformSiteId IS NOT NULL)`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);

  if (!site) return Response.json({ success: false, error: 'Legacy site not found or access denied' }, { status: 404 });

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  const kv = env.WEBFLOW_AUTHENTICATION;
  const r2 = env.R2;

  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Resolve search keys from KV site details.
  // site.name is the Webflow shortName (e.g. "biaw-stage") stored during migration —
  // R2 keys are indexed under that shortName, so include it as an extra fallback.
  const searchKeys = await buildSearchKeys(kv, platformSiteId, site.domain, site.name);

  // 1. Read R2 (Cookie-Preferences.json + consent-v2/ per-visitor keys)
  let entries = r2 ? await getConsentRowsFromR2(r2, searchKeys) : [];

  // 2. Fallback to KV Cookie-Preferences scan if R2 returned nothing
  if (entries.length === 0 && platformSiteId && kv) {
    entries = await getConsentRowsFromKV(kv, platformSiteId);
  }

  // Filter by year/month if requested
  if (year && month) {
    const paddedMonth = month.padStart(2, '0');
    entries = entries.filter((entry) => {
      const ts = entry.timestamp || entry.preferences?.lastUpdated || entry.metadata?.timestamp;
      if (!ts) return false;
      const d = new Date(ts);
      return String(d.getFullYear()) === String(year) && String(d.getMonth() + 1).padStart(2, '0') === paddedMonth;
    });
  }

  const consents = entries.map(e => transformEntry(e, siteId));
  consents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = consents.length;
  const page = consents.slice(offset, offset + limit);

  // Fetch scanned cookie inventory from D1 for this site
  const resolvedSiteId = site.id;
  const { results: cookieRows } = await db
    .prepare(
      `SELECT id, name, domain, path, category, provider, description, expires, source, lastSeenAt FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
        FROM Cookie
        WHERE siteId = ?1 AND (isExpected = 0 OR isExpected IS NULL)
      ) WHERE rn = 1
      ORDER BY category, provider, name`,
    )
    .bind(resolvedSiteId)
    .all()
    .catch(() => ({ results: [] }));

  const cookies = (cookieRows || []).map(({ rn, RN, ...rest }) => rest);

  let customCookieRules = [];
  try {
    const { results: ccrRows } = await db
      .prepare(
        `SELECT id, name, domain, scriptUrlPattern, category, duration, description
         FROM CustomCookieRule WHERE siteId = ?1 AND published = 1
         ORDER BY category, name`,
      )
      .bind(resolvedSiteId)
      .all();
    customCookieRules = ccrRows || [];
  } catch { /* non-fatal */ }

  return Response.json({
    success: true,
    consents: page,
    cookies,
    customCookieRules,
    total,
    limit,
    offset,
  });
}
