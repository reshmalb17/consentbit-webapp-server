// handlers/scanSite.js
import puppeteer from '@cloudflare/puppeteer';
import {
  getSiteById,
  createScanHistory,
  upsertCookies,
  upsertScripts,
  getEffectivePlanForOrganization,
  getScanUsageForSite,
  incrementScanUsage,
} from '../services/db.js';
import {
  categorizeCookie,
  getCookieProvider,
  getCookiesByConsentState,
  generateExpectedCookiesFromScripts,
} from '../data/cookieDatabase.js';

/** Load all published CustomCookieRule rows for a site — called once per scan. */
async function loadCustomCookieRules(db, siteId) {
  if (!siteId) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT name, domain, scriptUrlPattern, category, description
         FROM CustomCookieRule
         WHERE siteId = ?1 AND published = 1`,
      )
      .bind(siteId)
      .all();
    return results || [];
  } catch {
    return []; // table may not exist yet on first scan
  }
}

/**
 * Find the best matching user-defined rule for a cookie by name + domain.
 * Checks CustomCookieRule first (new table), then legacy Cookie.isExpected=1.
 */
async function getUserDefinedCookieRule(db, siteId, name, domain, customRules) {
  if (!siteId || !name) return null;
  const nameLow = name.toLowerCase();
  const domLow = domain ? String(domain).trim().toLowerCase() : '';

  // 1. Check pre-loaded CustomCookieRule list (published rules)
  if (customRules && customRules.length > 0) {
    // Exact name + domain match
    const exact = customRules.find(
      (r) =>
        r.name.toLowerCase() === nameLow &&
        (r.domain || '').toLowerCase() === domLow,
    );
    if (exact) {
      return { category: exact.category, provider: exact.domain, description: exact.description };
    }
    // Name match with blank domain rule (wildcard)
    const wild = customRules.find(
      (r) => r.name.toLowerCase() === nameLow && !r.domain.trim(),
    );
    if (wild) {
      return { category: wild.category, provider: wild.domain || null, description: wild.description };
    }
  }

  // 2. Legacy fallback: Cookie table isExpected=1
  const exact = await db
    .prepare(
      `SELECT category, provider, description
       FROM Cookie
       WHERE siteId = ?1
         AND isExpected = 1
         AND lower(name) = lower(?2)
         AND lower(domain) = lower(?3)
       ORDER BY lastSeenAt DESC
       LIMIT 1`,
    )
    .bind(siteId, name, domLow)
    .first();
  if (exact) return exact;

  const fallback = await db
    .prepare(
      `SELECT category, provider, description
       FROM Cookie
       WHERE siteId = ?1
         AND isExpected = 1
         AND lower(name) = lower(?2)
         AND trim(domain) = ''
       ORDER BY lastSeenAt DESC
       LIMIT 1`,
    )
    .bind(siteId, name)
    .first();
  return fallback || null;
}

/**
 * Find a CustomCookieRule whose scriptUrlPattern matches the given script URL.
 * Returns the first matching rule or null.
 */
function findRuleByScriptUrl(scriptUrl, customRules) {
  if (!scriptUrl || !customRules || customRules.length === 0) return null;
  const urlLow = scriptUrl.toLowerCase();
  return (
    customRules.find((r) => {
      if (!r.scriptUrlPattern) return false;
      const pat = r.scriptUrlPattern.toLowerCase();
      // Support glob-style wildcard (*) or plain substring match
      if (pat.includes('*')) {
        const parts = pat.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = new RegExp(parts.join('.*'));
        return regex.test(urlLow);
      }
      return urlLow.includes(pat);
    }) || null
  );
}

function parseCookieString(cookieString) {
  const parts = cookieString.split(';').map((p) => p.trim());
  const firstPart = parts[0] || '';
  const eqIdx = firstPart.indexOf('=');
  const name = eqIdx >= 0 ? firstPart.slice(0, eqIdx).trim() : firstPart.trim();
  const value = eqIdx >= 0 ? firstPart.slice(eqIdx + 1) : '';

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Fetch timeout')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Full browser scan using Cloudflare Browser Rendering.
 * Returns ALL cookies from ALL domains (including third-party ad/tracking cookies),
 * all script URLs loaded by the page, and the page HTML.
 */
async function scanWithBrowser(browserBinding, scanUrl) {
  console.log('[ScanSite] scanWithBrowser starting for:', scanUrl);
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Disguise headless Chrome so ad networks don't block it
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const scriptUrls = new Set();
    page.on('request', (req) => {
      try {
        if (
          req.resourceType() === 'script' &&
          req.url().indexOf('consentbit') === -1 &&
          req.url().indexOf('client_data') === -1
        ) {
          scriptUrls.add(req.url());
        }
      } catch (_) {}
    });

    console.log('[ScanSite] navigating to:', scanUrl);
    await page.goto(scanUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[ScanSite] page loaded, waiting 8s for ad pixels to fire...');
    // Scroll to trigger lazy-loaded ad scripts, then wait again
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 8000));

    // Try CDP Network.getAllCookies first (gets third-party cookies too)
    // Fall back to page.cookies() if CDP is not supported
    let rawCookies = [];
    try {
      const client = await page.createCDPSession();
      const { cookies } = await client.send('Network.getAllCookies');
      rawCookies = cookies;
      console.log('[ScanSite] CDP getAllCookies got:', rawCookies.length, 'cookies');
    } catch (cdpErr) {
      console.warn('[ScanSite] CDP getAllCookies failed, falling back to page.cookies():', cdpErr.message);
      try {
        rawCookies = await page.cookies();
        console.log('[ScanSite] page.cookies() got:', rawCookies.length, 'cookies');
      } catch (e2) {
        console.error('[ScanSite] page.cookies() also failed:', e2.message);
      }
    }

    let html = '';
    let documentCookieStrings = [];
    try { html = await page.content(); } catch (_) {}
    try {
      const rawDocCookie = await page.evaluate(() => {
        try {
          return (typeof document !== 'undefined' && document.cookie) ? document.cookie : '';
        } catch (_) {
          return '';
        }
      });
      if (rawDocCookie) {
        documentCookieStrings = String(rawDocCookie)
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch (_) {}

    return {
      rawCookies: rawCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ? c.domain.replace(/^\./, '') : null,
        path: c.path || '/',
        expires: c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
        sameSite: c.sameSite || null,
      })),
      documentCookieStrings,
      scripts: [...scriptUrls],
      html,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function performBrowserScan(db, env, siteId, site, scanUrl, scanHistoryId, customRules) {
  const scanStartTime = Date.now();
  try {
    const browserResult = await scanWithBrowser(env.BROWSER, scanUrl);
    const cookies = [];
    const scripts = [];

    for (const s of browserResult.scripts) scripts.push(s);

    for (const raw of browserResult.rawCookies) {
      if (!raw.name) continue;
      const autoProvider = getCookieProvider(raw.name, raw.domain);
      const autoCategory = categorizeCookie(raw.name, raw.domain, autoProvider);
      // In-memory only — no per-cookie DB round-trips inside waitUntil
      const nameLow = raw.name.toLowerCase();
      const domLow = raw.domain ? String(raw.domain).trim().toLowerCase() : '';
      const rule = customRules.find(r =>
        r.name.toLowerCase() === nameLow && (r.domain || '').toLowerCase() === domLow
      ) || customRules.find(r =>
        r.name.toLowerCase() === nameLow && !r.domain?.trim()
      );
      const provider = String(rule?.provider || autoProvider || '').trim() || null;
      const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
      const description = String(rule?.description || '').trim() || null;
      const source = rule ? 'user-rule:browser' : 'browser';
      if (!cookies.find(c => c.name === raw.name && c.domain === raw.domain)) {
        cookies.push({ ...raw, provider, category, description, source, isExpected: false });
      }
    }

    // Merge first-party cookies visible in document.cookie (helps catch dynamic SDK cookies
    // that may not always appear in Network.getAllCookies).
    let inferredHost = '';
    try {
      inferredHost = new URL(scanUrl).hostname || '';
    } catch (_) {
      inferredHost = String(site?.domain || '').replace(/^https?:\/\//i, '').split('/')[0];
    }
    for (const cookieStr of (browserResult.documentCookieStrings || [])) {
      try {
        const parsed = parseCookieString(cookieStr);
        if (!parsed?.name) continue;
        const merged = {
          ...parsed,
          domain: parsed.domain || inferredHost || null,
          source: 'browser:document.cookie',
        };
        const autoProvider = getCookieProvider(merged.name, merged.domain);
        const autoCategory = categorizeCookie(merged.name, merged.domain, autoProvider);
        const nameLow = merged.name.toLowerCase();
        const domLow = merged.domain ? String(merged.domain).trim().toLowerCase() : '';
        const rule = customRules.find(r =>
          r.name.toLowerCase() === nameLow && (r.domain || '').toLowerCase() === domLow
        ) || customRules.find(r =>
          r.name.toLowerCase() === nameLow && !r.domain?.trim()
        );
        const provider = String(rule?.provider || autoProvider || '').trim() || null;
        const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
        const description = String(rule?.description || '').trim() || null;
        if (!cookies.find(c => c.name === merged.name && c.domain === merged.domain)) {
          cookies.push({ ...merged, provider, category, description, isExpected: false });
        }
      } catch (_) {}
    }

    // Infer additional cookies from detected scripts
    const inferredCookies = generateExpectedCookiesFromScripts([], scripts, site.domain || scanUrl);
    for (const ic of inferredCookies) {
      if (!cookies.find(c => c.name.toLowerCase() === ic.name.toLowerCase())) {
        cookies.push({
          name: ic.name, domain: ic.domain || null, path: ic.path || '/',
          expires: null, httpOnly: false, secure: false, sameSite: null,
          provider: ic.provider || null, category: ic.category || 'uncategorized',
          description: ic.description || null, source: 'script-inference', isExpected: false,
        });
      }
    }

    const scanDuration = Date.now() - scanStartTime;

    await upsertCookies(db, { siteId, scanHistoryId, cookies });
    await upsertScripts(db, { siteId, scripts: scripts.map(url => ({ url, category: 'uncategorized' })) });

    await db.prepare(
      `UPDATE ScanHistory SET cookiesFound = ?1, scriptsFound = ?2, scanDuration = ?3, scanStatus = 'completed' WHERE id = ?4`
    ).bind(cookies.length, scripts.length, scanDuration, scanHistoryId).run();

    console.log(`[ScanSite] Browser scan done: ${cookies.length} cookies, ${scripts.length} scripts`);
  } catch (err) {
    console.error('[ScanSite] performBrowserScan failed:', err);
    await db.prepare(`UPDATE ScanHistory SET scanStatus = 'failed' WHERE id = ?1`)
      .bind(scanHistoryId).run().catch(() => {});
  }
}

export async function handleScanSite(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body = null;

  try {
    body = await request.json();
  } catch (e) {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const siteId = body?.siteId;

  if (!siteId) {
    return Response.json(
      { success: false, error: 'siteId is required' },
      { status: 400 },
    );
  }

  try {
    // Get site information
    const site = await getSiteById(db, siteId);
    if (!site) {
      return Response.json(
        { success: false, error: 'Site not found' },
        { status: 404 },
      );
    }

    const organizationId = site.organizationId ?? site.organizationid ?? null;
    if (organizationId) {
      const { plan } = await getEffectivePlanForOrganization(db, organizationId, env);
      const scansLimit = plan ? (plan.scansIncluded ?? plan.scansincluded ?? 100) : 100;
      const scanUsage = await getScanUsageForSite(db, siteId);
      if (scanUsage.scanCount >= scansLimit) {
        return Response.json(
          {
            success: false,
            error: `Scan limit reached (${scansLimit} scans per month for this site). Upgrade your plan for more scans.`,
            code: 'SCAN_LIMIT_REACHED',
          },
          { status: 402 },
        );
      }
    }

    const customRules = await loadCustomCookieRules(db, siteId);
    const scanUrl = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;

    // When Browser Rendering is available, create a pending scan record, respond
    // immediately, and run the heavy browser scan in the background via ctx.waitUntil().
    if (env.BROWSER && ctx) {
      const { scanHistoryId } = await createScanHistory(db, {
        siteId,
        scanUrl,
        scriptsFound: 0,
        cookiesFound: 0,
        scanDuration: null,
        scanStatus: 'pending',
      });
      await incrementScanUsage(db, siteId);

      ctx.waitUntil(
        performBrowserScan(db, env, siteId, site, scanUrl, scanHistoryId, customRules)
          .catch(err => console.error('[ScanSite] Background browser scan failed:', err))
      );

      return Response.json({ success: true, scanHistoryId, scanning: true });
    }

    const scanStartTime = Date.now();

    // Browser-like headers to avoid bot detection
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
      'Referer': scanUrl, // Some sites check referrer
    };

    const cookies = [];
    const scripts = [];
    let html = '';

    if (env.BROWSER) {
      // ── Full browser scan (Cloudflare Browser Rendering) ──────────────────
      // Captures ALL cookies from ALL domains including third-party ad/tracking cookies.
      console.log('[ScanSite] Using Cloudflare Browser Rendering for full scan');
      const browserResult = await scanWithBrowser(env.BROWSER, scanUrl);
      html = browserResult.html;
      for (const s of browserResult.scripts) scripts.push(s);

      for (const raw of browserResult.rawCookies) {
        if (!raw.name) continue;
        const autoProvider = getCookieProvider(raw.name, raw.domain);
        const autoCategory = categorizeCookie(raw.name, raw.domain, autoProvider);
        const rule = await getUserDefinedCookieRule(db, siteId, raw.name, raw.domain, customRules);
        const provider = String(rule?.provider || autoProvider || '').trim() || null;
        const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
        const description = String(rule?.description || '').trim() || null;
        const source = rule ? 'user-rule:browser' : 'browser';
        if (!cookies.find(c => c.name === raw.name && c.domain === raw.domain)) {
          cookies.push({ ...raw, provider, category, description, source, isExpected: false });
        }
      }
    } else {
      // ── Fallback: fetch-based scan ─────────────────────────────────────────
      // Only captures first-party Set-Cookie response headers.
      console.log('[ScanSite] BROWSER binding not available, falling back to fetch scan');
      let setCookieHeaders = [];

      try {
        const headResponse = await fetchWithTimeout(scanUrl, { method: 'HEAD', headers: browserHeaders, redirect: 'follow' }, 10000);
        if (headResponse.ok) {
          const h = headResponse.headers.get('Set-Cookie');
          if (h) setCookieHeaders.push(h);
          setCookieHeaders.push(...(headResponse.headers.getSetCookie?.() || []));
        }
      } catch (headError) {
        console.log('[ScanSite] HEAD request failed, will try GET:', headError.message);
      }

      try {
        const response = await fetchWithTimeout(scanUrl, { method: 'GET', headers: browserHeaders, redirect: 'follow' }, 20000);
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html') || contentType.includes('text/plain')) {
          html = await response.text().catch(() => '');
        }
        const h = response.headers.get('Set-Cookie');
        if (h) setCookieHeaders.push(h);
        setCookieHeaders.push(...(response.headers.getSetCookie?.() || []));

        if (!response.ok && setCookieHeaders.length === 0 && !html) {
          if (response.status === 403) throw new Error(`Access denied (403): The website is blocking automated requests.`);
          if (response.status === 404) throw new Error(`Page not found (404): Please verify the domain is correct.`);
          if (response.status >= 500) throw new Error(`Server error (${response.status}): Please try again later.`);
          throw new Error(`Failed to fetch website: ${response.status} ${response.statusText}`);
        }
      } catch (fetchError) {
        if (setCookieHeaders.length === 0) {
          if (fetchError?.name === 'AbortError') throw new Error('Scan timed out. Verify the site is reachable.');
          throw fetchError;
        }
      }

      for (const cookieString of setCookieHeaders) {
        try {
          const parsed = parseCookieString(cookieString);
          const autoProvider = getCookieProvider(parsed.name, parsed.domain);
          const autoCategory = categorizeCookie(parsed.name, parsed.domain, autoProvider);
          const rule = await getUserDefinedCookieRule(db, siteId, parsed.name, parsed.domain, customRules);
          const provider = String(rule?.provider || autoProvider || '').trim() || null;
          const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
          const description = String(rule?.description || '').trim() || null;
          const source = rule ? 'user-rule:http-header' : 'http-header';
          cookies.push({ ...parsed, provider, category, description, source, isExpected: false });
        } catch (e) { console.error('[ScanSite] Failed to parse cookie:', e); }
      }

      // Extract cookies written via document.cookie in HTML source
      if (html) {
        const docCookieRegex = /document\.cookie\s*=\s*["']([^"']+)["']/gi;
        let m;
        while ((m = docCookieRegex.exec(html)) !== null) {
          try {
            const parsed = parseCookieString(m[1]);
            if (!cookies.find(c => c.name === parsed.name && c.domain === parsed.domain)) {
              const autoProvider = getCookieProvider(parsed.name, parsed.domain);
              const autoCategory = categorizeCookie(parsed.name, parsed.domain, autoProvider);
              const rule = await getUserDefinedCookieRule(db, siteId, parsed.name, parsed.domain, customRules);
              cookies.push({
                ...parsed,
                provider: String(rule?.provider || autoProvider || '').trim() || null,
                category: String(rule?.category || autoCategory || 'uncategorized').toLowerCase(),
                description: String(rule?.description || '').trim() || null,
                source: rule ? 'user-rule:javascript' : 'javascript',
                isExpected: false,
              });
            }
          } catch (e) { /* ignore */ }
        }

        // Extract script tags
        const scriptRegex = /<script[^>]*src=["']([^"']+)["'][^>]*>/gi;
        let sm;
        while ((sm = scriptRegex.exec(html)) !== null) scripts.push(sm[1]);
      }
    }

    // Categorize scripts
    function categorizeScript(src) {
      try {
        const u = new URL(src);
        const host = u.hostname;

        if (
          host.includes('google-analytics.com') ||
          src.includes('gtag/js') ||
          host.includes('googletagmanager.com')
        ) {
          return 'analytics';
        }
        if (
          host.includes('facebook.com') ||
          host.includes('fbcdn.net') ||
          host.includes('doubleclick.net') ||
          host.includes('ads.')
        ) {
          return 'marketing';
        }
        if (
          host.includes('hotjar.com') ||
          host.includes('intercom.io') ||
          host.includes('fullstory.com')
        ) {
          return 'behavioral';
        }
        return 'uncategorized';
      } catch (e) {
        return 'uncategorized';
      }
    }

    // Create scan history using db.js function
    const scanDuration = Date.now() - scanStartTime;
    const { scanHistoryId } = await createScanHistory(db, {
      siteId,
      scanUrl,
      scriptsFound: scripts.length,
      cookiesFound: cookies.length,
      scanDuration,
    });
    await incrementScanUsage(db, siteId);

    // Store cookies using db.js function
    await upsertCookies(db, {
      siteId,
      scanHistoryId,
      cookies,
    });

    // Store scripts and extract measurement IDs
    const detectedMeasurementIds = [];
    
    // Extract measurement IDs from HTML content (more comprehensive than just URLs)
    if (html) {
      // GA4: gtag('config', 'G-XXXXXXX') or gtag('js', new Date()); gtag('config', 'G-XXXXXXX')
      const ga4ConfigMatches = html.match(/gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]/gi);
      if (ga4ConfigMatches) {
        for (const match of ga4ConfigMatches) {
          const idMatch = match.match(/(G-[A-Z0-9]+)/i);
          if (idMatch && !detectedMeasurementIds.find(m => m.type === 'ga4' && m.id === idMatch[1])) {
            detectedMeasurementIds.push({ type: 'ga4', id: idMatch[1] });
          }
        }
      }
      
      // Universal Analytics: ga('create', 'UA-XXXXXXX-X', 'auto')
      const uaMatches = html.match(/ga\s*\(\s*['"]create['"]\s*,\s*['"](UA-\d+-\d+)['"]/gi);
      if (uaMatches) {
        for (const match of uaMatches) {
          const idMatch = match.match(/(UA-\d+-\d+)/i);
          if (idMatch && !detectedMeasurementIds.find(m => m.type === 'ua' && m.id === idMatch[1])) {
            detectedMeasurementIds.push({ type: 'ua', id: idMatch[1] });
          }
        }
      }
      
      // Google Tag Manager: dataLayer.push({'gtm.start': ...}) or gtm.js?id=GTM-XXXXXXX
      const gtmMatches = html.match(/gtm\.js[?&]id=(GTM-[A-Z0-9]+)/gi);
      if (gtmMatches) {
        for (const match of gtmMatches) {
          const idMatch = match.match(/(GTM-[A-Z0-9]+)/i);
          if (idMatch && !detectedMeasurementIds.find(m => m.type === 'gtm' && m.id === idMatch[1])) {
            detectedMeasurementIds.push({ type: 'gtm', id: idMatch[1] });
          }
        }
      }
    }

    // Infer cookies from detected scripts and measurement IDs
    const inferredCookies = generateExpectedCookiesFromScripts(
      detectedMeasurementIds,
      scripts,
      site.domain || scanUrl,
    );
    for (const ic of inferredCookies) {
      const alreadySeen = cookies.find(
        (c) => c.name.toLowerCase() === ic.name.toLowerCase(),
      );
      if (!alreadySeen) {
        cookies.push({
          name: ic.name,
          domain: ic.domain || null,
          path: ic.path || '/',
          expires: null,
          httpOnly: false,
          secure: false,
          sameSite: null,
          provider: ic.provider || null,
          category: ic.category || 'uncategorized',
          description: ic.description || null,
          source: 'script-inference',
          // Inferred cookies should be shown as real findings (no "[Expected]" prefix in UI).
          isExpected: false,
        });
      }
    }

    for (const scriptUrl of scripts) {
      // If this script URL matches a user-defined rule's pattern, create a synthetic
      // cookie entry for that rule so it appears in the scanned cookie list.
      const scriptRule = findRuleByScriptUrl(scriptUrl, customRules);
      if (scriptRule) {
        const alreadyAdded = cookies.find(
          (c) => c.name === scriptRule.name && (c.domain || '') === (scriptRule.domain || ''),
        );
        if (!alreadyAdded) {
          cookies.push({
            name: scriptRule.name,
            domain: scriptRule.domain || null,
            path: '/',
            expires: scriptRule.duration || null,
            httpOnly: false,
            secure: false,
            sameSite: null,
            provider: scriptRule.domain || null,
            category: scriptRule.category,
            description: scriptRule.description || null,
            source: `user-rule:script-pattern`,
            isExpected: false,
          });
        }
      }

      // Extract measurement IDs from script URLs (as fallback)
      try {
        // Google Tag Manager / GA4: gtag/js?id=G-XXXXXXX
        const ga4Match = scriptUrl.match(/gtag\/js[?&]id=(G-[A-Z0-9]+)/i);
        if (ga4Match && !detectedMeasurementIds.find(m => m.type === 'ga4' && m.id === ga4Match[1])) {
          detectedMeasurementIds.push({ type: 'ga4', id: ga4Match[1] });
        }
        
        // Google Tag Manager: gtm.js?id=GTM-XXXXXXX
        const gtmMatch = scriptUrl.match(/gtm\.js[?&]id=(GTM-[A-Z0-9]+)/i);
        if (gtmMatch && !detectedMeasurementIds.find(m => m.type === 'gtm' && m.id === gtmMatch[1])) {
          detectedMeasurementIds.push({ type: 'gtm', id: gtmMatch[1] });
        }
        
        // Universal Analytics: analytics.js
        if (scriptUrl.includes('google-analytics.com/analytics.js') && !detectedMeasurementIds.find(m => m.type === 'ua')) {
          detectedMeasurementIds.push({ type: 'ua', id: 'UA' });
        }
      } catch (e) {
        // Ignore URL parsing errors
      }
    }
    
    // Store scripts using db.js function
    await upsertScripts(db, {
      siteId,
      scripts: scripts.map(url => ({ url, category: categorizeScript(url) })),
    });
    
    // Calculate cookies by consent state
    const cookiesByConsent = getCookiesByConsentState(cookies, {
      analytics: true,
      marketing: true,
      behavioral: true,
      functional: true,
    });

    return Response.json({
      success: true,
      scanHistoryId,
      scriptsFound: scripts.length,
      cookiesFound: cookies.length,
      cookiesByConsent: {
        necessary: cookiesByConsent.necessary.length,
        ifAccepted: cookiesByConsent.ifAccepted.length,
        ifRejected: cookiesByConsent.ifRejected.length,
        ifPreferences: cookiesByConsent.ifPreferences.length,
      },
      scanDuration,
    });
  } catch (err) {
    console.error('[ScanSite] Error:', err);
    return Response.json(
      {
        success: false,
        error: err?.message || 'Failed to scan site',
      },
      { status: 500 },
    );
  }
}
