// handlers/consentLogs.js
import { ensureSchema } from '../services/db.js';

export async function handleConsentLogs(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

  if (!siteId) {
    return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
  }

  try {
    await ensureSchema(db);

    const { results: consents, meta } = await db
      .prepare(
        `SELECT id, siteId, deviceId, ipAddress, userAgent, country, region, is_eu,
                createdAt, updatedAt, regulation, bannerType, consentMethod, status, expiresAt, consent_categories
         FROM Consent WHERE siteId = ?1 ORDER BY createdAt DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(siteId, limit, offset)
      .all();

    const totalStmt = await db
      .prepare('SELECT COUNT(*) as total FROM Consent WHERE siteId = ?1')
      .bind(siteId)
      .first();

    const total = totalStmt?.total ?? 0;

    const logs = (consents || []).map((row) => {
      let categories = null;
      if (row.consent_categories) {
        try {
          const parsed = typeof row.consent_categories === 'string' ? JSON.parse(row.consent_categories) : row.consent_categories;
          categories = parsed && typeof parsed.categories === 'object' ? parsed.categories : parsed;
        } catch (_) {
          categories = null;
        }
      }
      return {
        id: row.id,
        siteId: row.siteId,
        deviceId: row.deviceId,
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
        categories,
      };
    });

    // One row per (siteId, name, domain) — latest by lastSeenAt (no duplicates in inventory)
    const { results: cookieRows } = await db
      .prepare(
        `SELECT id, name, domain, path, category, provider, description, expires, source, lastSeenAt FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
          FROM Cookie
          WHERE siteId = ?1 AND (isExpected = 0 OR isExpected IS NULL)
        ) WHERE rn = 1
        ORDER BY category, provider, name`
      )
      .bind(siteId)
      .all();

    const cookies = (cookieRows || []).map((row) => {
      const { rn, RN, ...rest } = row;
      return rest;
    });

    return Response.json({
      success: true,
      consents: logs,
      cookies,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[ConsentLogs] Error:', error);
    return Response.json(
      { success: false, error: error?.message || 'Failed to fetch consent logs' },
      { status: 500 }
    );
  }
}
