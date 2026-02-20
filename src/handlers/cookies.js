// handlers/cookies.js
import { getCookiesByConsentState } from '../data/cookieDatabase.js';

export async function handleCookies(request, env) {
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

    // Get only actual cookies; one row per (siteId, name, domain) — the latest by lastSeenAt (removes duplicates)
    const { results } = await db
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
    const cookies = (results || []).map((row) => {
      const { rn, RN, ...rest } = row;
      return rest;
    });

    // Group cookies by category
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
