// handlers/scanHistory.js
import {
  loadPublishedCustomCookieRules,
  matchPublishedCustomRule,
  hostHintsFromSiteDomain,
} from '../utils/customCookieRules.js';

export async function handleScanHistory(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const siteId = url.searchParams.get('siteId');

  if (!siteId) {
    return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
  }

  try {
    // Ensure schema exists
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ScanHistory (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        scanUrl TEXT,
        scriptsFound INTEGER DEFAULT 0,
        cookiesFound INTEGER DEFAULT 0,
        scanDuration INTEGER,
        scanStatus TEXT DEFAULT 'completed',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
      )
    `).run();

    // Add categories column if not present (migration)
    try {
      await db.prepare(`ALTER TABLE ScanHistory ADD COLUMN categories TEXT`).run();
    } catch (e) {
      // Column already exists, ignore
    }


    const { results } = await db
      .prepare(
        'SELECT * FROM ScanHistory WHERE siteId = ?1 ORDER BY createdAt DESC LIMIT 50'
      )
      .bind(siteId)
      .all();

    const publishedRules = await loadPublishedCustomCookieRules(db, siteId);
    const siteRow = await db
      .prepare(`SELECT domain FROM Site WHERE id = ?1 LIMIT 1`)
      .bind(siteId)
      .first();
    const siteHints = hostHintsFromSiteDomain(siteRow?.domain ?? siteRow?.DOMAIN ?? '');

    /**
     * Cookie rows use ON CONFLICT(siteId,name,domain) with scanHistoryId updated to the latest scan,
     * so older ScanHistory ids often have zero Cookie rows — categories must fall back to the
     * snapshot stored on ScanHistory.categories when the scan completed.
     */
    function categoriesFromSnapshot(scan) {
      if (!scan?.categories) return null;
      try {
        const parsed = JSON.parse(scan.categories);
        if (!Array.isArray(parsed)) return null;
        return [...new Set(parsed.map((c) => String(c || '').toLowerCase().trim()).filter(Boolean))].sort();
      } catch {
        return null;
      }
    }

    // Derive category chips: live cookie rows + rules when present; else snapshot from ScanHistory.
    const scansWithCounts = await Promise.all(
      (results || []).map(async (scan) => {
        try {
          const { results: cookieRows } = await db
            .prepare(
              `SELECT name, domain, category FROM Cookie
               WHERE siteId = ?1 AND scanHistoryId = ?2
                 AND (isExpected = 0 OR isExpected IS NULL)`,
            )
            .bind(siteId, scan.id)
            .all();

          const catSet = new Set();
          for (const row of cookieRows || []) {
            const m = matchPublishedCustomRule(publishedRules, row.name, row.domain, siteHints);
            const cat = m
              ? String(m.category || 'uncategorized').toLowerCase().trim()
              : String(row.category || 'uncategorized').toLowerCase().trim();
            if (cat) catSet.add(cat);
          }
          let categories = [...catSet].sort();

          // Fall back 1: snapshot stored at scan time
          if (categories.length === 0) {
            const snap = categoriesFromSnapshot(scan);
            if (snap && snap.length > 0) categories = snap;
          }

          // Fall back 2: old scans predate the categories snapshot — the Cookie table uses
          // ON CONFLICT(siteId,name,domain) so rows always point to the latest scanHistoryId.
          // Only apply this fallback to legacy completed scans that recorded cookies (cookiesFound > 0)
          // but have no snapshot. Do NOT apply to pending scans or scans that genuinely found 0 cookies,
          // as that would assign categories from unrelated historical scans.
          const isLegacyScanWithCookies =
            scan.scanStatus === 'completed' &&
            (scan.cookiesFound ?? 0) > 0;
          if (categories.length === 0 && isLegacyScanWithCookies) {
            try {
              const { results: siteCookieRows } = await db
                .prepare(
                  `SELECT DISTINCT category FROM Cookie WHERE siteId = ?1 AND (isExpected = 0 OR isExpected IS NULL)`
                )
                .bind(siteId)
                .all();
              for (const row of siteCookieRows || []) {
                const raw = row.category ?? row.CATEGORY ?? 'uncategorized';
                const cat = String(raw).toLowerCase().trim();
                if (cat) catSet.add(cat);
              }
              categories = [...catSet].sort();
            } catch (_) {}
          }

          return {
            ...scan,
            cookiesFound: scan.cookiesFound || 0,
            categories,
          };
        } catch (e) {
          return scan;
        }
      })
    );

    return Response.json({ success: true, scans: scansWithCounts });
  } catch (err) {
    console.error('[ScanHistory] Error:', err);
    return Response.json(
      {
        success: false,
        error: err?.message || 'Failed to fetch scan history',
      },
      { status: 500 },
    );
  }
}
