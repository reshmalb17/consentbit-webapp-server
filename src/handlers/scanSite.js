// handlers/scanSite.js
import { 
  getSiteById, 
  createScanHistory, 
  upsertCookies, 
  upsertScripts 
} from '../services/db.js';
import { 
  categorizeCookie, 
  getCookieProvider, 
  getCookiesByConsentState
} from '../data/cookieDatabase.js';

function parseCookieString(cookieString) {
  const parts = cookieString.split(';').map((p) => p.trim());
  const nameValue = parts[0].split('=');
  const name = nameValue[0];
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

export async function handleScanSite(request, env) {
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

    const scanUrl = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
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

    let response;
    let html = '';
    let setCookieHeaders = [];

    // Strategy 1: Try HEAD request first (less likely to trigger bot protection)
    try {
      const headResponse = await fetch(scanUrl, {
        method: 'HEAD',
        headers: browserHeaders,
        redirect: 'follow',
      });

      if (headResponse.ok) {
        // Extract cookies from HEAD response
        const setCookieHeader = headResponse.headers.get('Set-Cookie');
        if (setCookieHeader) {
          setCookieHeaders.push(setCookieHeader);
        }
        // Get all Set-Cookie headers (some servers send multiple)
        const allSetCookies = headResponse.headers.getSetCookie?.() || [];
        if (allSetCookies.length > 0) {
          setCookieHeaders.push(...allSetCookies);
        }
      }
    } catch (headError) {
      console.log('[ScanSite] HEAD request failed, will try GET:', headError.message);
    }

    // Strategy 2: Try GET request to get full HTML and scripts
    try {
      response = await fetch(scanUrl, {
        method: 'GET',
        headers: browserHeaders,
        redirect: 'follow',
      });

      // Try to read response body even if status is not OK (some sites return HTML with 403)
      const contentType = response.headers.get('content-type') || '';
      const mightHaveHtml = contentType.includes('text/html') || contentType.includes('text/plain');
      
      if (mightHaveHtml) {
        try {
          html = await response.text();
        } catch (e) {
          console.log('[ScanSite] Failed to read response body:', e.message);
          html = '';
        }
      }

      // Extract cookies from GET response headers (even if status is not OK)
      const setCookieHeader = response.headers.get('Set-Cookie');
      if (setCookieHeader) {
        setCookieHeaders.push(setCookieHeader);
      }
      // Get all Set-Cookie headers
      const allSetCookies = response.headers.getSetCookie?.() || [];
      if (allSetCookies.length > 0) {
        setCookieHeaders.push(...allSetCookies);
      }

      // Only throw error if we have no data at all (no cookies, no HTML)
      if (!response.ok && setCookieHeaders.length === 0 && !html) {
        // Provide more helpful error messages
        if (response.status === 403) {
          throw new Error(`Access denied (403): The website is blocking automated requests. This may be due to security settings, bot protection (like Cloudflare), or IP blocking. Tip: Cookies can also be detected automatically by the ConsentBit script already installed on your site.`);
        } else if (response.status === 404) {
          throw new Error(`Page not found (404): The website URL may be incorrect or the page doesn't exist. Please verify the domain is correct.`);
        } else if (response.status >= 500) {
          throw new Error(`Server error (${response.status}): The website server is experiencing issues. Please try again later.`);
        } else {
          throw new Error(`Failed to fetch website: ${response.status} ${response.statusText}`);
        }
      }

      // Log if we're proceeding with partial data
      if (!response.ok && (setCookieHeaders.length > 0 || html)) {
        console.log(`[ScanSite] Got ${response.status} but proceeding with partial scan (cookies: ${setCookieHeaders.length}, HTML: ${html ? 'yes' : 'no'})`);
      }
    } catch (fetchError) {
      // If we have cookies from HEAD, proceed with partial scan
      if (setCookieHeaders.length > 0) {
        console.log('[ScanSite] GET failed but we have cookies from HEAD, proceeding with partial scan');
        html = '';
      } else {
        // Re-throw the error if we have no data
        throw fetchError;
      }
    }
    const cookies = [];
    const scripts = [];

    // Extract cookies from Set-Cookie headers (collected from HEAD or GET)
    for (const cookieString of setCookieHeaders) {
      try {
        const parsed = parseCookieString(cookieString);
        const provider = getCookieProvider(parsed.name, parsed.domain);
        const category = categorizeCookie(parsed.name, parsed.domain, provider);

        cookies.push({
          ...parsed,
          provider,
          category,
          source: 'http-header', // Mark as from HTTP header
          isExpected: false, // Actual cookie found
        });
      } catch (e) {
        console.error('[ScanSite] Failed to parse cookie:', e);
      }
    }

    // Extract cookies from HTML content (document.cookie patterns, script tags)
    if (html) {
      // Extract cookies from document.cookie patterns in scripts
      // Pattern: document.cookie = "name=value; path=/; domain=.example.com"
      const documentCookieRegex = /document\.cookie\s*=\s*["']([^"']+)["']/gi;
      let docCookieMatch;
      while ((docCookieMatch = documentCookieRegex.exec(html)) !== null) {
        try {
          const cookieStr = docCookieMatch[1];
          const parsed = parseCookieString(cookieStr);
          const provider = getCookieProvider(parsed.name, parsed.domain);
          const category = categorizeCookie(parsed.name, parsed.domain, provider);
          
          // Avoid duplicates
          if (!cookies.find(c => c.name === parsed.name && c.domain === parsed.domain)) {
            cookies.push({
              ...parsed,
              provider,
              category,
              source: 'javascript', // Mark as from JavaScript
              isExpected: false, // Actual cookie found
            });
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }

      // Extract cookies from meta tags (some sites use meta tags for cookies)
      const metaCookieRegex = /<meta[^>]*name=["']cookie["'][^>]*content=["']([^"']+)["']/gi;
      let metaMatch;
      while ((metaMatch = metaCookieRegex.exec(html)) !== null) {
        try {
          const cookieStr = metaMatch[1];
          const parsed = parseCookieString(cookieStr);
          const provider = getCookieProvider(parsed.name, parsed.domain);
          const category = categorizeCookie(parsed.name, parsed.domain, provider);
          
          if (!cookies.find(c => c.name === parsed.name && c.domain === parsed.domain)) {
            cookies.push({
              ...parsed,
              provider,
              category,
              source: 'meta-tag',
              isExpected: false, // Actual cookie found
            });
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }

      // Extract scripts from HTML
      const scriptRegex = /<script[^>]*src=["']([^"']+)["'][^>]*>/gi;
      let match;
      while ((match = scriptRegex.exec(html)) !== null) {
        scripts.push(match[1]);
      }

      // Also extract inline scripts that might set cookies
      const inlineScriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      let inlineMatch;
      while ((inlineMatch = inlineScriptRegex.exec(html)) !== null) {
        const scriptContent = inlineMatch[1];
        // Check for document.cookie in inline scripts
        const inlineCookieRegex = /document\.cookie\s*=\s*["']([^"']+)["']/gi;
        let inlineCookieMatch;
        while ((inlineCookieMatch = inlineCookieRegex.exec(scriptContent)) !== null) {
          try {
            const cookieStr = inlineCookieMatch[1];
            const parsed = parseCookieString(cookieStr);
            const provider = getCookieProvider(parsed.name, parsed.domain);
            const category = categorizeCookie(parsed.name, parsed.domain, provider);
            
            if (!cookies.find(c => c.name === parsed.name && c.domain === parsed.domain)) {
            cookies.push({
              ...parsed,
              provider,
              category,
              source: 'inline-script',
              isExpected: false, // Actual cookie found
            });
            }
          } catch (e) {
            // Ignore parsing errors
          }
        }
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
    
    for (const scriptUrl of scripts) {
      const scriptId = crypto.randomUUID();
      const category = categorizeScript(scriptUrl);
      
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
