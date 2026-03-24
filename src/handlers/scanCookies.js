// handlers/scanCookies.js
import { 
  getSiteById, 
  createScanHistory, 
  upsertCookie 
} from '../services/db.js';
import { requestDomainMatchesSite } from '../utils/domainValidate.js';
import { 
  categorizeCookie, 
  getCookieProvider 
} from '../data/cookieDatabase.js';

async function getUserDefinedCookieRule(db, siteId, name, domain) {
  if (!siteId || !name) return null;
  const normalizedDomain = domain ? String(domain).trim().toLowerCase() : null;
  const exact = await db
    .prepare(
      `SELECT category, provider, description
       FROM Cookie
       WHERE siteId = ?1
         AND isExpected = 1
         AND lower(name) = lower(?2)
         AND lower(COALESCE(domain, '')) = lower(COALESCE(?3, ''))
       ORDER BY lastSeenAt DESC
       LIMIT 1`,
    )
    .bind(siteId, name, normalizedDomain)
    .first();
  if (exact) return exact;
  const fallback = await db
    .prepare(
      `SELECT category, provider, description
       FROM Cookie
       WHERE siteId = ?1
         AND isExpected = 1
         AND lower(name) = lower(?2)
         AND (domain IS NULL OR trim(domain) = '')
       ORDER BY lastSeenAt DESC
       LIMIT 1`,
    )
    .bind(siteId, name)
    .first();
  return fallback || null;
}

function parseCookieFromDocumentCookie(cookieString) {
  // Parse simple "name=value" format from document.cookie
  const parts = cookieString.split(';').map((p) => p.trim());
  const nameValue = parts[0].split('=');
  const name = nameValue[0].trim();
  const value = nameValue[1] || '';

  const cookie = {
    name,
    value,
    domain: null,
    path: '/',
    expires: null,
    httpOnly: false,
    secure: false,
    sameSite: null,
  };

  // Parse additional attributes if present
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].toLowerCase();
    if (part.startsWith('domain=')) {
      cookie.domain = parts[i].substring(7).trim();
    } else if (part.startsWith('path=')) {
      cookie.path = parts[i].substring(5).trim();
    } else if (part.startsWith('expires=')) {
      cookie.expires = parts[i].substring(8).trim();
    } else if (part === 'httponly') {
      cookie.httpOnly = true;
    } else if (part === 'secure') {
      cookie.secure = true;
    } else if (part.startsWith('samesite=')) {
      cookie.sameSite = parts[i].substring(9).trim();
    }
  }

  return cookie;
}

