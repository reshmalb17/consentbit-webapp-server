// handlers/customCookieRules.js
// Manages user-defined cookie categorisation rules per site.
// Table: CustomCookieRule (separate from the scanned Cookie table)

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS CustomCookieRule (
    id TEXT PRIMARY KEY,
    siteId TEXT NOT NULL,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    scriptUrlPattern TEXT,
    category TEXT NOT NULL DEFAULT 'uncategorized',
    description TEXT,
    duration TEXT,
    published INTEGER NOT NULL DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE,
    UNIQUE(siteId, name, domain)
  )
`;

async function ensureTable(db) {
  await db.prepare(CREATE_TABLE_SQL).run();
  // Add unique index for existing tables created without the UNIQUE constraint
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_site_name_domain ON CustomCookieRule(siteId, name, domain)`
    )
    .run();
}

export async function handleCustomCookieRules(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);
  const { method } = request;

  try {
    await ensureTable(db);

    // ── GET /api/custom-cookie-rules?siteId=... ──────────────────────────────
    if (method === 'GET') {
      const siteId = (url.searchParams.get('siteId') || '').trim();
      if (!siteId) {
        return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
      }
      const { results } = await db
        .prepare(
          `SELECT id, siteId, name, domain, scriptUrlPattern, category, description, duration, published, createdAt, updatedAt
           FROM CustomCookieRule
           WHERE siteId = ?1
           ORDER BY createdAt DESC`,
        )
        .bind(siteId)
        .all();
      return Response.json({ success: true, rules: results || [] });
    }

    // ── DELETE /api/custom-cookie-rules?id=... ───────────────────────────────
    if (method === 'DELETE') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) {
        return Response.json({ success: false, error: 'id is required' }, { status: 400 });
      }
      await db.prepare(`DELETE FROM CustomCookieRule WHERE id = ?1`).bind(id).run();
      return Response.json({ success: true });
    }

    // ── POST /api/custom-cookie-rules ────────────────────────────────────────
    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
      }

      // Publish action: mark all (or specific) rules for a site as published
      if (body?.action === 'publish') {
        const siteId = String(body?.siteId || '').trim();
        if (!siteId) {
          return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
        }
        const now = new Date().toISOString();
        await db
          .prepare(`UPDATE CustomCookieRule SET published = 1, updatedAt = ?1 WHERE siteId = ?2`)
          .bind(now, siteId)
          .run();
        return Response.json({ success: true });
      }

      // Add rule
      const siteId = String(body?.siteId || '').trim();
      const name = String(body?.name || '').trim();
      const domain = String(body?.domain || '').trim();
      const scriptUrlPattern = String(body?.scriptUrlPattern || '').trim() || null;
      const category = String(body?.category || 'uncategorized').trim().toLowerCase();
      const description = String(body?.description || '').trim() || null;
      const duration = String(body?.duration || '').trim() || null;
      const now = new Date().toISOString();

      if (!siteId || !name || !domain) {
        return Response.json(
          { success: false, error: 'siteId, name, and domain are required' },
          { status: 400 },
        );
      }

      const id = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO CustomCookieRule
             (id, siteId, name, domain, scriptUrlPattern, category, description, duration, published, createdAt, updatedAt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)
           ON CONFLICT(siteId, name, domain) DO UPDATE SET
             scriptUrlPattern = excluded.scriptUrlPattern,
             category = excluded.category,
             description = excluded.description,
             duration = excluded.duration,
             published = 0,
             updatedAt = excluded.updatedAt`,
        )
        .bind(id, siteId, name, domain, scriptUrlPattern, category, description, duration, now)
        .run();

      // Add UNIQUE constraint support via separate migration if needed
      const inserted = await db
        .prepare(
          `SELECT id FROM CustomCookieRule WHERE siteId = ?1 AND name = ?2 AND domain = ?3 LIMIT 1`,
        )
        .bind(siteId, name, domain)
        .first();

      return Response.json({ success: true, id: inserted?.id ?? id });
    }

    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  } catch (err) {
    console.error('[CustomCookieRules] Error:', err);
    return Response.json({ success: false, error: err?.message || 'Internal error' }, { status: 500 });
  }
}
