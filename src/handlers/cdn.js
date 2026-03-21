// handlers/cdn.js
import { getBannerCustomization } from '../services/db.js';
import { mergeTranslations } from '../data/defaultTranslations.js';

export async function handleCDNScript(request, env, url) {
  const parts = url.pathname.split('/');
  // Extract script ID:
  // - /client_data/{cdnScriptId}/script.js -> {cdnScriptId}
  // - /consentbit/{cdnScriptId}/script.js  -> {cdnScriptId}
  // - /client_data/{cdnScriptId}           -> {cdnScriptId}
  // - /consentbit/{cdnScriptId}            -> {cdnScriptId}
  let cdnScriptId = parts[parts.length - 1];
  // If last part is "script.js", get the one before it
  if (cdnScriptId === 'script.js' && parts.length > 2) {
    cdnScriptId = parts[parts.length - 2];
  }
  // Remove .js extension if present (e.g., "abc123.js" -> "abc123")
  if (cdnScriptId.endsWith('.js')) {
    cdnScriptId = cdnScriptId.slice(0, -3);
  }

  const db = env.CONSENT_WEBAPP;

  const site = await db
    .prepare(
      'SELECT id, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id FROM Site WHERE cdnScriptId = ?1'
    )
    .bind(cdnScriptId)
    .first();

  // Backward compatibility:
  // - Some older installs used Site.id in the script URL instead of cdnScriptId.
  // - Also guards against historical data issues where cdnScriptId was not stable.
  let resolvedSite = site;
  if (!resolvedSite) {
    resolvedSite = await db
      .prepare(
        'SELECT id, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id FROM Site WHERE id = ?1'
      )
      .bind(cdnScriptId)
      .first();
  }

  if (!resolvedSite) {
    return new Response('// Unknown site script', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  // Load banner customization
  const customization = await getBannerCustomization(db, resolvedSite.id);

  const apiBase =
    env.API_BASE_URL ||
    'https://consent-webapp-manager.web-8fb.workers.dev';

  const GA_ID = resolvedSite.ga_measurement_id || '';

  // Geo info from Cloudflare
  const cf = request.cf || {};
  const country = cf.country || null;          // e.g. "US"
  const isEU = cf.isEUCountry === '1';         // "1" for EU members

  const regionMode = resolvedSite.region_mode || 'gdpr';           // 'gdpr' | 'ccpa' | 'both'
  let effectiveBannerType = resolvedSite.banner_type || 'gdpr';    // base type

  // If site is configured for both, decide by location:
  // EU -> GDPR, US -> CCPA, others -> GDPR (tweak as needed)
  if (regionMode === 'both') {
    if (isEU) {
      effectiveBannerType = 'gdpr';
    } else if (country === 'US') {
      effectiveBannerType = 'ccpa';
    } else {
      effectiveBannerType = 'gdpr';
    }
  } else if (regionMode === 'ccpa') {
    // Simplified mode: "CCPA" means show CCPA everywhere.
    effectiveBannerType = 'ccpa';
  }

  // Generate custom CSS styles from customization
  let customStyles = null;
  if (customization) {
    // Only bottom positions are supported for initial banner; top/center fall back to bottom-left
    const rawPosition = customization.position || 'bottom-left';
    const position = ['bottom-left', 'bottom-right', 'bottom'].includes(rawPosition)
      ? rawPosition
      : 'bottom-left';
    const bgColor = customization.backgroundColor || '#ffffff';
    const textColor = customization.textColor || '#334155';
    const headingColor = customization.headingColor || '#0f172a';
    const bannerRadius = customization.bannerBorderRadius || '0.375rem';
    const buttonRadius = customization.buttonBorderRadius || '0.375rem';

    /** Typography from stored translations (dashboard Type tab). */
    let enTrans = {};
    try {
      var trRaw = customization.translations;
      if (trRaw) {
        var trParsed = typeof trRaw === 'string' ? JSON.parse(trRaw) : trRaw;
        if (trParsed && trParsed.en) {
          enTrans = trParsed.en;
        }
      }
    } catch (eTy) {
      enTrans = {};
    }
    var fontName = enTrans.bannerFontFamily || '';
    var fontWeightStr = String(enTrans.bannerFontWeight || '600');
    var textAlign = enTrans.bannerTextAlign || 'left';
    if (textAlign !== 'center' && textAlign !== 'right') {
      textAlign = 'left';
    }
    var fontFamilyCss =
      fontName && String(fontName).length
        ? "'" + String(fontName).replace(/'/g, '') + "',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
        : "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    
    // Position classes (initial banner: bottom only)
    let positionStyles = '';
    if (position === 'bottom-left') {
      positionStyles = 'bottom:32px;left:32px;';
    } else if (position === 'bottom-right') {
      positionStyles = 'bottom:32px;right:32px;';
    } else if (position === 'bottom') {
      positionStyles = 'bottom:32px;left:50%;transform:translateX(-50%);';
    }

    customStyles = 
      "#cb-initial-banner.cb-banner{" +
        "width:360px;" +
        "max-width:90vw;" +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        positionStyles +
        "padding:16px;" +
        "border:1px solid #e2e8f0;" +
        "border-radius:" + bannerRadius + ";" +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "font-family:" + fontFamilyCss + ";" +
        "font-size:12px;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner{" +
        "width:360px;" +
        "max-width:90vw;" +
        "max-height:80vh;" +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        "top:50%;" +
        "left:50%;" +
        "transform:translate(-50%,-50%);" +
        "padding:20px;" +
        "border:1px solid #e2e8f0;" +
        "border-radius:" + bannerRadius + ";" +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "font-family:" + fontFamilyCss + ";" +
        "font-size:12px;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      ".cb-banner h3{" +
        "margin:0 0 8px;" +
        "font-size:14px;" +
        "font-weight:" + fontWeightStr + ";" +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + ";" +
      "}" +
      ".cb-banner p{" +
        "margin:0 0 12px;" +
        "font-size:11px;" +
        "line-height:1.4;" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + ";" +
      "}" +
      ".cb-banner button{" +
        "padding:6px 12px;" +
        "border-radius:" + buttonRadius + ";" +
        "cursor:pointer;" +
        "font-size:11px;" +
        "font-weight:600;" +
        "border:1px solid #e2e8f0;" +
        "transition:opacity 0.2s;" +
      "}" +
      ".cb-banner button#cb-accept-all-btn{" +
        "background-color:" + (customization.acceptButtonBg || '#007aff') + ";" +
        "color:" + (customization.acceptButtonText || '#ffffff') + ";" +
        "border-color:" + (customization.acceptButtonBg || '#007aff') + ";" +
      "}" +
      ".cb-banner button#cb-reject-all-btn{" +
        "background-color:" + (customization.rejectButtonBg || '#ffffff') + ";" +
        "color:" + (customization.rejectButtonText || '#334155') + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      ".cb-banner button#cb-preferences-btn," +
      ".cb-banner button#cb-back-btn," +
      ".cb-banner button#cb-prefs-reject-btn," +
      ".cb-banner button#cb-ccpa-donotsell-link{" +
        "background-color:" + (customization.customiseButtonBg || '#ffffff') + ";" +
        "color:" + (customization.customiseButtonText || '#334155') + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + (customization.acceptButtonBg || '#007aff') + ";" +
        "color:" + (customization.acceptButtonText || '#ffffff') + ";" +
        "border-color:" + (customization.acceptButtonBg || '#007aff') + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + (customization.acceptButtonBg || '#007aff') + ";" +
        "color:" + (customization.acceptButtonText || '#ffffff') + ";" +
        "border-color:" + (customization.acceptButtonBg || '#007aff') + ";" +
      "}" +
      /* Dashboard preview: main banner row — outline Preference + solid Reject/Accept */
      "#cb-initial-banner.cb-banner .cb-banner-footer{" +
        "display:flex;" +
        "flex-wrap:wrap;" +
        "gap:8px;" +
        "justify-content:flex-start;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-preferences-btn{" +
        "background:#ffffff!important;" +
        "color:" + (customization.acceptButtonBg || '#007aff') + "!important;" +
        "border:1px solid " + (customization.acceptButtonBg || '#007aff') + "!important;" +
        "font-size:10px!important;" +
        "padding:2px 12px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-reject-all-btn," +
      "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
        "background:" + (customization.acceptButtonBg || '#007aff') + "!important;" +
        "color:#ffffff!important;" +
        "border-color:" + (customization.acceptButtonBg || '#007aff') + "!important;" +
        "font-size:10px!important;" +
        "padding:2px 12px!important;" +
        "font-weight:600!important;" +
      "}" +
      ".cb-banner-footer{" +
        "display:flex;" +
        "justify-content:flex-end;" +
        "gap:10px;" +
        "flex-wrap:wrap;" +
      "}";
  }

  /**
   * Serialize JSON for embedding in a JS response body.
   * - Escape `<` so `</script>` cannot break HTML when the script is inlined.
   * - Catch stringify failures (e.g. unexpected values) so the worker still returns valid JS.
   */
  function jsonForInlineScript(value) {
    try {
      return JSON.stringify(value).replace(/</g, '\\u003c');
    } catch (e) {
      console.warn('[CDN] jsonForInlineScript failed, falling back to null', e);
      return 'null';
    }
  }

  let storedTranslations = null;
  if (customization?.translations) {
    try {
      storedTranslations =
        typeof customization.translations === 'string'
          ? JSON.parse(customization.translations)
          : customization.translations;
    } catch (e) {
      console.warn('[CDN] BannerCustomization.translations is invalid JSON; using defaults', e);
      storedTranslations = null;
    }
  }
  const translationsForScript = mergeTranslations(storedTranslations);

  /** Worker-hosted SVG (same origin as the embed script). */
  function resolveWorkerFloatingLogoUrl() {
    try {
      return new URL(request.url).origin + '/embed/floating-logo.svg';
    } catch (e) {
      return '';
    }
  }

  /** Primary: Next.js /asset/logo.webp when WEBAPP_PUBLIC_URL is set; else Worker SVG. */
  function resolveFloatingLogoUrl() {
    var webapp = String(env.WEBAPP_PUBLIC_URL || '')
      .trim()
      .replace(/\/$/, '');
    if (webapp) {
      return webapp + '/asset/logo.webp';
    }
    return resolveWorkerFloatingLogoUrl();
  }

  /**
   * Preference panel position in the embed. Legacy DB default was `right`.
   * Only `left` keeps a side panel; `right` / `center` / empty → centered modal.
   */
  function normalizePreferencePositionForEmbed(raw) {
    if (raw === 'left') return 'left';
    return 'center';
  }

  // Single JSON.stringify pass avoids fragile nested `${ ... ? ... }` in template literals (browser parse errors).
  const siteConfigPayload = {
    id: resolvedSite.id,
    bannerType: effectiveBannerType,
    apiBase,
    gaId: GA_ID,
    styles: customStyles || null,
    customization: customization
      ? {
          position: customization.position,
          privacyPolicyUrl: customization.privacyPolicyUrl,
          stopScroll: customization.stopScroll === 1,
          footerLink: customization.footerLink === 1,
          animationEnabled:
            customization.animationEnabled == null ||
            customization.animationEnabled === 1 ||
            Number(customization.animationEnabled) === 1,
          preferencePosition: normalizePreferencePositionForEmbed(
            customization.preferencePosition
          ),
          centerAnimationDirection: customization.centerAnimationDirection || 'fade',
          language: customization.language || 'en',
          autoDetectLanguage: customization.autoDetectLanguage === 1,
          cookieExpirationDays:
            customization.cookieExpirationDays != null ? customization.cookieExpirationDays : 30,
          acceptButtonBg: customization.acceptButtonBg || '#007aff',
          acceptButtonText: customization.acceptButtonText || '#ffffff',
        }
      : null,
    floatingLogoUrl: resolveFloatingLogoUrl(),
    floatingLogoFallbackUrl: resolveWorkerFloatingLogoUrl(),
  };

  const inlineConfig = `
    window.__CONSENT_SITE__ = ${jsonForInlineScript(siteConfigPayload)};
  `;

  const translationsVar =
    'var TRANSLATIONS = ' + jsonForInlineScript(translationsForScript) + ';';

  const loader = `
${inlineConfig}
(function () {
  // ConsentBit loader (ES5-compatible: no shorthand props / optional chaining in this file)
  var siteConfig = window.__CONSENT_SITE__ || {};
  var FLOATING_LOGO_URL = siteConfig.floatingLogoUrl || '';
  var FLOATING_LOGO_FALLBACK_URL = siteConfig.floatingLogoFallbackUrl || '';
  var SITE_ID = siteConfig.id || null;
  var BANNER_TYPE = siteConfig.bannerType || 'gdpr';
  var API_BASE = siteConfig.apiBase;
  var GA_MEASUREMENT_ID = siteConfig.gaId || null;
  var CUSTOMIZATION = siteConfig.customization || null;
  var PRIVACY_POLICY_URL = CUSTOMIZATION ? CUSTOMIZATION.privacyPolicyUrl : null;
  var STOP_SCROLL = CUSTOMIZATION ? CUSTOMIZATION.stopScroll : false;
  var ANIMATION_ENABLED = CUSTOMIZATION ? (CUSTOMIZATION.animationEnabled !== false) : true;
  var PREFERENCE_POSITION = CUSTOMIZATION ? (CUSTOMIZATION.preferencePosition || 'center') : 'center';
  var CENTER_ANIMATION_DIRECTION = CUSTOMIZATION ? (CUSTOMIZATION.centerAnimationDirection || 'fade') : 'fade';
  var BANNER_LANGUAGE = CUSTOMIZATION ? (CUSTOMIZATION.language || 'en') : 'en';
  var AUTO_DETECT_LANGUAGE = CUSTOMIZATION ? (CUSTOMIZATION.autoDetectLanguage === true) : false;
  
  // Language translations (from backend / variables)
  ${translationsVar}
  
  // Detect language from browser or use configured language
  function getBannerLanguage() {
    if (AUTO_DETECT_LANGUAGE) {
      var browserLang = (navigator.language || navigator.userLanguage || 'en').split('-')[0].toLowerCase();
      return TRANSLATIONS[browserLang] ? browserLang : 'en';
    }
    return BANNER_LANGUAGE;
  }
  
  function getTranslation(key) {
    var lang = getBannerLanguage();
    var t = TRANSLATIONS[lang] || TRANSLATIONS['en'];
    return t[key] || TRANSLATIONS['en'][key] || key;
  }

  function isCookiePolicyLinkEnabled() {
    try {
      var lang = getBannerLanguage();
      var row = TRANSLATIONS[lang] || TRANSLATIONS['en'] || {};
      var v = row['cookiePolicyLinkEnabled'];
      if (v === false) return false;
      if (v === '0') return false;
      if (String(v).toLowerCase() === 'false') return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function isCloseButtonEnabled() {
    try {
      var lang = getBannerLanguage();
      var row = TRANSLATIONS[lang] || TRANSLATIONS['en'] || {};
      var v = row['closeButtonEnabled'];
      if (v === true || v === 1) return true;
      if (v === false) return false;
      if (v === '0') return false;
      if (String(v).toLowerCase() === 'false') return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  /** Turn stored policy URL into an absolute href (relative paths use the page URL as base). */
  function resolvePrivacyPolicyHref(raw) {
    if (!raw || typeof raw !== 'string') return '';
    var u = raw.trim();
    if (!u) return '';
    var lower = u.toLowerCase();
    if (lower.indexOf('mailto:') === 0 || lower.indexOf('tel:') === 0) return u;
    if (lower.indexOf('http://') === 0 || lower.indexOf('https://') === 0) return u;
    if (u.indexOf('//') === 0) return 'https:' + u;
    try {
      if (typeof window !== 'undefined' && window.location) {
        return new URL(u, window.location.href).href;
      }
    } catch (e1) {}
    return u;
  }

  /**
   * Privacy / cookie policy links: always open in a new tab and do not navigate the host page.
   * Uses window.open on click so parent handlers cannot turn the click into an in-page navigation.
   */
  function attachPrivacyPolicyLink(anchorEl, rawUrl) {
    var href = resolvePrivacyPolicyHref(rawUrl);
    if (!href) return;
    anchorEl.href = href;
    anchorEl.target = '_blank';
    anchorEl.rel = 'noopener noreferrer';
    anchorEl.addEventListener(
      'click',
      function (ev) {
        if (ev.stopPropagation) ev.stopPropagation();
        if (ev.preventDefault) ev.preventDefault();
        try {
          window.open(href, '_blank', 'noopener,noreferrer');
        } catch (e2) {
          /* href + target allow user to open via context menu; do not navigate this tab */
        }
      },
      true
    );
  }

  console.log('[ConsentBit] Loader init', {
    SITE_ID: SITE_ID,
    BANNER_TYPE: BANNER_TYPE,
    API_BASE: API_BASE,
    GA_MEASUREMENT_ID: GA_MEASUREMENT_ID,
    CUSTOMIZATION: CUSTOMIZATION
  });

  var CONSENT_KEY = 'consentbit_' + SITE_ID;
  var COOKIE_EXPIRATION_DAYS = (typeof CUSTOMIZATION !== 'undefined' && CUSTOMIZATION && CUSTOMIZATION.cookieExpirationDays != null)
    ? Math.max(1, Math.min(365, Number(CUSTOMIZATION.cookieExpirationDays) || 30))
    : 30;
  var consentState = loadConsent();
  console.log('[ConsentBit] Loaded consent state', consentState);

  function loadConsent() {
    try {
      var raw = localStorage.getItem(CONSENT_KEY);
      var data = raw ? JSON.parse(raw) : { accepted: false, timestamp: null };
      if (!data || !data.accepted) return data || { accepted: false, timestamp: null };
      var now = Date.now();
      var expiryMs = COOKIE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
      var expiresAtMs = data.expiresAt
        ? new Date(data.expiresAt).getTime()
        : (data.timestamp ? new Date(data.timestamp).getTime() + expiryMs : 0);
      if (expiresAtMs > 0 && now > expiresAtMs) {
        return { accepted: false, timestamp: null };
      }
      return data;
    } catch (e) {
      console.warn('[ConsentBit] Failed to read consent from localStorage', e);
      return { accepted: false, timestamp: null };
    }
  }

  function saveConsent(next) {
    try {
      var daysMs = COOKIE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
      next.expiresAt = next.expiresAt || new Date(Date.now() + daysMs).toISOString();
      localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
      console.log('[ConsentBit] Saved consent state', next);
    } catch (e) {
      console.warn('[ConsentBit] Failed to save consent state', e);
    }
    consentState = next;
  }

  // Send consent to backend API
  function sendConsentToServer(consent, options) {
    if (!SITE_ID || !API_BASE) return;

    options = options || {};
    var expiresAt = (consent && consent.expiresAt) || options.expiresAt
      || new Date(Date.now() + COOKIE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    var payload = {
      siteId: SITE_ID,
      regulation: BANNER_TYPE === 'gdpr' ? 'gdpr' : 'ccpa',
      bannerType: BANNER_TYPE,
      consentMethod: options.consentMethod || 'banner',
      status: options.status || 'given',
      expiresAt: expiresAt,
      consent: consent
    };

    try {
      fetch(API_BASE + '/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function (e) {
        console.warn('[ConsentBit] /api/consent failed', e);
      });
    } catch (e) {
      console.warn('[ConsentBit] /api/consent threw', e);
    }
  }

  // Send anonymous pageview to backend for billing/usage
  function sendPageviewToServer() {
    if (!SITE_ID || !API_BASE) return;
    try {
      var payload = {
        siteId: SITE_ID,
        pageUrl: (typeof window !== 'undefined' && window.location) ? window.location.href : null
      };
      fetch(API_BASE + '/api/pageview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function (e) {
        console.warn('[ConsentBit] /api/pageview failed', e);
      });
    } catch (e) {
      console.warn('[ConsentBit] /api/pageview threw', e);
    }
  }

  // Collect cookies from document.cookie and send to backend (no categorization in client)
  function getDocumentCookies() {
    try {
      var raw = typeof document !== 'undefined' && document.cookie ? document.cookie : '';
      if (!raw) return [];
      return raw.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function sendCookiesToBackend() {
    if (!SITE_ID || !API_BASE) return;
    var cookies = getDocumentCookies();
    if (cookies.length === 0) return;
    try {
      fetch(API_BASE + '/api/scan-cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: SITE_ID,
          pageUrl: typeof location !== 'undefined' ? location.href : '',
          cookies: cookies
        })
      }).catch(function (e) {
        console.warn('[ConsentBit] /api/scan-cookies failed', e);
      });
    } catch (e) {
      console.warn('[ConsentBit] sendCookiesToBackend threw', e);
    }
  }

  function categorize(src) {
    try {
      var u = new URL(src);
      var host = u.hostname;

      if (
        host.indexOf('google-analytics.com') !== -1 ||
        src.indexOf('gtag/js') !== -1 ||
        host.indexOf('googletagmanager.com') !== -1
      ) {
        return 'analytics';
      }
      if (
        host.indexOf('facebook.com') !== -1 ||
        host.indexOf('fbcdn.net') !== -1 ||
        host.indexOf('doubleclick.net') !== -1 ||
        host.indexOf('ads.') === 0
      ) {
        return 'marketing';
      }
      if (
        host.indexOf('hotjar.com') !== -1 ||
        host.indexOf('intercom.io') !== -1 ||
        host.indexOf('fullstory.com') !== -1
      ) {
        return 'behavioral';
      }
      // Compliance (disabled): YouTube/Maps, Google Fonts, Webflow — re-enable in categorize() if needed.
      return 'uncategorized';
    } catch (e) {
      return 'uncategorized';
    }
  }

  function collectScripts() {
    var seen = {};
    var list = [];
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (!s.src) continue;
      if (seen[s.src]) continue;
      seen[s.src] = true;
      list.push(s);
    }
    return list;
  }

  function hasGoogleTracking() {
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var src = s.src || '';
      if (
        src.indexOf('googletagmanager.com/gtag/js') !== -1 ||
        src.indexOf('googletagmanager.com/gtm.js') !== -1 ||
        src.indexOf('google-analytics.com') !== -1
      ) {
        console.log('[ConsentBit] Detected Google tracking tag', src);
        return true;
      }
    }
    console.log('[ConsentBit] No Google tracking tag detected');
    return false;
  }

  var delayedScripts = [];

  function isNonEssential(category) {
    return category === 'analytics' || category === 'marketing' || category === 'behavioral';
    // Compliance (disabled): || category === 'uncategorized'
  }

  function blockNonEssentialScripts() {
    var scripts = collectScripts();
    console.log('[ConsentBit] Blocking non-essential scripts (GDPR) - but allowing GA for cookieless tracking');

    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var src = s.src;
      var category = categorize(src);

      if (!isNonEssential(category)) {
        continue;
      }

      if (consentState.accepted) {
        console.log('[ConsentBit] Consent already accepted, not blocking', src, category);
        continue;
      }

      // Allow GA scripts to load for cookieless tracking (anonymous visitor count)
      // These will use consent mode denied, so no cookies will be set
      if (category === 'analytics' && GA_MEASUREMENT_ID) {
        var isGoogleAnalytics = src.indexOf('googletagmanager.com/gtag/js') !== -1 || 
                                 src.indexOf('googletagmanager.com/gtm.js') !== -1 ||
                                 src.indexOf('google-analytics.com') !== -1;
        if (isGoogleAnalytics) {
          console.log('[ConsentBit] Allowing GA script for cookieless tracking (no cookies will be set)', src);
          continue; // Don't block GA - it will use consent mode denied
        }
      }

      var attrs = {};
      for (var j = 0; j < s.attributes.length; j++) {
        var attr = s.attributes[j];
        attrs[attr.name] = attr.value;
      }

      delayedScripts.push({
        src: src,
        attrs: attrs,
        category: category,
      });

      console.log('[ConsentBit] Blocking script', { src: src, category: category });
      s.parentNode && s.parentNode.removeChild(s);
    }

    console.log('[ConsentBit] Total delayed scripts', delayedScripts.length);
  }

  function enableDelayedScripts() {
    console.log('[ConsentBit] Enabling delayed scripts, count:', delayedScripts.length);

    if (!delayedScripts.length) return;

    for (var i = 0; i < delayedScripts.length; i++) {
      var item = delayedScripts[i];
      var newScript = document.createElement('script');
      newScript.src = item.src;

      var attrs = item.attrs;
      for (var name in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, name)) continue;
        if (name === 'src') continue;
        newScript.setAttribute(name, attrs[name]);
      }

      console.log('[ConsentBit] Re-injecting script', item.src, 'category:', item.category);
      document.head.appendChild(newScript);
    }

    delayedScripts = [];
  }

  // Optional YouTube/Maps embed + Google Fonts blocking was removed from the bundle (kept in repo history).
  // Using block comments around that code broke parsing: selectors like href*="..." can contain the sequence */.

  function initGoogleConsentMode() {
    if (!GA_MEASUREMENT_ID) {
      console.log('[ConsentBit] GA_MEASUREMENT_ID not set, skipping Google Consent Mode');
      return;
    }

    console.log('[ConsentBit] Initializing Google Consent Mode (denied - cookieless tracking) for GA ID', GA_MEASUREMENT_ID);

    // Check if GA script already exists
    var gaScriptExists = false;
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var src = s.src || '';
      if (src.indexOf('googletagmanager.com/gtag/js') !== -1 || 
          src.indexOf('googletagmanager.com/gtm.js') !== -1 ||
          src.indexOf('google-analytics.com') !== -1) {
        gaScriptExists = true;
        console.log('[ConsentBit] GA script already exists, using existing script');
        break;
      }
    }

    // Only inject GA script if it doesn't exist
    if (!gaScriptExists) {
      var script = document.createElement('script');
      script.async = true;
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
      document.head.appendChild(script);
    }

    window.dataLayer = window.dataLayer || [];
    function gtag(){ dataLayer.push(arguments); }
    window.gtag = gtag;

    // Set consent mode to denied BEFORE config - this enables cookieless tracking
    // GA4 will send anonymized pageviews without cookies or user identifiers
    gtag('consent', 'default', {
      ad_storage: 'denied',
      analytics_storage: 'denied', // No cookies, but cookieless pings allowed
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });

    gtag('js', new Date());
    
    // Configure GA4 with privacy settings for GDPR compliance
    // When analytics_storage is 'denied', GA4 automatically:
    // - Does not set cookies
    // - Sends anonymized pageview data (cookieless pings)
    // - Uses IP anonymization
    // - Does not store user identifiers
    gtag('config', GA_MEASUREMENT_ID, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    
    // Send initial pageview (cookieless)
    gtag('event', 'page_view', {
      page_path: window.location.pathname,
      page_title: document.title || '',
    });
    
    console.log('[ConsentBit] GA4 initialized for cookieless tracking (anonymous visitor count, no cookies)');
  }

  function grantGoogleConsent() {
    if (!window.gtag) {
      console.log('[ConsentBit] gtag not defined, cannot grant Google consent');
      return;
    }
    console.log('[ConsentBit] Granting Google consent (update to granted)');
    window.gtag('consent', 'update', {
      ad_storage: 'granted',
      analytics_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    });
  }

  // --- Banner styles ---
  // Matching preview banner styles from defaultBannerConfig

  var BANNER_STYLES =
    "#cb-initial-banner.cb-banner{" +
      "width:360px;" +
      "max-width:90vw;" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "position:fixed;" +
      "bottom:32px;" +
      "left:32px;" +
      "padding:16px;" +
      "border:1px solid #e2e8f0;" +
      "border-radius:0.375rem;" +
      "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
      "z-index:2147483647;" +
      "display:flex;" +
      "flex-direction:column;" +
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "font-size:12px;" +
    "}" +
    "#cb-preferences-banner.cb-banner{" +
      "width:360px;" +
      "max-width:90vw;" +
      "max-height:80vh;" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "position:fixed;" +
      "top:50%;" +
      "left:50%;" +
      "transform:translate(-50%,-50%);" +
      "padding:20px;" +
      "border:1px solid #e2e8f0;" +
      "border-radius:0.375rem;" +
      "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
      "z-index:2147483647;" +
      "display:flex;" +
      "flex-direction:column;" +
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "font-size:12px;" +
    "}" +
    // Preference banner position styles (will be overridden by JS)
    "#cb-preferences-banner.cb-banner.prefs-left{" +
      "left:32px;" +
      "right:auto;" +
      "top:50%;" +
      "transform:translateY(-50%);" +
    "}" +
    "#cb-preferences-banner.cb-banner.prefs-right{" +
      "right:32px;" +
      "left:auto;" +
      "top:50%;" +
      "transform:translateY(-50%);" +
    "}" +
    "#cb-preferences-banner.cb-banner.prefs-center{" +
      "left:50%;" +
      "top:50%;" +
      "transform:translate(-50%,-50%);" +
    "}" +
    ".cb-banner-body{" +
      "overflow-y:auto;" +
      "margin-bottom:12px;" +
    "}" +
    ".cb-banner h3{" +
      "margin:0 0 8px;" +
      "font-size:14px;" +
      "font-weight:600;" +
      "color:#0f172a;" +
      "word-break:break-word;" +
      "overflow-wrap:anywhere;" +
      "max-width:100%;" +
    "}" +
    "#cb-initial-banner.cb-banner h3{" +
      "font-size:13px;" +
      "font-weight:600;" +
      "color:rgba(0,0,0,0.8);" +
    "}" +
    "#cb-initial-banner.cb-banner .cb-banner-body > p{" +
      "color:rgba(0,0,0,0.8);" +
    "}" +
    ".cb-gdpr-accordion{" +
      "margin-top:4px;" +
      "margin-bottom:4px;" +
    "}" +
    ".cb-banner p{" +
      "margin:0 0 12px;" +
      "font-size:11px;" +
      "line-height:1.4;" +
      "color:#334155;" +
    "}" +
    ".cb-banner-footer{" +
      "display:flex;" +
      "justify-content:flex-end;" +
      "gap:10px;" +
      "flex-wrap:wrap;" +
    "}" +
    ".cb-banner button{" +
      "padding:6px 12px;" +
      "border-radius:0.375rem;" +
      "cursor:pointer;" +
      "font-size:11px;" +
      "font-weight:600;" +
      "border:1px solid #e2e8f0;" +
      "transition:opacity 0.2s;" +
    "}" +
    ".cb-banner button:hover:not(.cb-pref-toggle-track){" +
      "opacity:0.8;" +
    "}" +
    // GDPR prefs: iOS-style pill toggles (scoped so host + .cb-banner button rules do not flatten them)
    "#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{" +
      "display:block !important;" +
      "width:40px !important;" +
      "min-width:40px !important;" +
      "height:22px !important;" +
      "padding:0 !important;" +
      "margin:0 !important;" +
      "border:none !important;" +
      "border-radius:11px !important;" +
      "background:#d1d5db !important;" +
      "box-shadow:none !important;" +
      "flex-shrink:0 !important;" +
      "position:relative !important;" +
      "overflow:visible !important;" +
      "box-sizing:border-box !important;" +
      "cursor:pointer !important;" +
      "appearance:none !important;" +
      "-webkit-appearance:none !important;" +
      "font-size:0 !important;" +
      "line-height:0 !important;" +
      "opacity:1 !important;" +
    "}" +
    "#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{" +
      "background:#22c55e !important;" +
    "}" +
    // Knob drawn with ::after so host CSS cannot hide inner <span> inside buttons
    "#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{" +
      "content:'' !important;" +
      "position:absolute !important;" +
      "top:2px !important;" +
      "left:2px !important;" +
      "width:18px !important;" +
      "height:18px !important;" +
      "border-radius:50% !important;" +
      "background:#ffffff !important;" +
      "box-shadow:0 1px 3px rgba(0,0,0,.2) !important;" +
      "pointer-events:none !important;" +
      "transition:left .15s ease !important;" +
      "z-index:2 !important;" +
    "}" +
    "#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{" +
      "left:20px !important;" +
    "}" +
    ".cb-banner button#cb-accept-all-btn{" +
      "background-color:#007aff;" +
      "color:#ffffff;" +
      "border-color:#007aff;" +
    "}" +
    ".cb-banner button#cb-reject-all-btn{" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "border-color:#e2e8f0;" +
    "}" +
    ".cb-banner button#cb-preferences-btn," +
    ".cb-banner button#cb-back-btn," +
    ".cb-banner button#cb-prefs-reject-btn," +
    ".cb-banner button#cb-ccpa-donotsell-link{" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "border-color:#e2e8f0;" +
    "}" +
    // GDPR preference modal: primary Save (CCPA uses .cb-ccpa-prefs rule below)
    "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
      "background-color:#007aff;" +
      "color:#ffffff;" +
      "border-color:#007aff;" +
    "}" +
    ".cb-banner label{" +
      "display:block;" +
      "margin-bottom:6px;" +
      "font-size:11px;" +
      "color:#334155;" +
    "}" +
    ".cb-banner input[type='checkbox']{" +
      "margin-right:6px;" +
    "}" +
    ".cb-banner a{" +
      "color:#007aff;" +
      "text-decoration:underline;" +
      "font-size:11px;" +
    "}" +
    // Animation keyframes
    "@keyframes slideInFromLeft{" +
      "from{transform:translateX(-100%);opacity:0;}" +
      "to{transform:translateX(0);opacity:1;}" +
    "}" +
    "@keyframes slideInFromRight{" +
      "from{transform:translateX(100%);opacity:0;}" +
      "to{transform:translateX(0);opacity:1;}" +
    "}" +
    "@keyframes slideInFromTop{" +
      "from{transform:translateY(-100%);opacity:0;}" +
      "to{transform:translateY(0);opacity:1;}" +
    "}" +
    "@keyframes slideInFromBottom{" +
      "from{transform:translateY(100%);opacity:0;}" +
      "to{transform:translateY(0);opacity:1;}" +
    "}" +
    "@keyframes fadeIn{" +
      "from{opacity:0;}" +
      "to{opacity:1;}" +
    "}" +
    // Preference banner: slide keyframes must keep vertical/horizontal centering (transform) intact
    "@keyframes prefsSlideInFromLeft{" +
      "from{transform:translate(-120%,-50%);opacity:0;}" +
      "to{transform:translate(0,-50%);opacity:1;}" +
    "}" +
    "@keyframes prefsSlideInFromRight{" +
      "from{transform:translate(120%,-50%);opacity:0;}" +
      "to{transform:translate(0,-50%);opacity:1;}" +
    "}" +
    "@keyframes prefsSlideCenterFromBottom{" +
      "from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}" +
      "to{transform:translate(-50%,-50%);opacity:1;}" +
    "}" +
    "@keyframes prefsSlideCenterFromTop{" +
      "from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}" +
      "to{transform:translate(-50%,-50%);opacity:1;}" +
    "}" +
    // Animation classes
    ".cb-banner-animate-left{" +
      "animation:slideInFromLeft 0.4s ease-out;" +
    "}" +
    ".cb-banner-animate-right{" +
      "animation:slideInFromRight 0.4s ease-out;" +
    "}" +
    ".cb-banner-animate-top{" +
      "animation:slideInFromTop 0.4s ease-out;" +
    "}" +
    ".cb-banner-animate-bottom{" +
      "animation:slideInFromBottom 0.4s ease-out;" +
    "}" +
      ".cb-banner-animate-fade{" +
      "animation:fadeIn 0.3s ease-out;" +
    "}" +
    ".cb-banner-animate-prefs-left{" +
      "animation:prefsSlideInFromLeft 0.4s ease-out;" +
    "}" +
    ".cb-banner-animate-prefs-right{" +
      "animation:prefsSlideInFromRight 0.4s ease-out;" +
    "}" +
    ".cb-banner-animate-center-top{" +
      "animation:prefsSlideCenterFromTop 0.35s ease-out;" +
    "}" +
    ".cb-banner-animate-center-bottom{" +
      "animation:prefsSlideCenterFromBottom 0.35s ease-out;" +
    "}" +
    "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
      "background-color:#007aff;" +
      "color:#ffffff;" +
      "border-color:#007aff;" +
    "}" +
    // Dashboard preview: GDPR main row (Preference outline + solid Reject/Accept)
    "#cb-initial-banner.cb-banner .cb-banner-footer{" +
      "display:flex;" +
      "flex-wrap:wrap;" +
      "gap:8px;" +
      "justify-content:flex-start;" +
    "}" +
    "#cb-initial-banner.cb-banner #cb-preferences-btn{" +
      "background:#ffffff!important;" +
      "color:#007aff!important;" +
      "border:1px solid #007aff!important;" +
      "font-size:10px!important;" +
      "padding:2px 12px!important;" +
      "font-weight:600!important;" +
    "}" +
    "#cb-initial-banner.cb-banner #cb-reject-all-btn," +
    "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
      "background:#007aff!important;" +
      "color:#ffffff!important;" +
      "border-color:#007aff!important;" +
      "font-size:10px!important;" +
      "padding:2px 12px!important;" +
      "font-weight:600!important;" +
    "}" +
    "#cb-floating-trigger{" +
      "position:fixed;" +
      "z-index:2147483646;" +
      "width:40px;" +
      "height:40px;" +
      "border:1px solid #e2e8f0;" +
      "border-radius:9999px;" +
      "background:#ffffff;" +
      "cursor:pointer;" +
      "padding:0;" +
      "box-shadow:0 4px 14px rgba(15,23,42,0.12);" +
    "}" +
    "#cb-floating-trigger img," +
    "#cb-floating-trigger svg{" +
      "display:block;" +
      "width:28px;" +
      "height:28px;" +
      "object-fit:contain;" +
      "margin:auto;" +
      "pointer-events:none;" +
    "}";

  // Merge: DB customization overrides colors/sizes but must not drop layout (footer, prefs positions, animations).
  if (siteConfig.styles) {
    BANNER_STYLES = BANNER_STYLES + '\\n' + siteConfig.styles;
  }

  function injectConsentBitStyles() {
    if (document.getElementById("cb-styles")) {
      console.log('[ConsentBit] Styles already injected');
      return;
    }

    var abBg = (CUSTOMIZATION && CUSTOMIZATION.acceptButtonBg) ? String(CUSTOMIZATION.acceptButtonBg) : '#007aff';
    var abTx = (CUSTOMIZATION && CUSTOMIZATION.acceptButtonText) ? String(CUSTOMIZATION.acceptButtonText) : '#ffffff';
    // Always last: legacy siteConfig.styles sometimes grouped #cb-save-prefs-btn with outline buttons — force primary Save.
    var savePrefsOverride =
      '#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{' +
        'background-color:' + abBg + ' !important;' +
        'color:' + abTx + ' !important;' +
        'border-color:' + abBg + ' !important;' +
      '}';

    var style = document.createElement("style");
    style.id = "cb-styles";
    style.type = "text/css";
    style.appendChild(document.createTextNode(BANNER_STYLES + '\\n' + savePrefsOverride));
    document.head.appendChild(style);
    console.log('[ConsentBit] Styles injected into head');
  }

  function appendBannerCloseButton(bannerEl, id) {
    if (!isCloseButtonEnabled()) return;
    // Do not set position on bannerEl — it must stay position:fixed from CSS; inline "relative" breaks placement.
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.setAttribute('aria-label', 'Close');
    btn.textContent = '\u00d7';
    btn.style.cssText =
      'position:absolute;top:8px;right:8px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;' +
      'background:transparent;cursor:pointer;z-index:10;line-height:1;' +
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;' +
      'font-size:22px;font-weight:400;color:#0f172a;opacity:0.75;';
    bannerEl.appendChild(btn);
  }

  function appendPrefsCloseButton(prefsBannerEl) {
    if (!isCloseButtonEnabled()) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'cb-close-prefs-btn';
    btn.setAttribute('aria-label', 'Close');
    btn.textContent = '\u00d7';
    btn.style.cssText =
      'position:absolute;top:8px;right:8px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;' +
      'background:transparent;cursor:pointer;z-index:10;line-height:1;' +
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;' +
      'font-size:22px;font-weight:400;color:#0f172a;opacity:0.75;';
    prefsBannerEl.appendChild(btn);
  }

  function renderConsentBitBanners() {
    if (document.getElementById("cb-initial-banner")) {
      console.log('[ConsentBit] Banner already exists');
      return;
    }

    if (!document.body) {
      console.warn('[ConsentBit] document.body not ready, retrying...');
      setTimeout(renderConsentBitBanners, 100);
      return;
    }

    var isCCPA = BANNER_TYPE === 'ccpa';
    var wrapper = document.createElement("div");

    if (isCCPA) {
      var initialBanner = document.createElement("div");
      initialBanner.className = "cb-banner";
      initialBanner.id = "cb-initial-banner";
      initialBanner.style.display = "flex";
      
      var bodyDiv = document.createElement("div");
      bodyDiv.className = "cb-banner-body";
      var h3 = document.createElement("h3");
      h3.textContent = getTranslation('title');
      bodyDiv.appendChild(h3);
      var p = document.createElement("p");
      var pText = getTranslation('description');
      
      if (PRIVACY_POLICY_URL && isCookiePolicyLinkEnabled()) {
        p.appendChild(document.createTextNode(pText + " "));
        var link = document.createElement("a");
        link.textContent = getTranslation('privacyPolicy');
        link.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
        attachPrivacyPolicyLink(link, PRIVACY_POLICY_URL);
        p.appendChild(link);
        p.appendChild(document.createTextNode("."));
      } else {
        p.textContent = pText;
      }
      bodyDiv.appendChild(p);

      var dnRow = document.createElement("p");
      dnRow.style.marginTop = "8px";
      dnRow.style.marginBottom = "0";
      var doNotSellLink = document.createElement("button");
      doNotSellLink.id = "cb-ccpa-donotsell-link";
      doNotSellLink.type = "button";
      doNotSellLink.textContent = getTranslation('doNotSell');
      doNotSellLink.style.cssText = "background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;font-size:11px;text-align:left;display:inline;";
      dnRow.appendChild(doNotSellLink);
      bodyDiv.appendChild(dnRow);
      
      initialBanner.appendChild(bodyDiv);
      appendBannerCloseButton(initialBanner, 'cb-close-initial-btn');
      // CCPA initial banner: no Accept button (Do Not Share link + opt-out flow only)
      wrapper.appendChild(initialBanner);
      
      var prefsBanner = document.createElement("div");
      prefsBanner.className = "cb-banner cb-ccpa-prefs";
      prefsBanner.id = "cb-preferences-banner";
      prefsBanner.style.display = "none";
      
      // Apply preference banner position class
      if (PREFERENCE_POSITION === 'left') {
        prefsBanner.classList.add('prefs-left');
      } else if (PREFERENCE_POSITION === 'right') {
        prefsBanner.classList.add('prefs-right');
      } else {
        prefsBanner.classList.add('prefs-center');
      }
      
      var prefsBody = document.createElement("div");
      prefsBody.className = "cb-banner-body";
      var prefsH3 = document.createElement("h3");
      prefsH3.textContent = getTranslation('optOutPreference');
      prefsBody.appendChild(prefsH3);
      var prefsP = document.createElement("p");
      var ccpaIntro = (getTranslation('ccpaOptOutPreferenceIntro') || getTranslation('ccpaOptOut') || "").replace(/\s*More info\.?\s*$/i, "").trim();
      if (PRIVACY_POLICY_URL && isCookiePolicyLinkEnabled()) {
        prefsP.appendChild(document.createTextNode(ccpaIntro + " "));
        var ccpaLinkPrefs = document.createElement("a");
        ccpaLinkPrefs.textContent = getTranslation('privacyPolicy');
        ccpaLinkPrefs.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
        attachPrivacyPolicyLink(ccpaLinkPrefs, PRIVACY_POLICY_URL);
        prefsP.appendChild(ccpaLinkPrefs);
        prefsP.appendChild(document.createTextNode("."));
      } else {
        prefsP.textContent = ccpaIntro;
      }
      prefsP.style.lineHeight = "1.45";
      prefsBody.appendChild(prefsP);
      
      var label = document.createElement("label");
      label.style.cssText = "display:flex;align-items:flex-start;gap:12px;margin-top:12px;font-size:11px;cursor:pointer;";
      var labelText = document.createElement("span");
      labelText.style.cssText = "flex:1;line-height:1.45;";
      labelText.textContent = getTranslation('doNotSell');
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "cb-ccpa-optout";
      checkbox.style.cssText = "flex-shrink:0;margin-top:2px;";
      label.appendChild(checkbox);
      label.appendChild(labelText);
      prefsBody.appendChild(label);
      prefsBanner.appendChild(prefsBody);
      
      var prefsFooter = document.createElement("div");
      prefsFooter.className = "cb-banner-footer";
      var backBtn = document.createElement("button");
      backBtn.id = "cb-back-btn";
      backBtn.textContent = getTranslation('cancel');
      prefsFooter.appendChild(backBtn);
      var saveBtn = document.createElement("button");
      saveBtn.id = "cb-save-prefs-btn";
      saveBtn.textContent = getTranslation('saveMyPreferences') || getTranslation('save');
      prefsFooter.appendChild(saveBtn);
      prefsBanner.appendChild(prefsFooter);
      appendPrefsCloseButton(prefsBanner);
      wrapper.appendChild(prefsBanner);
    } else {
      // GDPR: accordion rows (+ expand, descriptions, toggles) — same structure as dashboard ConsentPreview
      var makeGdprPrefCategoryBlock = function (opts) {
        var wrap = document.createElement("div");
        wrap.style.borderBottom = "1px solid #e5e7eb";
        var row = document.createElement("div");
        row.style.cssText =
          "display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";
        var exp = document.createElement("button");
        exp.type = "button";
        exp.setAttribute("aria-expanded", "false");
        exp.textContent = "+";
        exp.style.cssText =
          "flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";
        var lab = document.createElement("span");
        lab.style.cssText = "flex:1;font-size:11px;font-weight:600;color:#0f172a;";
        lab.textContent = opts.labelText;
        row.appendChild(exp);
        row.appendChild(lab);
        var right = document.createElement("div");
        right.style.flexShrink = "0";
        if (opts.alwaysActive) {
          var aa = document.createElement("span");
          aa.style.cssText = "font-size:11px;font-weight:600;color:#374151;";
          aa.textContent = getTranslation("alwaysActive");
          right.appendChild(aa);
        } else {
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.id = opts.checkboxId;
          if (opts.defaultChecked) cb.checked = true;
          cb.style.cssText =
            "position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";
          var sw = document.createElement("button");
          sw.type = "button";
          sw.className = "cb-pref-toggle-track";
          sw.setAttribute("role", "switch");
          sw.setAttribute("aria-label", opts.labelText);
          var syncKnob = function () {
            sw.setAttribute("aria-checked", cb.checked ? "true" : "false");
          };
          sw.addEventListener("click", function () {
            cb.checked = !cb.checked;
            syncKnob();
          });
          syncKnob();
          right.appendChild(cb);
          right.appendChild(sw);
        }
        row.appendChild(right);
        var desc = document.createElement("div");
        desc.style.cssText =
          "display:none;padding:0 12px 12px 44px;font-size:10px;line-height:1.45;color:#64748b;";
        desc.textContent = opts.descText;
        exp.addEventListener("click", function () {
          var open = desc.style.display === "none";
          desc.style.display = open ? "block" : "none";
          exp.textContent = open ? "\u2212" : "+";
          exp.setAttribute("aria-expanded", open ? "true" : "false");
        });
        wrap.appendChild(row);
        wrap.appendChild(desc);
        return wrap;
      };

      var initialBanner = document.createElement("div");
      initialBanner.className = "cb-banner";
      initialBanner.id = "cb-initial-banner";
      initialBanner.style.display = "flex";
      
      var bodyDiv = document.createElement("div");
      bodyDiv.className = "cb-banner-body";
      var h3 = document.createElement("h3");
      h3.textContent = getTranslation('title');
      bodyDiv.appendChild(h3);
      var p = document.createElement("p");
      var pText = getTranslation('description');
      
      if (PRIVACY_POLICY_URL && isCookiePolicyLinkEnabled()) {
        p.appendChild(document.createTextNode(pText + " "));
        var link = document.createElement("a");
        link.textContent = getTranslation('privacyPolicy');
        link.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
        attachPrivacyPolicyLink(link, PRIVACY_POLICY_URL);
        p.appendChild(link);
        p.appendChild(document.createTextNode("."));
      } else {
        p.textContent = pText;
      }
      bodyDiv.appendChild(p);
      
      initialBanner.appendChild(bodyDiv);
      
      var footerDiv = document.createElement("div");
      footerDiv.className = "cb-banner-footer";
      var customiseBtn = document.createElement("button");
      customiseBtn.id = "cb-preferences-btn";
      customiseBtn.textContent = getTranslation('customise');
      footerDiv.appendChild(customiseBtn);
      var rejectBtn = document.createElement("button");
      rejectBtn.id = "cb-reject-all-btn";
      rejectBtn.textContent = getTranslation('rejectAll');
      footerDiv.appendChild(rejectBtn);
      var acceptBtn = document.createElement("button");
      acceptBtn.id = "cb-accept-all-btn";
      acceptBtn.textContent = getTranslation('acceptAll');
      footerDiv.appendChild(acceptBtn);
      initialBanner.appendChild(footerDiv);
      appendBannerCloseButton(initialBanner, 'cb-close-initial-btn');
      wrapper.appendChild(initialBanner);
      
      var prefsBanner = document.createElement("div");
      prefsBanner.className = "cb-banner";
      prefsBanner.id = "cb-preferences-banner";
      prefsBanner.style.display = "none";
      
      // Apply preference banner position class
      if (PREFERENCE_POSITION === 'left') {
        prefsBanner.classList.add('prefs-left');
      } else if (PREFERENCE_POSITION === 'right') {
        prefsBanner.classList.add('prefs-right');
      } else {
        prefsBanner.classList.add('prefs-center');
      }
      
      var prefsBody = document.createElement("div");
      prefsBody.className = "cb-banner-body";
      var prefsH3 = document.createElement("h3");
      prefsH3.textContent = getTranslation('cookiePreferences');
      prefsBody.appendChild(prefsH3);
      var prefsP = document.createElement("p");
      var prefsPText = (getTranslation('managePreferences') || "").replace(/\s*More info\.?\s*$/i, "").trim();
      
      if (PRIVACY_POLICY_URL && isCookiePolicyLinkEnabled()) {
        prefsP.appendChild(document.createTextNode(prefsPText + " "));
        var linkPrefs = document.createElement("a");
        linkPrefs.textContent = getTranslation('privacyPolicy');
        linkPrefs.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
        attachPrivacyPolicyLink(linkPrefs, PRIVACY_POLICY_URL);
        prefsP.appendChild(linkPrefs);
        prefsP.appendChild(document.createTextNode("."));
      } else {
        prefsP.textContent = prefsPText;
      }
      prefsBody.appendChild(prefsP);

      var catList = document.createElement("div");
      catList.className = "cb-gdpr-accordion";
      catList.style.cssText =
        "border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";
      var snLabel = getTranslation("strictlyNecessary") || getTranslation("essential");
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: snLabel,
          alwaysActive: true,
          descText: getTranslation("essentialDescription"),
        })
      );
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: getTranslation("marketing"),
          checkboxId: "cb-pref-marketing",
          defaultChecked: true,
          descText: getTranslation("marketingDescription"),
        })
      );
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: getTranslation("analytics"),
          checkboxId: "cb-pref-analytics",
          defaultChecked: false,
          descText: getTranslation("analyticsDescription"),
        })
      );
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: getTranslation("preferences"),
          checkboxId: "cb-pref-preferences",
          defaultChecked: false,
          descText: getTranslation("preferencesDescription"),
        })
      );
      if (catList.lastChild) catList.lastChild.style.borderBottom = "none";
      prefsBody.appendChild(catList);
      prefsBanner.appendChild(prefsBody);
      
      var prefsFooter = document.createElement("div");
      prefsFooter.className = "cb-banner-footer";
      var backGdprBtn = document.createElement("button");
      backGdprBtn.id = "cb-back-btn";
      backGdprBtn.textContent = getTranslation("rejectAll");
      prefsFooter.appendChild(backGdprBtn);
      var saveBtn = document.createElement("button");
      saveBtn.id = "cb-save-prefs-btn";
      saveBtn.textContent = getTranslation("save");
      prefsFooter.appendChild(saveBtn);
      prefsBanner.appendChild(prefsFooter);
      appendPrefsCloseButton(prefsBanner);
      wrapper.appendChild(prefsBanner);
    }

    document.body.appendChild(wrapper);
    console.log('[ConsentBit] Banner rendered and appended to body');
    
    // Stop scroll if enabled
    if (STOP_SCROLL) {
      document.body.style.overflow = 'hidden';
      console.log('[ConsentBit] Scroll stopped while banner is visible');
    }
    
    // Ensure banner is visible and apply animation
    var initialBannerEl = document.getElementById("cb-initial-banner");
    if (initialBannerEl) {
      initialBannerEl.style.display = "flex";
      initialBannerEl.style.visibility = "visible";
      initialBannerEl.style.opacity = "1";
      
      // Apply animation based on position
      if (ANIMATION_ENABLED) {
        var position = CUSTOMIZATION ? CUSTOMIZATION.position : 'bottom-left';
        var animClass = '';
        
        if (position === 'bottom-left' || position === 'left') {
          animClass = 'cb-banner-animate-left';
        } else if (position === 'bottom-right' || position === 'right') {
          animClass = 'cb-banner-animate-right';
        } else if (position === 'top') {
          animClass = 'cb-banner-animate-top';
        } else if (position === 'bottom' || position === 'center') {
          animClass = 'cb-banner-animate-bottom';
        } else {
          animClass = 'cb-banner-animate-fade';
        }
        
        initialBannerEl.classList.add(animClass);
        console.log('[ConsentBit] Applied animation class:', animClass);
      }
      
      console.log('[ConsentBit] Banner display set to flex, visibility visible');
    } else {
      console.error('[ConsentBit] Failed to find banner element after creation!');
    }
  }

  function restoreScroll() {
    if (STOP_SCROLL) {
      document.body.style.overflow = '';
      console.log('[ConsentBit] Scroll restored');
    }
  }

  function isFloatingButtonEnabled() {
    try {
      var lang = getBannerLanguage();
      var row = TRANSLATIONS[lang] || TRANSLATIONS['en'] || {};
      var v = row['floatingButtonEnabled'];
      if (v === false) return false;
      if (v === '0') return false;
      if (String(v).toLowerCase() === 'false') return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function getFloatingButtonPosition() {
    try {
      var lang = getBannerLanguage();
      var row = TRANSLATIONS[lang] || TRANSLATIONS['en'] || {};
      return row['floatingButtonPosition'] === 'right' ? 'right' : 'left';
    } catch (e2) {
      return 'left';
    }
  }

  /** Inline SVG — avoids <img src="data:..."> which many CSPs block via img-src. High-contrast cookie icon. */
  function createFloatingTriggerIconSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('xmlns', ns);
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText =
      'display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none;';
    var circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', '20');
    circle.setAttribute('cy', '20');
    circle.setAttribute('r', '18');
    circle.setAttribute('fill', '#007aff');
    svg.appendChild(circle);
    var chips = [
      { cx: '14', cy: '14', r: '2.2' },
      { cx: '24', cy: '18', r: '2.5' },
      { cx: '17', cy: '25', r: '2' }
    ];
    for (var ci = 0; ci < chips.length; ci++) {
      var ch = document.createElementNS(ns, 'circle');
      ch.setAttribute('cx', chips[ci].cx);
      ch.setAttribute('cy', chips[ci].cy);
      ch.setAttribute('r', chips[ci].r);
      ch.setAttribute('fill', '#ffffff');
      svg.appendChild(ch);
    }
    return svg;
  }

  /** When siteConfig omits floatingLogoUrl (cached script), derive Worker origin from this script tag. */
  function getConsentbitScriptOrigin() {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var si = scripts.length - 1; si >= 0; si--) {
        var src = scripts[si].src || '';
        if (src.indexOf('/consentbit/') !== -1 || src.indexOf('/client_data/') !== -1) {
          return new URL(src).origin;
        }
      }
    } catch (e0) {}
    return '';
  }

  function injectFloatingButton() {
    if (document.getElementById('cb-floating-trigger')) return;
    if (!isFloatingButtonEnabled()) return;

    var pos = getFloatingButtonPosition();
    var logoUrl = FLOATING_LOGO_URL || '';
    var fallbackLogo = FLOATING_LOGO_FALLBACK_URL || '';
    if (!logoUrl) {
      var embedOrigin = getConsentbitScriptOrigin();
      if (embedOrigin) {
        logoUrl = embedOrigin + '/embed/floating-logo.svg';
        if (!fallbackLogo) fallbackLogo = logoUrl;
      }
    }

    var btn = document.createElement('button');
    btn.id = 'cb-floating-trigger';
    btn.type = 'button';
    btn.setAttribute('aria-label', getTranslation('cookiePreferences'));
    btn.style.cssText =
      'position:fixed;bottom:16px;' +
      (pos === 'right' ? 'right:16px;' : 'left:16px;') +
      'z-index:2147483646;width:40px;height:40px;border:1px solid #e2e8f0;border-radius:9999px;' +
      'background:#ffffff;cursor:pointer;padding:0;box-shadow:0 4px 14px rgba(15,23,42,0.12);';

    if (logoUrl) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = logoUrl;
      img.setAttribute('width', '28');
      img.setAttribute('height', '28');
      img.draggable = false;
      img.style.cssText =
        'display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none;';
      var imgTriedWorkerFallback = false;
      img.addEventListener('error', function onImgErr() {
        if (
          !imgTriedWorkerFallback &&
          fallbackLogo &&
          logoUrl !== fallbackLogo
        ) {
          imgTriedWorkerFallback = true;
          img.src = fallbackLogo;
          return;
        }
        img.removeEventListener('error', onImgErr);
        if (img.parentNode) {
          img.parentNode.replaceChild(createFloatingTriggerIconSvg(), img);
        }
      });
      btn.appendChild(img);
    } else {
      btn.appendChild(createFloatingTriggerIconSvg());
    }

    // Click handler is attached in initConsentBitBannerUI so the floating button opens the initial banner (not prefs).

    document.body.appendChild(btn);
    console.log('[ConsentBit] Floating preferences control injected');
  }

  var PREF_ANIM_CLASSES =
    'cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade ' +
    'cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom';

  function getPreferenceBannerAnimClass() {
    if (!ANIMATION_ENABLED) return '';
    if (PREFERENCE_POSITION === 'left') {
      return 'cb-banner-animate-prefs-left';
    }
    if (PREFERENCE_POSITION === 'right') {
      return 'cb-banner-animate-prefs-right';
    }
    if (PREFERENCE_POSITION === 'center') {
      if (CENTER_ANIMATION_DIRECTION === 'top') {
        return 'cb-banner-animate-center-top';
      }
      if (CENTER_ANIMATION_DIRECTION === 'bottom') {
        return 'cb-banner-animate-center-bottom';
      }
      return 'cb-banner-animate-fade';
    }
    return 'cb-banner-animate-fade';
  }

  function stripPrefAnimClasses(el) {
    if (!el) return;
    var parts = PREF_ANIM_CLASSES.split(' ');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) el.classList.remove(parts[i]);
    }
  }

  function initConsentBitBannerUI() {
    injectConsentBitStyles();
    renderConsentBitBanners();
    injectFloatingButton();

    var initialBanner = document.getElementById("cb-initial-banner");
    var prefsBanner   = document.getElementById("cb-preferences-banner");

    var btnPrefs      = document.getElementById("cb-preferences-btn");
    var btnAcceptAll  = document.getElementById("cb-accept-all-btn");
    var btnRejectAll  = document.getElementById("cb-reject-all-btn");
    var btnBack       = document.getElementById("cb-back-btn");
    var btnSave       = document.getElementById("cb-save-prefs-btn");
    var linkDoNotSell = document.getElementById("cb-ccpa-donotsell-link");
    var isCCPA        = BANNER_TYPE === 'ccpa';

    function hideAll() {
      if (initialBanner) {
        initialBanner.style.display = "none";
        initialBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade');
      }
      if (prefsBanner) {
        prefsBanner.style.display = "none";
        stripPrefAnimClasses(prefsBanner);
      }
      // Restore scroll when banner is hidden
      restoreScroll();
    }

    /** Re-open main cookie banner (used by floating trigger). Hides preference panel. */
    function showInitialBanner() {
      if (!initialBanner) return;
      if (prefsBanner) {
        prefsBanner.style.display = "none";
        stripPrefAnimClasses(prefsBanner);
      }
      initialBanner.style.display = "flex";
      initialBanner.style.visibility = "visible";
      initialBanner.style.opacity = "1";
      initialBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade');
      if (ANIMATION_ENABLED) {
        var position = CUSTOMIZATION ? CUSTOMIZATION.position : 'bottom-left';
        var animClass = '';
        if (position === 'bottom-left' || position === 'left') {
          animClass = 'cb-banner-animate-left';
        } else if (position === 'bottom-right' || position === 'right') {
          animClass = 'cb-banner-animate-right';
        } else if (position === 'top') {
          animClass = 'cb-banner-animate-top';
        } else if (position === 'bottom' || position === 'center') {
          animClass = 'cb-banner-animate-bottom';
        } else {
          animClass = 'cb-banner-animate-fade';
        }
        initialBanner.classList.add(animClass);
      }
      if (STOP_SCROLL) {
        document.body.style.overflow = 'hidden';
      }
      console.log('[ConsentBit] Initial banner shown (e.g. floating trigger)');
    }

    var floatBtn = document.getElementById('cb-floating-trigger');
    if (floatBtn) {
      floatBtn.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev && ev.stopPropagation) ev.stopPropagation();
        showInitialBanner();
      });
    }

    btnPrefs && btnPrefs.addEventListener("click", function () {
      if (!initialBanner || !prefsBanner) return;
      initialBanner.style.display = "none";
      initialBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade');
      
      // Show preference banner with animation (keyframes preserve center/side transforms)
      prefsBanner.style.display = "flex";
      prefsBanner.style.visibility = "visible";
      prefsBanner.style.opacity = "1";
      stripPrefAnimClasses(prefsBanner);
      var prefAnim = getPreferenceBannerAnimClass();
      if (prefAnim) {
        prefsBanner.classList.add(prefAnim);
        console.log('[ConsentBit] Applied preference banner animation:', prefAnim);
      }
    });

    // CCPA: Cancel · GDPR prefs: Reject label — dismiss all UI (do not return to initial banner)
    btnBack && btnBack.addEventListener("click", function () {
      hideAll();
    });

    var btnCloseInitial = document.getElementById("cb-close-initial-btn");
    var btnClosePrefs = document.getElementById("cb-close-prefs-btn");
    btnCloseInitial && btnCloseInitial.addEventListener("click", function () {
      hideAll();
    });
    btnClosePrefs && btnClosePrefs.addEventListener("click", function () {
      hideAll();
    });

    if (isCCPA && linkDoNotSell) {
      linkDoNotSell.addEventListener("click", function () {
        if (initialBanner && prefsBanner) {
          initialBanner.style.display = "none";
          prefsBanner.style.display = "flex";
          prefsBanner.style.visibility = "visible";
          prefsBanner.style.opacity = "1";
          stripPrefAnimClasses(prefsBanner);
          var prefAnimCcpa = getPreferenceBannerAnimClass();
          if (prefAnimCcpa) {
            prefsBanner.classList.add(prefAnimCcpa);
          }
        }
      });
    }

    // Reject All (GDPR only)
    btnRejectAll && btnRejectAll.addEventListener("click", function () {
      console.log("[ConsentBit] User clicked Reject All");
      if (!isCCPA) {
        var consentR = {
          accepted: true,
          timestamp: new Date().toISOString(),
          categories: {
            essential: true,
            analytics: false,
            preferences: false,
            marketing: false
          }
        };
        saveConsent(consentR);
        sendConsentToServer(consentR, { status: 'rejected' });
        setTimeout(sendCookiesToBackend, 500);
        // Initialize GA for cookieless tracking (anonymous visitor count)
        if (GA_MEASUREMENT_ID) {
          if (!window.gtag) {
            initGoogleConsentMode();
          } else {
            // Update consent to denied and send pageview
            window.gtag('consent', 'update', {
              analytics_storage: 'denied',
              ad_storage: 'denied',
              ad_user_data: 'denied',
              ad_personalization: 'denied',
            });
            window.gtag('event', 'page_view', {
              page_path: window.location.pathname,
              page_title: document.title || '',
            });
          }
        }
      }
      hideAll();
    });

    // Accept / OK
    btnAcceptAll && btnAcceptAll.addEventListener("click", function () {
      console.log("[ConsentBit] User clicked Accept / OK");
      if (isCCPA) {
        var consent = {
          accepted: true,
          timestamp: new Date().toISOString(),
          ccpa: {
            doNotSell: false,
          },
        };
        saveConsent(consent);
        sendConsentToServer(consent, { status: 'given' });
        setTimeout(sendCookiesToBackend, 500);
        enableDelayedScripts();
        // enableDelayedFonts({ analytics: true, marketing: true });
        // enableDelayedEmbeds({ analytics: true, marketing: true });
      } else {
        var consentG = {
          accepted: true,
          timestamp: new Date().toISOString(),
          categories: {
            essential: true,
            analytics: true,
            preferences: true,
            marketing: true
          }
        };
        saveConsent(consentG);
        sendConsentToServer(consentG, { status: 'given' });
        setTimeout(sendCookiesToBackend, 500);
        enableDelayedScripts();
        // enableDelayedFonts(consentG.categories);
        // enableDelayedEmbeds(consentG.categories);
        if (hasGoogleTracking()) {
          grantGoogleConsent();
        }
      }
      hideAll();
    });

    // Save preferences
    btnSave && btnSave.addEventListener("click", function () {
      console.log("[ConsentBit] User clicked Save");
      if (isCCPA) {
        var optoutEl = document.getElementById("cb-ccpa-optout");
        var optout = !!(optoutEl && optoutEl.checked);
        var consentC = {
          accepted: true,
          timestamp: new Date().toISOString(),
          ccpa: {
            doNotSell: optout,
          },
        };
        saveConsent(consentC);
        sendConsentToServer(consentC, { status: 'partial' });
        setTimeout(sendCookiesToBackend, 500);
        if (!optout) {
          enableDelayedScripts();
          // enableDelayedFonts({ analytics: true, marketing: true });
          // enableDelayedEmbeds({ analytics: true, marketing: true });
        }
      } else {
        var elAnalytics = document.getElementById("cb-pref-analytics");
        var elPreferences = document.getElementById("cb-pref-preferences");
        var elMarketing = document.getElementById("cb-pref-marketing");
        var consentG = {
          accepted: true,
          timestamp: new Date().toISOString(),
          categories: {
            essential: true,
            analytics: !!(elAnalytics && elAnalytics.checked),
            preferences: !!(elPreferences && elPreferences.checked),
            marketing: !!(elMarketing && elMarketing.checked)
          }
        };
        saveConsent(consentG);
        sendConsentToServer(consentG, { status: 'partial' });
        setTimeout(sendCookiesToBackend, 500);
        enableDelayedScripts();
        // enableDelayedFonts(consentG.categories);
        // enableDelayedEmbeds(consentG.categories);
        if (consentG.categories.analytics) {
          // Analytics accepted - enable full GA tracking
          if (GA_MEASUREMENT_ID) {
            if (!window.gtag) {
              initGoogleConsentMode();
              setTimeout(function() {
                if (window.gtag) {
                  grantGoogleConsent();
                }
              }, 100);
            } else {
              grantGoogleConsent();
            }
          } else if (hasGoogleTracking()) {
            grantGoogleConsent();
          }
        } else {
          // Analytics not accepted - ensure cookieless tracking
          if (GA_MEASUREMENT_ID) {
            if (!window.gtag) {
              initGoogleConsentMode();
            } else {
              // Update consent to denied
              window.gtag('consent', 'update', {
                analytics_storage: 'denied',
                ad_storage: 'denied',
                ad_user_data: 'denied',
                ad_personalization: 'denied',
              });
            }
          }
        }
      }
      hideAll();
    });
  }

  function showBanner() {
    console.log("[ConsentBit] Showing banner for", BANNER_TYPE);
    console.log("[ConsentBit] Consent state:", consentState);
    console.log("[ConsentBit] Document ready state:", document.readyState);
    console.log("[ConsentBit] Document body exists:", !!document.body);
    initConsentBitBannerUI();
  }


  function init() {
    console.log('[ConsentBit] Init start');
    var hasGoogle = hasGoogleTracking();

    if (BANNER_TYPE === 'gdpr') {
      // GDPR: Initialize GA for cookieless tracking when banner loads (before consent)
      // This allows anonymous visitor count tracking without cookies
      if (GA_MEASUREMENT_ID) {
        initGoogleConsentMode(); // Sets consent to denied, enables cookieless tracking
      }

      if (!consentState.accepted) {
        // Block other analytics scripts, but GA is already initialized for cookieless tracking
        blockNonEssentialScripts();
        // blockEmbeds();
        // blockGoogleFonts();
      } else if (hasGoogle || GA_MEASUREMENT_ID) {
        console.log('[ConsentBit] Consent already accepted from previous visit, upgrading Google consent');
        // User previously accepted - enable full tracking
        if (GA_MEASUREMENT_ID && window.gtag) {
          grantGoogleConsent();
        } else if (GA_MEASUREMENT_ID) {
          // Initialize GA with granted consent
          initGoogleConsentMode();
          setTimeout(function() {
            if (window.gtag) {
              grantGoogleConsent();
            }
          }, 100);
        }
      }
    }

    console.log('[ConsentBit] Checking if banner should show:', {
      consentAccepted: consentState.accepted,
      bannerType: BANNER_TYPE,
      shouldShow: !consentState.accepted
    });
    
    // Show banner if consent not given (works for both GDPR and CCPA)
    if (!consentState.accepted) {
      console.log('[ConsentBit] Calling showBanner()');
      showBanner();
    } else {
      console.log('[ConsentBit] Banner not shown - consent already accepted');
    }

    // Track a pageview for this site (used for billing/usage)
    try {
      sendPageviewToServer();
    } catch (e) {
      console.warn('[ConsentBit] sendPageviewToServer threw', e);
    }

    // Listen for footer link clicks using data attribute
    // Customers can add data-consentbit-trigger to any link/button to trigger banner
    function initFooterLinkHandler() {
      // Use event delegation to handle dynamically added links
      document.addEventListener('click', function(e) {
        var target = e.target;
        // Check if clicked element or its parent has the trigger attribute
        while (target && target !== document.body) {
          if (target.hasAttribute && target.hasAttribute('data-consentbit-trigger')) {
            e.preventDefault();
            e.stopPropagation();
            
            // Clear any existing consent to force banner display
            try {
              localStorage.removeItem(CONSENT_KEY);
              consentState = { accepted: false, timestamp: null };
            } catch (err) {
              console.warn('[ConsentBit] Failed to clear consent:', err);
            }
            
            // Check if banner already exists
            var existingBanner = document.getElementById('cb-initial-banner');
            if (existingBanner) {
              // Banner exists, just show it
              existingBanner.style.display = 'flex';
              existingBanner.style.visibility = 'visible';
              existingBanner.style.opacity = '1';
              
              // Stop scroll if enabled
              if (STOP_SCROLL) {
                document.body.style.overflow = 'hidden';
              }
              
              // Scroll to banner
              existingBanner.scrollIntoView({ behavior: 'smooth', block: 'start' });
              console.log('[ConsentBit] Footer link clicked - showing existing banner');
            } else {
              // Banner doesn't exist, create and show it
              showBanner();
              
              // Wait for banner to render, then scroll to it
              setTimeout(function() {
                var banner = document.getElementById('cb-initial-banner');
                if (banner) {
                  banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }, 100);
              
              console.log('[ConsentBit] Footer link clicked - creating and showing banner');
            }
            
            return false;
          }
          target = target.parentElement;
        }
      }, true); // Use capture phase for better event handling
      
      console.log('[ConsentBit] Footer link handler initialized - listening for data-consentbit-trigger');
    }
    
    // Initialize footer link handler when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initFooterLinkHandler);
    } else {
      initFooterLinkHandler();
    }

    // Send cookies to backend (categorization and storage happen server-side)
    setTimeout(sendCookiesToBackend, 2000);

    console.log('[ConsentBit] Init complete');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();`;

  return new Response(loader, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Shorter cache so published banner copy/styles reach sites sooner (still edge-cacheable).
      'Cache-Control': 'public, max-age=120, must-revalidate',
    },
  });
}
