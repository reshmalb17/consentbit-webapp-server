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
  if (!kv || !platformSiteId) {
    console.warn('[legacyConsentLogsFramer] missing kv or platformSiteId', { hasKv: !!kv, platformSiteId });
    return [];
  }
  const key = `consent:${platformSiteId}`;
  try {
    const raw = await kv.get(key);
    console.log('[legacyConsentLogsFramer] KV lookup', { key, rawPresent: !!raw, rawLength: raw?.length || 0 });
    if (!raw) {
      // Diagnostic: list nearby keys so we can see what *is* stored
      try {
        const listed = await kv.list({ prefix: 'consent:', limit: 10 });
        console.log('[legacyConsentLogsFramer] no value at exact key. Sample keys with prefix consent:', listed.keys.map((k) => k.name));
      } catch (e) { /* ignore */ }
      return [];
    }
    const parsed = JSON.parse(raw);
    console.log('[legacyConsentLogsFramer] parsed value', { isArray: Array.isArray(parsed), count: Array.isArray(parsed) ? parsed.length : 'not-array', sample: Array.isArray(parsed) ? parsed[0] : parsed });
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      ...entry,
      _visitorId: entry._visitorId || entry.visitorId || null,
    }));
  } catch (err) {
    console.error('[legacyConsentLogsFramer] KV parse failed for key', key, err?.message);
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

  console.log('[legacyConsentLogsFramer] site row', { id: site.id, domain: site.domain, platformSiteId: site.platformSiteId ?? site.platformsiteid });
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
  console.log('[legacyConsentLogsFramer] entries fetched', { count: entries.length, filterYear: year, filterMonth: month });

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
  console.log('[legacyConsentLogsFramer] returning', { total, returned: page.length, limit, offset });

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

/**
 * GET /api/legacy-consent-framer-raw
 *
 * Pulls consent records from the D1 `Consent` table for the given site and
 * returns them as a PLAIN JSON ARRAY in the framer plugin's native shape:
 *   [ { clientId, visitorId, preferences, policyVersion, timestamp, country,
 *       bannerType, expiresAtTimestamp, expirationDurationDays,
 *       expectedCookies, metadata }, ... ]
 *
 * Query: siteId (required), year?, month?, limit? (default 500), offset?
 *
 * No `success`/`total`/wrapper — only the array. Errors return a JSON object
 * with `error` and the appropriate HTTP status.
 */
export async function handleLegacyConsentFramerRaw(request, env) {
  const db = env.CONSENT_WEBAPP;

  const url = new URL(request.url);
  const siteIdParam = url.searchParams.get('siteId');
  if (!siteIdParam) return Response.json({ error: 'siteId required' }, { status: 400 });

  // No session check — open endpoint, scoped only by the caller's siteId.
  const site = await db
    .prepare(
      `SELECT id, name, domain FROM Site
       WHERE id = ?1 OR platformSiteId = ?1
       LIMIT 1`,
    )
    .bind(siteIdParam)
    .first()
    .catch(() => null);

  if (!site) return Response.json({ error: 'Site not found' }, { status: 404 });

  const siteId = site.id;
  const clientId = site.domain || '';

  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '500', 10), 1), 1000);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  const hasDateFilter = year && month;
  const paddedMonth = hasDateFilter ? String(month).padStart(2, '0') : '';

  let consentRows;
  try {
    const { results } = hasDateFilter
      ? await db
          .prepare(
            `SELECT id, siteId, deviceId, ipAddress, userAgent, country, region,
                    createdAt, regulation, bannerType, consentMethod, status,
                    expiresAt, consent_categories
             FROM Consent
             WHERE siteId = ?1
               AND strftime('%Y', createdAt) = ?2
               AND strftime('%m', createdAt) = ?3
             ORDER BY createdAt DESC LIMIT ?4 OFFSET ?5`,
          )
          .bind(siteId, year, paddedMonth, limit, offset)
          .all()
      : await db
          .prepare(
            `SELECT id, siteId, deviceId, ipAddress, userAgent, country, region,
                    createdAt, regulation, bannerType, consentMethod, status,
                    expiresAt, consent_categories
             FROM Consent
             WHERE siteId = ?1
             ORDER BY createdAt DESC LIMIT ?2 OFFSET ?3`,
          )
          .bind(siteId, limit, offset)
          .all();
    consentRows = results || [];
  } catch (e) {
    console.error('[legacyConsentFramerRaw] D1 query failed', e?.message);
    return Response.json({ error: 'Failed to fetch consent records' }, { status: 500 });
  }

  // Per-site expected cookies (same array attached to every record, matching
  // the framer plugin's native shape where cookies snapshot is per-event).
  let expectedCookies = [];
  try {
    const { results: cookieRows } = await db
      .prepare(
        `SELECT name, expires as duration, description, provider as toolname, category as dataCategory
         FROM Cookie
         WHERE siteId = ?1
         ORDER BY category, name`,
      )
      .bind(siteId)
      .all();
    expectedCookies = (cookieRows || []).map((c) => ({
      name: c.name || '',
      duration: c.duration || 'session',
      description: c.description || '',
      toolname: c.toolname || 'Unknown',
      dataCategory: c.dataCategory ?? null,
    }));
  } catch (e) {
    console.warn('[legacyConsentFramerRaw] cookie fetch failed (non-fatal)', e?.message);
  }

  const entries = consentRows.map((row) => {
    // Parse stored consent_categories JSON to recover analytics/marketing/personalization/doNotShare.
    let cats = {};
    if (row.consent_categories) {
      try {
        const parsed = typeof row.consent_categories === 'string'
          ? JSON.parse(row.consent_categories)
          : row.consent_categories;
        cats = (parsed && typeof parsed.categories === 'object') ? parsed.categories : (parsed || {});
      } catch { /* ignore */ }
    }

    const analytics = Boolean(cats.analytics);
    const marketing = Boolean(cats.marketing);
    const personalization = Boolean(cats.preferences ?? cats.personalization);
    const doNotShare = Boolean(cats.ccpa?.doNotSell ?? cats.doNotShare ?? cats.doNotSell);
    const action = (row.status === 'given' || analytics || marketing || personalization) ? 'acceptance' : 'rejection';
    const bannerType = String(row.bannerType || row.regulation || 'gdpr').toLowerCase();

    const tsIso = row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString();
    const expiresMs = row.expiresAt ? new Date(row.expiresAt).getTime() : null;
    const tsMs = new Date(tsIso).getTime();
    const expirationDurationDays = (expiresMs && tsMs && expiresMs > tsMs)
      ? Math.round((expiresMs - tsMs) / (24 * 60 * 60 * 1000))
      : 120;

    return {
      id: row.id,
      clientId,
      visitorId: row.deviceId || row.id,
      preferences: {
        analytics,
        marketing,
        personalization,
        doNotShare,
        action,
        bannerType,
      },
      policyVersion: '1.2',
      timestamp: tsIso,
      country: row.country || null,
      bannerType,
      expiresAtTimestamp: expiresMs ?? (tsMs + 120 * 24 * 60 * 60 * 1000),
      expirationDurationDays,
      expectedCookies,
      metadata: {
        userAgent: row.userAgent || null,
        language: null,
        platform: null,
        timezone: null,
        ip: row.ipAddress || null,
      },
    };
  });

  return Response.json(entries);
}
