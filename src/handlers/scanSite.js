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
  markSiteVerified,
} from '../services/db.js';
import { captureInstallationVerified, capturePostHogEvent } from '../services/posthog.js';
import {
  categorizeCookie,
  getCookieProvider,
  getCookiesByConsentState,
} from '../data/cookieDatabase.js';
import {
  loadPublishedCustomCookieRules,
  resolveUserDefinedCookieRule,
  matchPublishedCustomRule,
  hostHintsFromSiteDomain,
} from '../utils/customCookieRules.js';
import { SCRIPT_BLOCK_PROVIDERS } from '../data/scriptBlockProviders.js';

function categorizeScriptByProviders(url) {
  try {
    for (const { pattern, categories } of SCRIPT_BLOCK_PROVIDERS) {
      if (new RegExp(pattern, 'i').test(url)) {
        return categories[0];
      }
    }
  } catch (_) {}
  return null;
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
// Click the cookie-banner "Accept all" button so consent-gated tags (GA, Meta,
// Clarity, PostHog, Amplitude, etc.) actually load and drop their cookies. Puppeteer
// has no :has-text() selector, so matching is done in-page: try the known CMP CSS
// selectors first (passed from the cmps table), then fall back to button/link text.
async function tryAcceptConsent(page, cssSelectors) {
  try {
    return await page.evaluate((selectors) => {
      // ConsentBit (and many CMPs) render the banner inside an OPEN shadow root, which
      // document.querySelector does not pierce. Walk the whole tree including shadow roots.
      const allElements = () => {
        const out = [];
        const walk = (root) => {
          let nodes;
          try { nodes = root.querySelectorAll('*'); } catch (_) { return; }
          for (const n of nodes) {
            out.push(n);
            if (n.shadowRoot) walk(n.shadowRoot);
          }
        };
        walk(document);
        return out;
      };
      const els = allElements();
      const clickIfVisible = (el) => {
        if (!el) return false;
        try { el.click(); return true; } catch (_) { return false; }
      };
      // Match ONLY ConsentBit's own accept-all button ids, across shadow DOM.
      for (const sel of selectors) {
        for (const el of els) {
          let m = false;
          try { m = el.matches(sel); } catch (_) { m = false; }
          if (m && clickIfVisible(el)) return `selector:${sel}`;
        }
      }
      return null;
    }, cssSelectors);
  } catch (_) {
    return null;
  }
}

async function scanWithBrowser(browserBinding, scanUrl, options = {}) {
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

    // For a consented scan we click the banner's "Accept" — which also fires ConsentBit's
    // consent-logging POST. Intercept requests so we can ABORT that POST: the accept still
    // unblocks the tags (cookie detection works), but the scan never writes a fake
    // "Accepted" row into the site's consent logs.
    const CONSENT_POST_RE = /\/api\/consent(?:[/?#]|$)|\/cmp\/consent/i;
    if (options.acceptConsent) {
      try { await page.setRequestInterception(true); } catch (_) { /* interception unsupported — proceed */ }
    }

    const scriptUrls = new Set();
    page.on('request', (req) => {
      try {
        const u = req.url();
        if (
          req.resourceType() === 'script' &&
          u.indexOf('consentbit') === -1 &&
          u.indexOf('client_data') === -1
        ) {
          scriptUrls.add(u);
        }
        // When interception is on (consented scan) every request MUST be resolved.
        if (options.acceptConsent) {
          if (req.method() === 'POST' && CONSENT_POST_RE.test(u)) {
            req.abort().catch(() => {});
          } else {
            req.continue().catch(() => {});
          }
        }
      } catch (_) {
        try { if (options.acceptConsent) req.continue(); } catch (_) {}
      }
    });

    // Use domcontentloaded (NOT networkidle2): tracking-heavy sites beacon continuously,
    // so the network never goes idle and networkidle2 waits the full timeout — which, with
    // the accept + reload + settle waits below, pushes the whole scan past the Worker
    // waitUntil budget (the background task gets cancelled and the scan never completes).
    // The fixed settle wait below gives the page time to load its scripts.
    await page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Scroll to trigger lazy-loaded ad scripts, then wait again
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } catch (_) {}
    await new Promise((r) => setTimeout(r, options.acceptConsent ? 3000 : 8000));

    // Read the cookie jar at the current moment: CDP Network.getAllCookies (captures
    // third-party cookies too) with a page.cookies() fallback, plus document.cookie.
    const readJar = async () => {
      let raw = [];
      try {
        const client = await page.createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        raw = cookies;
      } catch (cdpErr) {
        console.warn('[ScanSite] CDP getAllCookies failed, falling back to page.cookies():', cdpErr.message);
        try { raw = await page.cookies(); } catch (e2) { console.error('[ScanSite] page.cookies() also failed:', e2.message); }
      }
      let docStrings = [];
      try {
        const rawDocCookie = await page.evaluate(() => {
          try { return (typeof document !== 'undefined' && document.cookie) ? document.cookie : ''; }
          catch (_) { return ''; }
        });
        if (rawDocCookie) docStrings = String(rawDocCookie).split(';').map((s) => s.trim()).filter(Boolean);
      } catch (_) {}
      return {
        rawCookies: raw.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain ? c.domain.replace(/^\./, '') : null,
          path: c.path || '/',
          expires: c.expires && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          sameSite: c.sameSite || null,
        })),
        documentCookieStrings: docStrings,
      };
    };

    // Two-phase for consented scans: capture the jar BEFORE accepting (pre-consent),
    // then click "Accept all" so gated tags fire, wait, and capture again (post-consent).
    // Non-consent scans just read the jar once.
    let preJar = null;
    let consentClicked = null;
    if (options.acceptConsent) {
      preJar = await readJar();
      consentClicked = await tryAcceptConsent(page, options.acceptSelectors || []);
      console.log('[ScanSite] consent accept attempt:', consentClicked || 'no button found');
      if (consentClicked) {
        // Let the consent choice persist (cookie/localStorage), then RELOAD so the now-
        // unblocked tags initialise from the start of a fresh pageview and drop their
        // cookies — clicking Accept mid-page usually doesn't retro-load blocked scripts.
        await new Promise((r) => setTimeout(r, 2000));
        // Use domcontentloaded (NOT networkidle2): once tags fire they beacon continuously,
        // so the network never goes idle and networkidle2 would hang until timeout.
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (_) {}
        try { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } catch (_) {}
        await new Promise((r) => setTimeout(r, 6000));
      }
    }

    const postJar = await readJar();
    let html = '';
    try { html = await page.content(); } catch (_) {}

    return {
      rawCookies: postJar.rawCookies,
      documentCookieStrings: postJar.documentCookieStrings,
      preRawCookies: preJar ? preJar.rawCookies : [],
      preDocumentCookieStrings: preJar ? preJar.documentCookieStrings : [],
      scripts: [...scriptUrls],
      html,
      consentClicked,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Load the "Accept all" CSS selectors from the shared cookie-scanner DB (cmps table),
// with the ConsentBit selector first. Best-effort — the in-page text fallback covers misses.
// Scanned sites always run the ConsentBit banner, so match ONLY its own accept-all
// button ids (from consent.js) — no generic multi-CMP guessing.
function loadAcceptSelectors() {
  return [
    '#cb-accept-all-btn',              // GDPR "Accept all"
    '#consebit-ccpa-prefrence-accept', // CCPA preference accept
  ];
}

async function performBrowserScan(db, env, siteId, site, scanUrl, scanHistoryId, customRules, options = {}) {
  const scanStartTime = Date.now();
  const siteHints = hostHintsFromSiteDomain(site?.domain ?? site?.DOMAIN ?? '');
  try {
    const scanOptions = { ...options };
    if (options.acceptConsent) scanOptions.acceptSelectors = loadAcceptSelectors();
    const browserResult = await scanWithBrowser(env.BROWSER, scanUrl, scanOptions);
    const cookies = [];
    const scripts = [];

    for (const s of browserResult.scripts) scripts.push(s);

    // Two-phase consented scans: build the set of cookie keys that existed BEFORE the
    // banner was accepted, so each stored cookie can be tagged pre-consent vs post-consent
    // via its `source`. A tracking cookie tagged pre-consent = a compliance red flag.
    const keyOf = (n, d) => `${String(n).toLowerCase()}|${String(d || '').replace(/^\./, '').toLowerCase()}`;
    const preConsentKeys = new Set();
    if (options.acceptConsent) {
      for (const c of (browserResult.preRawCookies || [])) if (c?.name) preConsentKeys.add(keyOf(c.name, c.domain));
      for (const s of (browserResult.preDocumentCookieStrings || [])) {
        try { const p = parseCookieString(s); if (p?.name) preConsentKeys.add(keyOf(p.name, p.domain)); } catch (_) {}
      }
    }
    const phaseSource = (name, domain, base) =>
      options.acceptConsent
        ? `${base}:${preConsentKeys.has(keyOf(name, domain)) ? 'pre-consent' : 'post-consent'}`
        : base;

    for (const raw of browserResult.rawCookies) {
      if (!raw.name) continue;
      const autoProvider = getCookieProvider(raw.name, raw.domain);
      const autoCategory = categorizeCookie(raw.name, raw.domain, autoProvider);
      // In-memory only — no per-cookie DB round-trips inside waitUntil
      const rule = matchPublishedCustomRule(customRules, raw.name, raw.domain, siteHints);
      const provider = String(rule?.provider || autoProvider || '').trim() || null;
      const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
      const description = String(rule?.description || '').trim() || null;
      const source = phaseSource(raw.name, raw.domain, rule ? 'user-rule:browser' : 'browser');
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
          source: phaseSource(parsed.name, parsed.domain || inferredHost, 'browser:document.cookie'),
        };
        const autoProvider = getCookieProvider(merged.name, merged.domain);
        const autoCategory = categorizeCookie(merged.name, merged.domain, autoProvider);
        const rule = matchPublishedCustomRule(customRules, merged.name, merged.domain, siteHints);
        const provider = String(rule?.provider || autoProvider || '').trim() || null;
        const category = String(rule?.category || autoCategory || 'uncategorized').toLowerCase();
        const description = String(rule?.description || '').trim() || null;
        if (!cookies.find(c => c.name === merged.name && c.domain === merged.domain)) {
          cookies.push({ ...merged, provider, category, description, isExpected: false });
        }
      } catch (_) {}
    }

    const scanDuration = Date.now() - scanStartTime;

    // Only count and store scripts matching known tracking tool patterns
    const trackingScripts = scripts
      .map(url => ({ url, category: categorizeScriptByProviders(url) }))
      .filter(s => s.category !== null);

    await upsertCookies(db, { siteId, scanHistoryId, cookies });
    await upsertScripts(db, { siteId, scripts: trackingScripts });

    const categoriesJson = JSON.stringify(
      [...new Set(cookies.map((c) => String(c.category || 'uncategorized').toLowerCase()).filter(Boolean))].sort()
    );
    await db.prepare(
      `UPDATE ScanHistory SET cookiesFound = ?1, scriptsFound = ?2, scanDuration = ?3, scanStatus = 'completed', categories = ?5 WHERE id = ?4`
    ).bind(cookies.length, trackingScripts.length, scanDuration, scanHistoryId, categoriesJson).run();

  } catch (err) {
    console.error('[ScanSite] performBrowserScan failed:', err);
    console.error('[ScanSite] performBrowserScan error:', err?.message || err);
    await db.prepare(`UPDATE ScanHistory SET scanStatus = 'failed' WHERE id = ?1`)
      .bind(scanHistoryId).run().catch(() => {});
  }
}

