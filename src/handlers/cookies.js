// handlers/cookies.js
import { getCookiesByConsentState } from '../data/cookieDatabase.js';
import {
  loadPublishedCustomCookieRules,
  applyPublishedRulesToCookieRows,
  hostHintsFromSiteDomain,
} from '../utils/customCookieRules.js';

export async function handleCookies(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  try {
    // Ensure schema exists
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS Cookie (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        scanHistoryId TEXT,
        name TEXT NOT NULL,
        domain TEXT,
        path TEXT,
        category TEXT NOT NULL,
        provider TEXT,
        description TEXT,
        expires TEXT,
        httpOnly INTEGER DEFAULT 0,
        secure INTEGER DEFAULT 0,
        sameSite TEXT,
        isExpected INTEGER DEFAULT 0,
        source TEXT,
        firstSeenAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastSeenAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE,
        FOREIGN KEY (scanHistoryId) REFERENCES ScanHistory(id) ON DELETE SET NULL
      )
    `).run();

    // Add isExpected and source columns if they don't exist (for existing tables)
    try {
      await db.prepare(`ALTER TABLE Cookie ADD COLUMN isExpected INTEGER DEFAULT 0`).run();
    } catch (e) {
      // Column already exists, ignore
    }
    
    try {
      await db.prepare(`ALTER TABLE Cookie ADD COLUMN source TEXT`).run();
    } catch (e) {
      // Column already exists, ignore
    }

    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
      }

      const siteId = String(body?.siteId || '').trim();
      const name = String(body?.name || '').trim();
      const category = String(body?.category || 'uncategorized').trim().toLowerCase();
      const domain = String(body?.domain || '').trim() || null;
      const description = String(body?.description || '').trim() || null;
      const provider = String(body?.provider || '').trim() || null;
      const expires = String(body?.duration || body?.expires || '').trim() || null;
      const source = String(body?.scriptUrlPattern || '').trim() || null;
      const path = '/';
      const now = new Date().toISOString();

      if (!siteId || !name) {
        return Response.json({ success: false, error: 'siteId and name are required' }, { status: 400 });
      }

      await db
        .prepare(
          `INSERT INTO Cookie (
            id, siteId, scanHistoryId, name, domain, path, category, provider, description, expires,
            httpOnly, secure, sameSite, isExpected, source, firstSeenAt, lastSeenAt
          ) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, NULL, 1, ?10, ?11, ?11)
           ON CONFLICT(siteId, name, domain) DO UPDATE SET
             category = excluded.category,
             provider = excluded.provider,
             description = excluded.description,
             expires = excluded.expires,
             source = excluded.source,
             isExpected = 1,
             lastSeenAt = excluded.lastSeenAt`,
        )
        .bind(
          crypto.randomUUID(),
          siteId,
          name,
          domain,
          path,
          category,
          provider,
          description,
          expires,
          source,
          now,
        )
        .run();

      return Response.json({ success: true });
    }

    const siteId = url.searchParams.get('siteId');
    if (!siteId) {
      return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    }

    // Find the latest completed puppeteer/dashboard scan (exclude client-detection scans)
    const latestScan = await db
      .prepare(
        `SELECT id FROM ScanHistory
         WHERE siteId = ?1 AND scanStatus = 'completed'
           AND (scanUrl NOT LIKE '%client-detection%')
         ORDER BY createdAt DESC LIMIT 1`
      )
      .bind(siteId)
      .first();

    // Get cookies from the latest completed scan only so the list matches the scan history count.
    // Fall back to all-time cookies if no scan record exists yet.
    const { results } = latestScan
      ? await db
          .prepare(
            `SELECT * FROM (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
              FROM Cookie
              WHERE siteId = ?1 AND scanHistoryId = ?2 AND (isExpected = 0 OR isExpected IS NULL)
            ) WHERE rn = 1
            ORDER BY lastSeenAt DESC, category ASC`
          )
          .bind(siteId, latestScan.id)
          .all()
      : await db
          .prepare(
            `SELECT * FROM (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
              FROM Cookie
              WHERE siteId = ?1 AND (isExpected = 0 OR isExpected IS NULL)
            ) WHERE rn = 1
            ORDER BY lastSeenAt DESC, category ASC`
          )
          .bind(siteId)
          .all();

    // Drop the rn column from each row for the response (D1 may return lowercase or uppercase)
    let cookies = (results || []).map((row) => {
      const { rn, RN, ...rest } = row;
      return rest;
    });

    // Merge manually-added cookies (isExpected = 1) only if they were actually found
    // in the latest scan. Cookies that exist in the Cookie table as expected but were
    // not detected during scanning should not appear in the cookie list.
    try {
      const expectedQuery = latestScan
        ? `SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
            FROM Cookie
            WHERE siteId = ?1 AND isExpected = 1 AND scanHistoryId = ?2
          ) WHERE rn = 1`
        : `SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
            FROM Cookie
            WHERE siteId = ?1 AND isExpected = 1
          ) WHERE rn = 1`;

      const expectedStmt = latestScan
        ? db.prepare(expectedQuery).bind(siteId, latestScan.id)
        : db.prepare(expectedQuery).bind(siteId);

      const { results: expectedRows } = await expectedStmt.all();

      if (expectedRows?.length) {
        // Build a lookup of scanned cookies by name+domain so we don't duplicate
        const scannedKeys = new Set(
          cookies.map((c) => `${String(c.name || '').toLowerCase()}|${String(c.domain || '').toLowerCase()}`)
        );
        for (const row of expectedRows) {
          const { rn, RN, ...rest } = row;
          const key = `${String(rest.name || '').toLowerCase()}|${String(rest.domain || '').toLowerCase()}`;
          if (!scannedKeys.has(key)) {
            cookies.push(rest);
          }
        }
      }
    } catch (e) {
      // Non-fatal — omit expected cookies if something goes wrong
      console.error('[Cookies] Failed to load expected cookies:', e?.message);
    }

    const publishedRules = await loadPublishedCustomCookieRules(db, siteId);
    const siteRow = await db
      .prepare(`SELECT domain FROM Site WHERE id = ?1 LIMIT 1`)
      .bind(siteId)
      .first();
    const siteDomainField = siteRow?.domain ?? siteRow?.DOMAIN ?? '';
    const siteHints = hostHintsFromSiteDomain(siteDomainField);

    // Apply published rules only to scanned cookies — manually-added (isExpected=1) cookies
    // keep the category the user explicitly assigned to them.
    cookies = cookies.map((c) => {
      if (c.isExpected) return c;
      const m = publishedRules?.length
        ? (applyPublishedRulesToCookieRows(publishedRules, [c], siteHints)[0] ?? c)
        : c;
      return m;
    });

    // Group cookies by category (after rule overlay so list matches dashboard rules)
    const cookiesByCategory = {};
    const totalCookies = cookies.length;

    for (const cookie of cookies) {
      const category = cookie.category || 'uncategorized';
      if (!cookiesByCategory[category]) {
        cookiesByCategory[category] = [];
      }
      cookiesByCategory[category].push(cookie);
    }

    // Calculate cookies by consent state using actual cookies
    const cookiesByConsent = getCookiesByConsentState(cookies, {
      analytics: true,
      marketing: true,
      behavioral: true,
      functional: true,
    });

    return Response.json({ 
      success: true, 
      cookies,
      cookiesByCategory,
      totalCookies,
      cookiesByConsent: {
        necessary: cookiesByConsent.necessary.length,
        ifAccepted: cookiesByConsent.ifAccepted.length,
        ifRejected: cookiesByConsent.ifRejected.length,
        ifPreferences: cookiesByConsent.ifPreferences.length,
      },
      categories: Object.keys(cookiesByCategory)
    });
  } catch (err) {
    console.error('[Cookies] Error:', err);
    return Response.json(
      {
        success: false,
        error: err?.message || 'Failed to fetch cookies',
      },
      { status: 500 },
    );
  }
}