export async function handleScanCookies(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const siteId = body?.siteId;
  const cookies = body?.cookies || [];
  const pageUrl = body?.pageUrl || '';

  console.log('[ScanCookies] Received scan for siteId:', siteId, 'with', cookies, 'cookies detected from pageUrl:', pageUrl);

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

    // Add isExpected and source columns if they don't exist
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

    // Get site to verify it exists
    const site = await getSiteById(db, siteId);
    if (!site) {
      return Response.json({ success: false, error: 'Site not found' }, { status: 404 });
    }
    if (!requestDomainMatchesSite(site, request)) {
      return Response.json(
        { success: false, error: 'This script is not valid for this domain. It is licensed for the site it was issued to.', code: 'DOMAIN_MISMATCH' },
        { status: 403 }
      );
    }

    // Infer domain from pageUrl if not provided in cookies
    let inferredDomain = null;
    try {
      if (pageUrl) {
        const url = new URL(pageUrl);
        inferredDomain = url.hostname;
      }
    } catch (e) {
      // Invalid URL, ignore
    }

    // Find or create a scan history entry for client-side detection
    // Use a special scan history ID based on siteId and "client-detection"
    const scanHistoryId = `client-${siteId}-${Date.now()}`;
    
    // Check if we already have a recent client-side scan (within last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const existingScan = await db
      .prepare(
        'SELECT id FROM ScanHistory WHERE siteId = ?1 AND scanUrl LIKE ?2 AND createdAt > ?3 ORDER BY createdAt DESC LIMIT 1'
      )
      .bind(siteId, '%client-detection%', oneHourAgo)
      .first();

    let currentScanHistoryId = existingScan?.id || scanHistoryId;

    // Create scan history if it doesn't exist
    if (!existingScan) {
      await createScanHistory(db, {
        id: scanHistoryId,
        siteId: siteId,
        scanUrl: pageUrl || 'client-detection',
        scriptsFound: 0,
        cookiesFound: cookies.length,
        scanDuration: null,
        scanStatus: 'completed',
      });
      currentScanHistoryId = scanHistoryId;
    } else {
      // Update existing scan with new cookie count
      await db
        .prepare('UPDATE ScanHistory SET cookiesFound = ?1 WHERE id = ?2')
        .bind(cookies.length, currentScanHistoryId)
        .run();
    }

    // Process and store cookies
    let storedCount = 0;
    const now = new Date().toISOString();
    for (const cookieData of cookies) {
      try {
        // Parse cookie (handle both object format and string format)
        let parsedCookie;
        if (typeof cookieData === 'string') {
          parsedCookie = parseCookieFromDocumentCookie(cookieData);
        } else {
          parsedCookie = {
            name: cookieData.name || '',
            value: cookieData.value || '',
            domain: cookieData.domain || inferredDomain || null,
            path: cookieData.path || '/',
            expires: cookieData.expires || null,
            httpOnly: cookieData.httpOnly || false,
            secure: cookieData.secure || false,
            sameSite: cookieData.sameSite || null,
          };
        }

        if (!parsedCookie.name) {
          continue; // Skip invalid cookies
        }

        // Categorize cookie (auto + user-defined override)
        const autoProvider = getCookieProvider(parsedCookie.name, parsedCookie.domain);
        const autoCategory = categorizeCookie(parsedCookie.name, parsedCookie.domain, autoProvider);
        const rule = await getUserDefinedCookieRule(db, siteId, parsedCookie.name, parsedCookie.domain);
        const provider = String(rule?.provider || autoProvider || '').trim() || null;
        const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
        const description = String(rule?.description || '').trim() || null;
        const baseSource =
          typeof cookieData === 'string'
            ? 'document.cookie'
            : String(cookieData?.source || 'document.cookie');
        const source = rule ? `user-rule:${baseSource}` : baseSource;

        const cookiePayload = {
          siteId: siteId,
          scanHistoryId: currentScanHistoryId,
          now,
          cookie: {
            name: parsedCookie.name,
            domain: parsedCookie.domain,
            path: parsedCookie.path,
            category,
            provider,
            description,
            expires: parsedCookie.expires,
            httpOnly: parsedCookie.httpOnly,
            secure: parsedCookie.secure,
            sameSite: parsedCookie.sameSite,
            source,
            isExpected: false,
          },
        };
        // Log every field to find undefined (D1 rejects undefined)
        const flat = {
          siteId: cookiePayload.siteId,
          scanHistoryId: cookiePayload.scanHistoryId,
          now: cookiePayload.now,
          name: cookiePayload.cookie.name,
          domain: cookiePayload.cookie.domain,
          path: cookiePayload.cookie.path,
          category: cookiePayload.cookie.category,
          provider: cookiePayload.cookie.provider,
          description: cookiePayload.cookie.description,
          expires: cookiePayload.cookie.expires,
          httpOnly: cookiePayload.cookie.httpOnly,
          secure: cookiePayload.cookie.secure,
          sameSite: cookiePayload.cookie.sameSite,
        };
        for (const [k, val] of Object.entries(flat)) {
          if (val === undefined) console.error('[ScanCookies] undefined field:', k);
        }
        console.log('[ScanCookies] upsertCookie input:', JSON.stringify(flat));

        await upsertCookie(db, cookiePayload);

        storedCount++;
        console.log(
          '[ScanCookies] Storing actual cookie detected:',
          parsedCookie.name,
          'from',
          typeof cookieData === 'string' ? 'document.cookie' : cookieData.source || 'document.cookie'
        );
      } catch (error) {
        console.error('[ScanCookies] Failed to store cookie:', error, cookieData);
      }
    }

    return Response.json({ 
      success: true, 
      stored: storedCount,
      scanHistoryId: currentScanHistoryId 
    });
  } catch (error) {
    console.error('[ScanCookies] Error:', error);
    return Response.json(
      { success: false, error: error?.message || 'Failed to store cookies' },
      { status: 500 }
    );
  }
}
