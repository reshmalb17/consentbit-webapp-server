// handlers/scanHistory.js

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

    // Get actual cookie counts for each scan
    const scansWithCounts = await Promise.all(
      (results || []).map(async (scan) => {
        try {
          // Use stored categories snapshot if available (avoids stale data from upsert overwriting scanHistoryId)
          let categories;
          if (scan.categories) {
            try {
              categories = JSON.parse(scan.categories);
            } catch {
              categories = [];
            }
          } else {
            const { results: catRows } = await db
              .prepare(
                `SELECT DISTINCT category FROM Cookie
                 WHERE siteId = ?1 AND scanHistoryId = ?2
                   AND (isExpected = 0 OR isExpected IS NULL)
                   AND category IS NOT NULL AND TRIM(category) != ''`,
              )
              .bind(siteId, scan.id)
              .all();
            categories = [...new Set((catRows || []).map((r) => String(r.category || '').toLowerCase().trim()).filter(Boolean))].sort();
          }

          return {
            ...scan,
            cookiesFound: scan.cookiesFound || 0,
            categories,
          };
        } catch (e) {
          // If error, use original count
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