// Same contract as handleScanSite but accepts the cookie banner during the scan so
// consent-gated tags fire and their cookies are captured. Wired to a separate route
// (/api/scan-site-consented) so the existing /api/scan-site is unchanged.
export async function handleScanSiteConsented(request, env, ctx) {
  return handleScanSite(request, env, ctx, { acceptConsent: true, userInitiated: true });
}

export async function handleScanSite(request, env, ctx, options = {}) {
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

    // cookie_scan_started — only for a user-initiated Webflow scan (skip background
    // cron scans and non-Webflow platforms).
    console.log(`[PostHog DEBUG] cookie_scan_started guard: siteId=${siteId} userInitiated=${!!options.userInitiated} platform=${site.platform ?? site.PLATFORM ?? 'NONE'}`);
    if (options.userInitiated && String(site.platform ?? site.PLATFORM ?? '').toLowerCase() === 'webflow') {
      try {
        const ownerRow = await db.prepare(
          `SELECT u.email AS email FROM Site s
             JOIN OrganizationMember om ON om.organizationId = s.organizationId
             JOIN User u ON u.id = om.userId WHERE s.id = ?1 LIMIT 1`
        ).bind(siteId).first();
        if (ownerRow?.email) {
          await capturePostHogEvent(env, ownerRow.email, 'cookie_scan_started', {
            domain_url: site.domain ?? site.DOMAIN ?? null,
            platform: 'webflow',
            site_id: siteId,
          });
        }
      } catch { /* analytics only */ }
    }

    // Only allow scanning if the ConsentBit script has been verified on the site.
    const isVerified = site.verified === 1 || site.verified === true || site.VERIFIED === 1;
    const isWebappMigrated = !!(site.platformSiteId ?? site.platformsiteid);

    if (!isVerified) {
      if (isWebappMigrated) {
        const domain = site.domain ?? site.DOMAIN ?? '';
        const cdnScriptId = site.cdnScriptId ?? site.cdnscriptid ?? '';

        // If the site has a cdnScriptId it was registered via the Webflow API — trust it.
        // The HTML check is unreliable for staging domains (Webflow returns a 2KB placeholder).
        if (cdnScriptId) {
          try { await markSiteVerified(db, siteId); } catch { /* best-effort */ }
          // First-time detection (we are inside `!isVerified`) — fire installation_verified.
          try { await captureInstallationVerified(env, db, siteId, domain); } catch { /* analytics only */ }
        } else {
          // No cdnScriptId — fall back to HTML check
          let scriptFound = false;
          try {
            const url = domain.startsWith('http') ? domain : `https://${domain}`;
            const resp = await fetch(url, {
              redirect: 'follow',
              signal: AbortSignal.timeout(10000),
              headers: { 'User-Agent': 'ConsentBit-ScriptChecker/1.0' },
            });
            if (resp.ok) {
              const html = await resp.text();
              const lower = html.toLowerCase();
              if (lower.includes('consentbit') || lower.includes('/consentbit/') || lower.includes('/cdn/runtime/')) {
                scriptFound = true;
                try { await markSiteVerified(db, siteId); } catch { /* best-effort */ }
                // First-time detection (we are inside `!isVerified`) — fire installation_verified.
                try { await captureInstallationVerified(env, db, siteId, domain); } catch { /* analytics only */ }
              }
            }
          } catch (fetchErr) {
            console.error(`[ScanSite] verification fetch failed domain=${domain}:`, fetchErr?.message);
          }

          if (!scriptFound) {
            console.warn(`[ScanSite] SITE_NOT_VERIFIED siteId=${siteId} domain=${domain}`);
            return Response.json(
              {
                success: false,
                error: 'ConsentBit script not detected on your site. Please ensure the script is installed and your site is published.',
                code: 'SITE_NOT_VERIFIED',
              },
              { status: 403 },
            );
          }
        }
      } else {
        console.warn(`[ScanSite] SITE_NOT_VERIFIED (not migrated) siteId=${siteId}`);
        return Response.json(
          {
            success: false,
            error: 'Site not verified. Please install the ConsentBit script on your site before scanning.',
            code: 'SITE_NOT_VERIFIED',
          },
          { status: 403 },
        );
      }
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

    const customRules = await loadPublishedCustomCookieRules(db, siteId);
    const siteHints = hostHintsFromSiteDomain(site?.domain ?? site?.DOMAIN ?? '');
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
        performBrowserScan(db, env, siteId, site, scanUrl, scanHistoryId, customRules, options)
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
      const scanOptions = { ...options };
      if (options.acceptConsent) scanOptions.acceptSelectors = loadAcceptSelectors();
      const browserResult = await scanWithBrowser(env.BROWSER, scanUrl, scanOptions);
      html = browserResult.html;
      for (const s of browserResult.scripts) scripts.push(s);

      for (const raw of browserResult.rawCookies) {
        if (!raw.name) continue;
        const autoProvider = getCookieProvider(raw.name, raw.domain);
        const autoCategory = categorizeCookie(raw.name, raw.domain, autoProvider);
        const rule = await resolveUserDefinedCookieRule(db, siteId, raw.name, raw.domain, customRules, siteHints);
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
      let setCookieHeaders = [];

      try {
        const headResponse = await fetchWithTimeout(scanUrl, { method: 'HEAD', headers: browserHeaders, redirect: 'follow' }, 10000);
        if (headResponse.ok) {
          const h = headResponse.headers.get('Set-Cookie');
          if (h) setCookieHeaders.push(h);
          setCookieHeaders.push(...(headResponse.headers.getSetCookie?.() || []));
        }
      } catch (headError) {
        // HEAD request failed, will try GET
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
          const rule = await resolveUserDefinedCookieRule(db, siteId, parsed.name, parsed.domain, customRules, siteHints);
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
              const rule = await resolveUserDefinedCookieRule(db, siteId, parsed.name, parsed.domain, customRules, siteHints);
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

    // Only count and store scripts matching known tracking tool patterns
    const trackingScripts = scripts
      .map(url => ({ url, category: categorizeScriptByProviders(url) }))
      .filter(s => s.category !== null);

    // Create scan history using db.js function
    const scanDuration = Date.now() - scanStartTime;
    const { scanHistoryId } = await createScanHistory(db, {
      siteId,
      scanUrl,
      scriptsFound: trackingScripts.length,
      cookiesFound: cookies.length,
      scanDuration,
    });
    await incrementScanUsage(db, siteId);

    // Store only real detected cookies — no inference or script-pattern phantoms
    await upsertCookies(db, { siteId, scanHistoryId, cookies });

    await upsertScripts(db, { siteId, scripts: trackingScripts });

    // Persist accurate counts and categories snapshot
    const categoriesSnapshot = JSON.stringify(
      [...new Set(cookies.map((c) => String(c.category || 'uncategorized').toLowerCase()).filter(Boolean))].sort()
    );
    await db.prepare(`UPDATE ScanHistory SET cookiesFound = ?1, scriptsFound = ?2, categories = ?3 WHERE id = ?4`)
      .bind(cookies.length, trackingScripts.length, categoriesSnapshot, scanHistoryId).run();

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
      scriptsFound: trackingScripts.length,
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
