// handlers/legacyConsentLogs.js
import { getSessionById } from '../services/db.js';
import { requireActiveSubscriptionForConsentReport } from '../services/subscriptionGate.js';
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
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  const year  = url.searchParams.get('year');
  const month = url.searchParams.get('month');
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  console.log('[LegacyConsentLogs] request params —', { siteId, year, month, limit, offset });

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    console.warn('[LegacyConsentLogs] no session cookie');
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const session = await getSessionById(db, sid).catch((e) => {
    console.error('[LegacyConsentLogs] session lookup error:', e?.message);
    return null;
  });
  if (!session) {
    console.warn('[LegacyConsentLogs] session not found for sid:', sid?.slice(0, 8) + '…');
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId ?? session.user_id;
  console.log('[LegacyConsentLogs] userId:', userId);

  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  const site = await db
    .prepare(
      `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid, s.legacySource, s.isLegacy
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerUserId
       WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2 AND (s.isLegacy = 1 OR s.platformSiteId IS NOT NULL)`,
    )
    .bind(siteId, userId)
    .first()
    .catch((e) => {
      console.error('[LegacyConsentLogs] site DB query error:', e?.message);
      return null;
    });

  if (!site) {
    console.warn('[LegacyConsentLogs] site not found — siteId:', siteId, 'userId:', userId);
    return Response.json({ success: false, error: 'Legacy site not found or access denied' }, { status: 404 });
  }

  // Paid deliverable — no report for lapsed/cancelled/deleted subscriptions.
  const gate = await requireActiveSubscriptionForConsentReport(env, site.id);
  if (!gate.ok) {
    return Response.json(
      { success: false, error: gate.error, code: gate.code, subscriptionStatus: gate.subscriptionStatus },
      { status: gate.status },
    );
  }

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  console.log('[LegacyConsentLogs] site found —', {
    id: site.id,
    name: site.name,
    domain: site.domain,
    platformSiteId,
    legacySource: site.legacySource,
  });

  const kv = env.WEBFLOW_AUTHENTICATION;
  const r2 = env.R2;

  console.log('[LegacyConsentLogs] bindings — kv:', !!kv, '| r2:', !!r2);

  // Resolve search keys from KV site details.
  const searchKeys = await buildSearchKeys(kv, platformSiteId, site.domain, site.name);
  console.log('[LegacyConsentLogs] searchKeys:', searchKeys);

  // 1. Read R2 (Cookie-Preferences.json + consent-v2/ per-visitor keys)
  let entries = [];
  if (r2) {
    entries = await getConsentRowsFromR2(r2, searchKeys);
    console.log('[LegacyConsentLogs] R2 entries:', entries.length);
  } else {
    console.warn('[LegacyConsentLogs] R2 binding missing — skipping R2 read');
  }

  // 2. Fallback to KV Cookie-Preferences scan if R2 returned nothing
  if (entries.length === 0 && platformSiteId && kv) {
    console.log('[LegacyConsentLogs] R2 empty — falling back to KV, platformSiteId:', platformSiteId);
    entries = await getConsentRowsFromKV(kv, platformSiteId);
    console.log('[LegacyConsentLogs] KV entries:', entries.length);
  } else if (entries.length === 0) {
    console.warn('[LegacyConsentLogs] both R2 and KV returned 0 entries — platformSiteId:', platformSiteId, '| kv:', !!kv);
  }

  // 3. D1 fallback — Webflow app sites (isLegacy=0, platformSiteId set) save consent to D1.
  //    If R2/KV returned nothing, read directly from the Consent table.
  if (entries.length === 0 && !site.isLegacy) {
    console.log('[LegacyConsentLogs] non-legacy site with no R2/KV data — reading from D1, siteId:', site.id);
    try {
      const paddedMonth = month ? month.padStart(2, '0') : '';
      const hasDateFilter = year && month;
      const { results: d1Rows } = hasDateFilter
        ? await db
            .prepare(
              `SELECT id, siteId, ipAddress, userAgent, country, region, is_eu,
                      createdAt, updatedAt, regulation, bannerType, consentMethod, status,
                      expiresAt, consent_categories, domain
               FROM Consent WHERE siteId = ?1
                 AND strftime('%Y', createdAt) = ?2
                 AND strftime('%m', createdAt) = ?3
               ORDER BY createdAt DESC LIMIT 500`
            )
            .bind(site.id, String(year), paddedMonth)
            .all()
        : await db
            .prepare(
              `SELECT id, siteId, ipAddress, userAgent, country, region, is_eu,
                      createdAt, updatedAt, regulation, bannerType, consentMethod, status,
                      expiresAt, consent_categories, domain
               FROM Consent WHERE siteId = ?1 ORDER BY createdAt DESC LIMIT 500`
            )
            .bind(site.id)
            .all();

      console.log('[LegacyConsentLogs] D1 rows found:', (d1Rows || []).length);

      // Map D1 Consent rows directly to the ConsentLog shape (skip transformEntry)
      const d1Consents = (d1Rows || []).map(row => {
        let categories = null;
        if (row.consent_categories) {
          try {
            const parsed = typeof row.consent_categories === 'string'
              ? JSON.parse(row.consent_categories)
              : row.consent_categories;
            categories = parsed && typeof parsed.categories === 'object' ? parsed.categories : parsed;
          } catch { /* ignore */ }
        }
        return {
          id: row.id,
          siteId: row.siteId,
          deviceId: null,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          country: row.country,
          region: row.region,
          is_eu: row.is_eu,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          regulation: row.regulation,
          bannerType: row.bannerType,
          consentMethod: row.consentMethod,
          status: row.status,
          expiresAt: row.expiresAt,
          domain: row.domain,
          categories,
        };
      });

      // Return D1 data directly (already in the right shape — skip the R2 transform path)
      const resolvedSiteId2 = site.id;
      const { results: cookieRows2 } = await db
        .prepare(
          `SELECT id, name, domain, path, category, provider, description, expires, source, lastSeenAt FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
            FROM Cookie WHERE siteId = ?1 AND (isExpected = 0 OR isExpected IS NULL)
          ) WHERE rn = 1 ORDER BY category, provider, name`
        )
        .bind(resolvedSiteId2)
        .all()
        .catch(() => ({ results: [] }));
      const cookies2 = (cookieRows2 || []).map(({ rn, RN, ...rest }) => rest);
      let customCookieRules2 = [];
      try {
        const { results: ccrRows2 } = await db
          .prepare(`SELECT id, name, domain, scriptUrlPattern, category, duration, description
                    FROM CustomCookieRule WHERE siteId = ?1 AND published = 1 ORDER BY category, name`)
          .bind(resolvedSiteId2)
          .all();
        customCookieRules2 = ccrRows2 || [];
      } catch { /* non-fatal */ }

      console.log('[LegacyConsentLogs] D1 response — total:', d1Consents.length);
      return Response.json({
        success: true,
        consents: d1Consents.slice(offset, offset + limit),
        cookies: cookies2,
        customCookieRules: customCookieRules2,
        total: d1Consents.length,
        limit,
        offset,
      });
    } catch (d1Err) {
      console.error('[LegacyConsentLogs] D1 fallback error:', d1Err?.message);
      // fall through to return empty result
    }
  }

  // Filter by year/month if requested
  if (year && month) {
    const beforeFilter = entries.length;
    const paddedMonth = month.padStart(2, '0');
    entries = entries.filter((entry) => {
      const ts = entry.timestamp || entry.preferences?.lastUpdated || entry.metadata?.timestamp;
      if (!ts) return false;
      const d = new Date(ts);
      return String(d.getFullYear()) === String(year) && String(d.getMonth() + 1).padStart(2, '0') === paddedMonth;
    });
    console.log('[LegacyConsentLogs] year/month filter', year, paddedMonth, '—', beforeFilter, '->', entries.length, 'entries');
    if (entries.length === 0 && beforeFilter > 0) {
      console.warn('[LegacyConsentLogs] year/month filter removed all entries — no data for', year, '/', paddedMonth);
    }
  } else {
    console.log('[LegacyConsentLogs] no year/month filter applied');
  }

  const consents = entries.map(e => transformEntry(e, siteId));
  consents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const total = consents.length;
  const page = consents.slice(offset, offset + limit);

  console.log('[LegacyConsentLogs] result — total:', total, '| page size:', page.length, '| offset:', offset);

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
