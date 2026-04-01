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
        "width:480px;" +
        "max-width:90vw;" +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        positionStyles +
        "padding:20px;" +
        "border:1px solid #e2e8f0;" +
        "border-radius:" + bannerRadius + ";" +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        "font-size:12px;" +
      "}" +
      "#cb-preferences-banner.cb-banner{" +
        "width:500px;" +
        "max-width:90vw;" +
        "max-height:80vh;" +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        "top:50%;" +
        "left:50%;" +
        "transform:translate(-50%,-50%);" +
        "padding:24px;" +
        "border:1px solid #e2e8f0;" +
        "border-radius:" + bannerRadius + ";" +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        "font-size:12px;" +
      "}" +
      ".cb-banner h3{" +
        "margin:0 0 8px;" +
        "font-size:14px;" +
        "font-weight:600;" +
        "color:" + headingColor + ";" +
      "}" +
      ".cb-banner p{" +
        "margin:0 0 12px;" +
        "font-size:11px;" +
        "line-height:1.4;" +
        "color:" + textColor + ";" +
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
        "background-color:" + (customization.acceptButtonBg || '#0284c7') + ";" +
        "color:" + (customization.acceptButtonText || '#ffffff') + ";" +
        "border-color:" + (customization.acceptButtonBg || '#0284c7') + ";" +
      "}" +
      ".cb-banner button#cb-reject-all-btn{" +
        "background-color:" + (customization.rejectButtonBg || '#ffffff') + ";" +
        "color:" + (customization.rejectButtonText || '#334155') + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      ".cb-banner button#cb-preferences-btn," +
      ".cb-banner button#cb-back-btn," +
      ".cb-banner button#cb-save-prefs-btn," +
      ".cb-banner button#cb-ccpa-donotsell-link{" +
        "background-color:" + (customization.customiseButtonBg || '#ffffff') + ";" +
        "color:" + (customization.customiseButtonText || '#334155') + ";" +
        "border-color:#e2e8f0;" +
      "}";
  }

  const inlineConfig = `
    window.__CONSENT_SITE__ = {
      id: ${JSON.stringify(resolvedSite.id)},
      bannerType: ${JSON.stringify(effectiveBannerType)},
      apiBase: ${JSON.stringify(apiBase)},
      gaId: ${JSON.stringify(GA_ID)},
      styles: ${customStyles ? JSON.stringify(customStyles) : 'null'},
      customization: ${customization ? JSON.stringify({
        position: customization.position,
        privacyPolicyUrl: customization.privacyPolicyUrl,
        stopScroll: customization.stopScroll === 1,
        footerLink: customization.footerLink === 1,
        animationEnabled: customization.animationEnabled === 1,
        preferencePosition: customization.preferencePosition || 'right',
        centerAnimationDirection: customization.centerAnimationDirection || 'bottom',
        language: customization.language || 'en',
        autoDetectLanguage: customization.autoDetectLanguage === 1,
        cookieExpirationDays: customization.cookieExpirationDays != null ? customization.cookieExpirationDays : 30,
      }) : 'null'}
    };
  `;

  const storedTranslations = customization?.translations
    ? (typeof customization.translations === 'string' ? JSON.parse(customization.translations) : customization.translations)
    : null;
  const translationsForScript = mergeTranslations(storedTranslations);
  const translationsVar = `var TRANSLATIONS = ${JSON.stringify(translationsForScript)};`;

  const loader = `
${inlineConfig}
(function () {
  var siteConfig = window.__CONSENT_SITE__ || {};
  var SITE_ID = siteConfig.id || null;
  var BANNER_TYPE = siteConfig.bannerType || 'gdpr';
  var API_BASE = siteConfig.apiBase;
  var GA_MEASUREMENT_ID = siteConfig.gaId || null;
  var CUSTOMIZATION = siteConfig.customization || null;
  var PRIVACY_POLICY_URL = CUSTOMIZATION ? CUSTOMIZATION.privacyPolicyUrl : null;
  var STOP_SCROLL = CUSTOMIZATION ? CUSTOMIZATION.stopScroll : false;
  var ANIMATION_ENABLED = CUSTOMIZATION ? (CUSTOMIZATION.animationEnabled !== false) : true;
  var PREFERENCE_POSITION = CUSTOMIZATION ? (CUSTOMIZATION.preferencePosition || 'right') : 'right';
  var CENTER_ANIMATION_DIRECTION = CUSTOMIZATION ? (CUSTOMIZATION.centerAnimationDirection || 'bottom') : 'bottom';
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

  console.log('[ConsentBit] Loader init', { SITE_ID, BANNER_TYPE, API_BASE, GA_MEASUREMENT_ID, CUSTOMIZATION });

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
      /* Compliance: YouTube/Maps, Google Fonts, Webflow - uncomment to re-enable
      if (
        host.indexOf('youtube.com') !== -1 ||
        host.indexOf('youtube-nocookie.com') !== -1 ||
        host.indexOf('ytimg.com') !== -1 ||
        (host.indexOf('google.com') !== -1 && src.indexOf('maps') !== -1) ||
        (host.indexOf('googleapis.com') !== -1 && src.indexOf('maps') !== -1)
      ) {
        return 'marketing';
      }
      if (
        host.indexOf('fonts.googleapis.com') !== -1 ||
        host.indexOf('fonts.gstatic.com') !== -1
      ) {
        return 'analytics';
      }
      if (
        host.indexOf('webflow.com') !== -1 ||
        host.indexOf('webflow.io') !== -1
      ) {
        return 'analytics';
      }
      */
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
    /* Compliance: block uncategorized by default - uncomment to re-enable
    return category === 'analytics' || category === 'marketing' || category === 'behavioral' || category === 'uncategorized';
    */
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

  /* --- Compliance: YouTube/Maps embeds + Google Fonts blocking (uncomment to re-enable) ---
  var delayedIframes = [];
  function copyIframeAttrsToPlaceholder(iframe, placeholder) {
    var attrs = {};
    for (var a = 0; a < iframe.attributes.length; a++) {
      var attr = iframe.attributes[a];
      if (attr.name.indexOf('data-consentbit') === 0) continue;
      attrs[attr.name] = attr.value;
    }
    if (iframe.style && iframe.style.cssText) attrs.style = iframe.style.cssText;
    placeholder.setAttribute('data-consentbit-iframe-attrs', JSON.stringify(attrs));
  }
  function restoreIframeFromPlaceholder(p) {
    var attrsJson = p.getAttribute('data-consentbit-iframe-attrs');
    var srcFallback = p.getAttribute('data-consentbit-original-src');
    var el = document.createElement('iframe');
    if (attrsJson) {
      try {
        var attrs = JSON.parse(attrsJson);
        for (var key in attrs) {
          if (key === 'class') el.setAttribute('class', attrs[key]);
          else if (key === 'allowfullscreen' && attrs[key] !== false && attrs[key] !== 'false') el.setAttribute('allowfullscreen', '');
          else if (key === 'style' && attrs[key]) el.style.cssText = attrs[key];
          else if (attrs[key] != null && attrs[key] !== '') el.setAttribute(key, attrs[key]);
        }
      } catch (e) {
        if (srcFallback) el.setAttribute('src', srcFallback);
      }
    }
    var width = p.getAttribute('data-consentbit-width');
    var height = p.getAttribute('data-consentbit-height');
    if (width) el.setAttribute('width', width);
    if (height) el.setAttribute('height', height);
    if (!el.getAttribute('src') && srcFallback) el.setAttribute('src', srcFallback);
    return el;
  }
  function blockEmbeds() {
    if (consentState.accepted) return;
    var iframes = document.querySelectorAll('iframe[src]');
    for (var i = 0; i < iframes.length; i++) {
      var iframe = iframes[i];
      var src = (iframe.getAttribute('src') || '').trim();
      if (!src || src === 'about:blank') continue;
      var isYoutube = src.indexOf('youtube.com') !== -1 || src.indexOf('youtube-nocookie.com') !== -1 || src.indexOf('youtu.be') !== -1;
      var isMaps = src.indexOf('google.com/maps') !== -1 || src.indexOf('googleapis.com') !== -1 && src.indexOf('/maps') !== -1;
      if (!isYoutube && !isMaps) continue;
      var placeholder = document.createElement('div');
      placeholder.className = 'cb-embed-placeholder' + (iframe.className ? ' ' + iframe.className : '');
      if (iframe.id) placeholder.id = iframe.id;
      placeholder.setAttribute('data-consentbit-original-src', src);
      copyIframeAttrsToPlaceholder(iframe, placeholder);
      var w = iframe.getAttribute('width') || (iframe.style && iframe.style.width) || '';
      var h = iframe.getAttribute('height') || (iframe.style && iframe.style.height) || '';
      if (w) placeholder.setAttribute('data-consentbit-width', w);
      if (h) placeholder.setAttribute('data-consentbit-height', h);
      placeholder.setAttribute('data-consentbit-embed-type', isYoutube ? 'youtube' : 'maps');
      placeholder.style.cssText = (iframe.style && iframe.style.cssText ? iframe.style.cssText : '') + ';min-width:200px;min-height:150px;display:flex;align-items:center;justify-content:center;background:#f1f5f9;color:#64748b;font-size:14px;cursor:pointer;border:1px solid #e2e8f0;';
      placeholder.innerHTML = '<span style="padding:12px;">' + (isYoutube ? 'Load video' : 'Load map') + ' (consent required)</span>';
      placeholder.addEventListener('click', function () {
        if (!consentState.accepted) return;
        var newIframe = restoreIframeFromPlaceholder(this);
        this.parentNode.replaceChild(newIframe, this);
      });
      iframe.parentNode.replaceChild(placeholder, iframe);
      delayedIframes.push({ placeholder: placeholder, src: src, isYoutube: isYoutube });
      console.log('[ConsentBit] Blocked embed until consent', src);
    }
  }
  function enableDelayedEmbeds(consentCategories) {
    var allow = consentCategories && (consentCategories.marketing === true);
    if (!allow) return;
    var placeholders = document.querySelectorAll('.cb-embed-placeholder[data-consentbit-original-src]');
    for (var i = 0; i < placeholders.length; i++) {
      var p = placeholders[i];
      var newIframe = restoreIframeFromPlaceholder(p);
      p.parentNode.replaceChild(newIframe, p);
      console.log('[ConsentBit] Enabled embed', p.getAttribute('data-consentbit-original-src'));
    }
    delayedIframes = [];
  }
  var delayedFontLinks = [];
  function blockGoogleFonts() {
    if (consentState.accepted) return;
    var links = document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"], link[rel="stylesheet"][href*="fonts.gstatic.com"], link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href') || '';
      if (!href || link.getAttribute('data-consentbit-blocked') === '1') continue;
      link.setAttribute('data-consentbit-blocked', '1');
      link.setAttribute('data-consentbit-original-href', href);
      link.removeAttribute('href');
      delayedFontLinks.push(link);
      console.log('[ConsentBit] Blocked Google Fonts until consent', href);
    }
  }
  function enableDelayedFonts(consentCategories) {
    var allow = consentCategories && (consentCategories.analytics === true);
    if (!allow) return;
    for (var i = 0; i < delayedFontLinks.length; i++) {
      var link = delayedFontLinks[i];
      var href = link.getAttribute('data-consentbit-original-href');
      if (href) {
        link.setAttribute('href', href);
        link.removeAttribute('data-consentbit-blocked');
        link.removeAttribute('data-consentbit-original-href');
        console.log('[ConsentBit] Enabled Google Fonts', href);
      }
    }
    delayedFontLinks = [];
  }
  if (typeof document !== 'undefined' && document.scripts && !consentState.accepted) {
    blockNonEssentialScripts();
    console.log('[ConsentBit] Early script blocking applied (load this script first in head for best compliance)');
  }
  --- */

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
      "width:480px;" +
      "max-width:90vw;" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "position:fixed;" +
      "bottom:32px;" +
      "left:32px;" +
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
    "#cb-preferences-banner.cb-banner{" +
      "width:500px;" +
      "max-width:90vw;" +
      "max-height:80vh;" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "position:fixed;" +
      "top:50%;" +
      "left:50%;" +
      "transform:translate(-50%,-50%);" +
      "padding:24px;" +
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
      "gap:8px;" +
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
    ".cb-banner button:hover{" +
      "opacity:0.8;" +
    "}" +
    ".cb-banner button#cb-accept-all-btn{" +
      "background-color:#0284c7;" +
      "color:#ffffff;" +
      "border-color:#0284c7;" +
    "}" +
    ".cb-banner button#cb-reject-all-btn{" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "border-color:#e2e8f0;" +
    "}" +
    ".cb-banner button#cb-preferences-btn," +
    ".cb-banner button#cb-back-btn," +
    ".cb-banner button#cb-save-prefs-btn," +
    ".cb-banner button#cb-ccpa-donotsell-link{" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "border-color:#e2e8f0;" +
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
      "color:#2563eb;" +
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
    "}";

  if (siteConfig.styles) {
    BANNER_STYLES = siteConfig.styles;
  }

  function injectConsentBitStyles() {
    if (document.getElementById("cb-styles")) {
      console.log('[ConsentBit] Styles already injected');
      return;
    }

    var style = document.createElement("style");
    style.id = "cb-styles";
    style.type = "text/css";
    style.appendChild(document.createTextNode(BANNER_STYLES));
    document.head.appendChild(style);
    console.log('[ConsentBit] Styles injected into head');
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
      
      if (PRIVACY_POLICY_URL) {
        // Add privacy policy link inline at the end of the sentence
        p.appendChild(document.createTextNode(pText + " "));
        var link = document.createElement("a");
        link.href = PRIVACY_POLICY_URL;
        link.target = "_blank";
        link.textContent = getTranslation('privacyPolicy');
        link.style.cssText = "color:#2563eb;text-decoration:underline;cursor:pointer;";
        p.appendChild(link);
        p.appendChild(document.createTextNode("."));
      } else {
        p.textContent = pText;
      }
      bodyDiv.appendChild(p);
      
      initialBanner.appendChild(bodyDiv);
      
      var footerDiv = document.createElement("div");
      footerDiv.className = "cb-banner-footer";
      var acceptBtn = document.createElement("button");
      acceptBtn.id = "cb-accept-all-btn";
      acceptBtn.textContent = getTranslation('acceptAll');
      footerDiv.appendChild(acceptBtn);
      var doNotSellBtn = document.createElement("button");
      doNotSellBtn.id = "cb-ccpa-donotsell-link";
      doNotSellBtn.textContent = getTranslation('doNotSell');
      footerDiv.appendChild(doNotSellBtn);
      initialBanner.appendChild(footerDiv);
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
      var prefsPText = getTranslation('ccpaDescription');
      
      if (PRIVACY_POLICY_URL) {
        // Add privacy policy link inline at the end of the sentence
        prefsP.appendChild(document.createTextNode(prefsPText + " "));
        var linkPrefs = document.createElement("a");
        linkPrefs.href = PRIVACY_POLICY_URL;
        linkPrefs.target = "_blank";
        linkPrefs.textContent = getTranslation('privacyPolicy');
        linkPrefs.style.cssText = "color:#2563eb;text-decoration:underline;cursor:pointer;";
        prefsP.appendChild(linkPrefs);
        prefsP.appendChild(document.createTextNode("."));
      } else {
        prefsP.textContent = prefsPText;
      }
      prefsBody.appendChild(prefsP);
      
      // Add CCPA opt-out description
      var optOutDesc = document.createElement("p");
      optOutDesc.style.marginTop = "8px";
      optOutDesc.style.marginBottom = "8px";
      optOutDesc.style.fontSize = "11px";
      optOutDesc.textContent = getTranslation('ccpaOptOut');
      prefsBody.appendChild(optOutDesc);
      
      var label = document.createElement("label");
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "cb-ccpa-optout";
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(" " + getTranslation('doNotSell')));
      prefsBody.appendChild(label);
      prefsBanner.appendChild(prefsBody);
      
      var prefsFooter = document.createElement("div");
      prefsFooter.className = "cb-banner-footer";
      var backBtn = document.createElement("button");
      backBtn.id = "cb-back-btn";
      backBtn.textContent = getTranslation('back');
      prefsFooter.appendChild(backBtn);
      var saveBtn = document.createElement("button");
      saveBtn.id = "cb-save-prefs-btn";
      saveBtn.textContent = getTranslation('save');
      prefsFooter.appendChild(saveBtn);
      prefsBanner.appendChild(prefsFooter);
      wrapper.appendChild(prefsBanner);
    } else {
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
      
      if (PRIVACY_POLICY_URL) {
        // Add privacy policy link inline at the end of the sentence
        p.appendChild(document.createTextNode(pText + " "));
        var link = document.createElement("a");
        link.href = PRIVACY_POLICY_URL;
        link.target = "_blank";
        link.textContent = getTranslation('privacyPolicy');
        link.style.cssText = "color:#2563eb;text-decoration:underline;cursor:pointer;";
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
      var prefsPText = getTranslation('managePreferences');
      
      if (PRIVACY_POLICY_URL) {
        // Add privacy policy link inline at the end of the sentence
        prefsP.appendChild(document.createTextNode(prefsPText + " "));
        var linkPrefs = document.createElement("a");
        linkPrefs.href = PRIVACY_POLICY_URL;
        linkPrefs.target = "_blank";
        linkPrefs.textContent = getTranslation('privacyPolicy');
        linkPrefs.style.cssText = "color:#2563eb;text-decoration:underline;cursor:pointer;";
        prefsP.appendChild(linkPrefs);
        prefsP.appendChild(document.createTextNode("."));
      } else {
        prefsP.textContent = prefsPText;
      }
      prefsBody.appendChild(prefsP);
      
      var essentialLabel = document.createElement("label");
      var essentialCheckbox = document.createElement("input");
      essentialCheckbox.type = "checkbox";
      essentialCheckbox.disabled = true;
      essentialCheckbox.checked = true;
      essentialLabel.appendChild(essentialCheckbox);
      essentialLabel.appendChild(document.createTextNode(" " + getTranslation('essential') + " (" + getTranslation('alwaysOn') + ")"));
      prefsBody.appendChild(essentialLabel);
      
      var analyticsLabel = document.createElement("label");
      var analyticsCheckbox = document.createElement("input");
      analyticsCheckbox.type = "checkbox";
      analyticsCheckbox.id = "cb-pref-analytics";
      analyticsLabel.appendChild(analyticsCheckbox);
      analyticsLabel.appendChild(document.createTextNode(" " + getTranslation('analytics')));
      prefsBody.appendChild(analyticsLabel);
      
      var preferencesLabel = document.createElement("label");
      var preferencesCheckbox = document.createElement("input");
      preferencesCheckbox.type = "checkbox";
      preferencesCheckbox.id = "cb-pref-preferences";
      preferencesLabel.appendChild(preferencesCheckbox);
      preferencesLabel.appendChild(document.createTextNode(" " + getTranslation('preferences')));
      prefsBody.appendChild(preferencesLabel);
      
      var marketingLabel = document.createElement("label");
      var marketingCheckbox = document.createElement("input");
      marketingCheckbox.type = "checkbox";
      marketingCheckbox.id = "cb-pref-marketing";
      marketingLabel.appendChild(marketingCheckbox);
      marketingLabel.appendChild(document.createTextNode(" " + getTranslation('marketing')));
      prefsBody.appendChild(marketingLabel);
      prefsBanner.appendChild(prefsBody);
      
      var prefsFooter = document.createElement("div");
      prefsFooter.className = "cb-banner-footer";
      var backBtn = document.createElement("button");
      backBtn.id = "cb-back-btn";
      backBtn.textContent = getTranslation('back');
      prefsFooter.appendChild(backBtn);
      var saveBtn = document.createElement("button");
      saveBtn.id = "cb-save-prefs-btn";
      saveBtn.textContent = getTranslation('save');
      prefsFooter.appendChild(saveBtn);
      prefsBanner.appendChild(prefsFooter);
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

  function initConsentBitBannerUI() {
    injectConsentBitStyles();
    renderConsentBitBanners();

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
        prefsBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade');
      }
      // Restore scroll when banner is hidden
      restoreScroll();
    }

    btnPrefs && btnPrefs.addEventListener("click", function () {
      if (!initialBanner || !prefsBanner) return;
      initialBanner.style.display = "none";
      initialBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade');
      
      // Show preference banner with animation
      prefsBanner.style.display = "flex";
      prefsBanner.style.visibility = "visible";
      prefsBanner.style.opacity = "1";
      
      // Apply animation based on preference position
      if (ANIMATION_ENABLED) {
        var animClass = '';
        if (PREFERENCE_POSITION === 'left') {
          animClass = 'cb-banner-animate-left';
        } else if (PREFERENCE_POSITION === 'right') {
          animClass = 'cb-banner-animate-right';
        } else if (PREFERENCE_POSITION === 'center') {
          if (CENTER_ANIMATION_DIRECTION === 'top') {
            animClass = 'cb-banner-animate-top';
          } else {
            animClass = 'cb-banner-animate-bottom';
          }
        } else {
          animClass = 'cb-banner-animate-fade';
        }
        prefsBanner.classList.add(animClass);
        console.log('[ConsentBit] Applied preference banner animation:', animClass);
      }
    });

    btnBack && btnBack.addEventListener("click", function () {
      if (!initialBanner || !prefsBanner) return;
      prefsBanner.style.display = "none";
      prefsBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade');
      
      initialBanner.style.display = "flex";
      initialBanner.style.visibility = "visible";
      initialBanner.style.opacity = "1";
      
      // Re-apply animation to main banner
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
    });

    if (isCCPA && linkDoNotSell) {
      linkDoNotSell.addEventListener("click", function () {
        var optout = document.getElementById("cb-ccpa-optout");
        if (optout) optout.checked = true;
        if (initialBanner && prefsBanner) {
          initialBanner.style.display = "none";
          prefsBanner.style.display   = "flex";
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
        var optout = !!document.getElementById("cb-ccpa-optout")?.checked;
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
        var consentG = {
          accepted: true,
          timestamp: new Date().toISOString(),
          categories: {
            essential: true,
            analytics: !!document.getElementById("cb-pref-analytics")?.checked,
            preferences: !!document.getElementById("cb-pref-preferences")?.checked,
            marketing: !!document.getElementById("cb-pref-marketing")?.checked
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
const loaderIab=`(function () {
  "use strict";

  // ─── Base URL for external scripts ───────────────────────────────────────────
  const BASE_URL = "https://test-cmp.pages.dev";

  // ─── Inject external dependency scripts in order ─────────────────────────────
  function loadScript(src, onload) {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }


  // ─── Style Config ────────────────────────────────────────────────────────────
// Replace colors / initialLayout / alignment with your actual values
const colors = {};        // your colors object
const alignment = "left"; // your text alignment
const initialLayout = {}; // your layout object

const styleConfig = {
  bannerBg:          colors.bannerBg          || "#FFFFFF",
  textColor:         colors.textColor         || "#000000",
  headingColor:      colors.headingColor      || "#000000",
  buttonColor:       colors.buttonColor       || "#FFFFFF",
  buttonTextColor:   colors.buttonTextColor   || "#007AFF",
  SecButtonColor:    colors.SecButtonColor    || "#007AFF",
  SecButtonTextColor:colors.SecButtonTextColor|| "#FFFFFF",
  textAlign:         alignment                || "left",
  fontWeight:        colors.fontWeight        || "400",
  borderRadius:      initialLayout?.borderRadius || "12",
  bannerType:        initialLayout?.position  || "box", // "box" | "banner" | "popup"
  boxAlignment:      initialLayout?.alignment || "bottom-left", // "bottom-left" | "bottom-right"
};
// ─── Inject all styles ───────────────────────────────────────────────────────
function injectStyles() {
  const s = styleConfig;
  const br  = s.borderRadius + "px";
  const brSm = Math.min(Number(s.borderRadius), 8) + "px";
  const brPill = Math.min(Number(s.borderRadius), 999) + "px";

  const css = ${`
/* ── Vendor List & Search ── */
.consentBit-vendors-search-wrapper{max-height:500px;overflow-y:auto;padding:20px}
.consentBit-search-container{position:relative;margin-bottom:20px}
.consentBit-search-input{width:100%;padding:12px 16px 12px 44px;border:2px solid #e0e0e0;border-radius:${brSm};font-size:14px;transition:border-color .2s ease;background:#fff;box-sizing:border-box}
.consentBit-search-input:focus{outline:none;border-color:${s.SecButtonColor};box-shadow:0 0 0 3px ${s.SecButtonColor}22}
.consentBit-search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:16px;color:#666;pointer-events:none}
.consentBit-vendors-list{display:flex;flex-direction:column;gap:12px}
.consentBit-vendor-item{padding:16px;border:1px solid #f0f0f0;border-radius:${brSm};background:#fafafa;transition:all .2s ease;animation:consentBit-fadeIn .3s ease}
.consentBit-vendor-item:hover{border-color:${s.SecButtonColor};background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.consentBit-vendor-item.consentBit-hidden{display:none!important}
.consentBit-vendor-header{display:flex;justify-content:space-between;align-items:center;gap:16px}
.consentBit-vendor-info{flex:1}
.consentBit-vendor-name{font-weight:600;font-size:15px;color:${s.headingColor};margin-bottom:4px}
.consentBit-vendor-id{font-size:12px;color:#666;font-family:monospace}
.consentBit-switch-wrapper{flex-shrink:0}
.consentBit-consent-switch-wrapper{display:flex;align-items:center;gap:8px}
.consentBit-switch-label{font-size:13px;font-weight:500;color:${s.textColor}}
.consentBit-switch-sm{position:relative;width:36px;height:20px}
.consentBit-switch-sm input{opacity:0;width:0;height:0}
.consentBit-switch-sm input:checked+.consentBit-slider{background-color:${s.SecButtonColor}}
.consentBit-switch-sm input:focus+.consentBit-slider{box-shadow:0 0 1px ${s.SecButtonColor}}
.consentBit-switch-sm input:checked+.consentBit-slider:before{transform:translateX(16px)}
.consentBit-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#ccc;transition:.2s;border-radius:20px}
.consentBit-slider:before{position:absolute;content:"";height:16px;width:16px;left:2px;top:2px;background-color:#fff;transition:.2s;border-radius:50%}
.consentBit-no-results{text-align:center;padding:40px 20px;color:#666}
.consentBit-no-results p{margin:0 0 4px 0;font-size:16px}
.consentBit-empty-vendors-text{text-align:center;color:#666;padding:40px;font-style:italic}
.consentBit-loading{text-align:center;padding:40px;color:${s.textColor}}
@keyframes consentBit-fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

/* ── Cookie Consent Banner ── */
.consentBit-consent-container{
  position:fixed;
  z-index:999999;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  border-radius:${br};
  box-shadow:0 20px 60px rgba(0,0,0,.15);
  backdrop-filter:blur(10px);
  animation:consentBit-slideUp .4s cubic-bezier(.25,.46,.45,.94)
}

/* ── Banner type: full-width banner ── */
.consentBit-type-banner{
  bottom:0; left:0; right:0;
  border-radius:0;
  max-width:100%;
}

/* ── Banner type: box positions ── */
.consentBit-type-box-bottom-left{
  bottom:20px; left:20px; right:auto;
  max-width:450px;
}
.consentBit-type-box-bottom-right{
  bottom:20px; right:20px; left:auto;
  max-width:450px;
}

/* ── Banner type: popup ── */
.consentBit-type-popup{
  top:50%; left:50%;
  transform:translate(-50%,-50%);
  max-width:480px;
  width:calc(100% - 40px);
  animation:consentBit-popIn .3s cubic-bezier(.34,1.2,.64,1);
}
.consentBit-popup-overlay{
  position:fixed;inset:0;
  background:rgba(0,0,0,.45);
  z-index:999998;
}

@keyframes consentBit-slideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes consentBit-popIn{from{transform:translate(-50%,-50%) scale(0.88);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}

/* ── Banner inner ── */
.consentBit-consent-bar{
  border:1px solid #f4f4f4;
  background:${s.bannerBg};
  border-radius:${br};
  padding:24px;
  max-height:500px;
  overflow-y:auto;
}
/* Full-width banner overrides inner radius */
.consentBit-type-banner .consentBit-consent-bar{
  border-radius:0;
  padding:16px 24px;
}
/* Full-width banner: row layout */
.consentBit-type-banner .consentBit-notice{
  flex-direction:row;
  align-items:center;
  gap:24px;
}
.consentBit-type-banner .consentBit-notice-group{
  display:flex;
  flex-direction:row;
  align-items:center;
  gap:20px;
  flex:1;
}
.consentBit-type-banner .consentBit-notice-btn-wrapper{
  flex-direction:row;
  padding-top:0;
  border-top:none;
  flex-shrink:0;
}

.consentBit-notice{display:flex;flex-direction:column;gap:16px}
.consentBit-title{
  font-size:20px;
  font-weight:700;
  line-height:1.3;
  margin:0 0 12px 0;
  color:${s.headingColor};
  text-align:${s.textAlign};
}
.consentBit-notice-group{display:flex;flex-direction:column;gap:20px}
.consentBit-notice-des{
  flex:1;
  color:${s.textColor};
  line-height:1.6;
  font-size:14px;
  font-weight:${s.fontWeight};
  text-align:${s.textAlign};
}
.consentBit-notice-des p{margin:0 0 12px 0}
.consentBit-notice-des p:last-child{margin-bottom:0}
.consentBit-iab-dec-btn{
  background:none;border:none;
  color:${s.SecButtonColor};
  font-weight:600;cursor:pointer;padding:0;
  font-size:14px;text-decoration:underline;
}
.consentBit-iab-dec-btn:hover{opacity:.8}
.consentBit-notice-btn-wrapper{
  display:flex;
  flex-direction:column;
  gap:8px;
  padding-top:16px;
  border-top:1px solid #f0f0f0;
  justify-content:${s.textAlign === "center" ? "center" : s.textAlign === "right" ? "flex-end" : "flex-start"};
}

/* ── Buttons ── */
.consentBit-btn{
  padding:11px 20px;
  border-radius:${brSm};
  font-size:14px;
  font-weight:${s.fontWeight};
  cursor:pointer;
  transition:opacity .2s ease;
  border:2px solid transparent;
  text-align:center;
  min-height:44px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  white-space:nowrap;
}
.consentBit-btn:hover{opacity:.85}

/* Customise / Reject All — outline */
.consentBit-btn-customize,
.consentBit-btn-reject{
  color:${s.buttonTextColor};
  background:${s.buttonColor};
  border-color:${s.buttonTextColor};
}

/* Accept All — solid primary */
.consentBit-btn-accept{
  color:${s.SecButtonTextColor};
  background:${s.SecButtonColor};
  border-color:${s.SecButtonColor};
}

/* Customise spans full row in box/popup only */
.consentBit-type-box-bottom-left .consentBit-btn-customize,
.consentBit-type-box-bottom-right .consentBit-btn-customize,
.consentBit-type-popup .consentBit-btn-customize{
  width:100%;
}

/* ── Modal Overlay ── */
.cb-modal{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000000;padding:20px;box-sizing:border-box}
.cb-modal.cb-modal-hidden{display:none!important}
.cb-preference-center{
  background-color:${s.bannerBg};
  border:1px solid #f4f4f4;
  border-radius:${br};
  max-width:720px;width:100%;
  max-height:90vh;
  display:flex;flex-direction:column;
  box-shadow:0 4px 20px rgba(0,0,0,.15);
}
.cb-preference-header{padding:20px 24px;border-bottom:1px solid #f4f4f4;display:flex;justify-content:space-between;align-items:center}
.cb-preference-title{font-size:18px;font-weight:600;color:${s.headingColor}}
.cb-btn-close{background:none;border:none;cursor:pointer;padding:4px;opacity:.5;transition:opacity .2s}
.cb-btn-close:hover{opacity:1}
.cb-btn-close img{width:20px;height:20px}
.cb-iab-detail-wrapper{flex:1;overflow-y:auto;padding:0 24px 24px}
.cb-iab-preference-des{
  padding:16px 0;
  color:${s.textColor};
  font-size:13px;
  line-height:1.7;
  font-weight:${s.fontWeight};
  text-align:${s.textAlign};
}
.cb-iab-dec-btn{background:none;border:none;color:${s.SecButtonColor};text-decoration:underline;cursor:pointer;font-size:inherit;padding:0}
.cb-iab-navbar-wrapper{margin-bottom:24px;border-bottom:2px solid #f4f4f4}
.cb-iab-navbar{display:flex;list-style:none;gap:0;padding:0;margin:0}
.cb-iab-nav-item{flex:1}
.cb-iab-nav-btn{
  width:100%;padding:12px 16px;
  background:none;border:none;
  border-bottom:3px solid transparent;
  cursor:pointer;font-size:13px;font-weight:${s.fontWeight};
  color:${s.textColor};opacity:.6;
  transition:all .2s;
}
.cb-iab-nav-item-active .cb-iab-nav-btn{
  color:${s.SecButtonColor};
  border-bottom-color:${s.SecButtonColor};
  opacity:1;font-weight:600;
}
.cb-iab-nav-btn:hover{background-color:#f9f9f9}
.cb-preference-body-wrapper{display:none}
.cb-preference-body-wrapper.active{display:block}
.cb-iab-detail-title{
  font-size:16px;font-weight:600;
  color:${s.headingColor};
  margin-bottom:14px;
  text-align:${s.textAlign};
}
.cb-preference-content-wrapper{
  color:${s.textColor};
  font-size:13px;
  font-weight:${s.fontWeight};
  line-height:1.6;
  margin-bottom:20px;
  text-align:${s.textAlign};
}
.cb-show-desc-btn{background:none;border:none;color:${s.SecButtonColor};cursor:pointer;font-size:inherit;text-decoration:underline;padding:0}
.cb-horizontal-separator{height:1px;background-color:#ebebeb;margin:20px 0}
.cb-accordion-wrapper{display:flex;flex-direction:column;gap:10px}
.cb-accordion{border:1px solid #ebebeb;border-radius:${brSm};overflow:hidden;background:${s.bannerBg}}
.cb-accordion-item,.cb-accordion-iab-item{display:flex;gap:12px;padding:14px 16px;cursor:pointer;transition:background-color .2s}
.cb-accordion-item:hover,.cb-accordion-iab-item:hover{background-color:#f9f9f9}
.cb-accordion-chevron{flex-shrink:0;width:20px;height:20px;display:flex;align-items:center;justify-content:center}
.cb-chevron-right{width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid #999;transition:transform .2s;display:inline-block}
.cb-accordion.active .cb-chevron-right{transform:rotate(90deg)}
.cb-accordion-header-wrapper{flex:1}
.cb-accordion-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:10px}
.cb-accordion-btn{
  background:none;border:none;
  font-size:14px;font-weight:600;
  color:${s.headingColor};
  cursor:pointer;text-align:${s.textAlign};padding:0;
}
.cb-always-active{
  padding:3px 10px;
  background-color:#DCFCE7;color:#166534;
  border-radius:${brPill};
  font-size:11px;font-weight:500;
}
.cb-accordion-header-des{
  color:${s.textColor};
  font-size:13px;
  font-weight:${s.fontWeight};
  line-height:1.6;
  text-align:${s.textAlign};
}
.cb-switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
.cb-switch input{opacity:0;width:0;height:0}
.cb-switch input[type="checkbox"]{appearance:none;width:44px;height:24px;background-color:#d0d5d2;border-radius:12px;position:relative;cursor:pointer;transition:background-color .2s}
.cb-switch input[type="checkbox"]:checked{background-color:${s.SecButtonColor}}
.cb-switch input[type="checkbox"]::before{content:'';position:absolute;width:18px;height:18px;border-radius:50%;background-color:#fff;top:3px;left:3px;transition:transform .2s}
.cb-switch input[type="checkbox"]:checked::before{transform:translateX(20px)}
.cb-accordion-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
.cb-accordion.active .cb-accordion-body{max-height:2000px}
.cb-audit-table{background-color:#f4f4f4;border:1px solid #ebebeb;border-radius:${brSm};padding:14px;margin:0 14px 14px 28px}
.cb-cookie-des-table{list-style:none;margin-bottom:14px;padding:0 0 14px 0;border-bottom:1px solid #ebebeb}
.cb-cookie-des-table:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none}
.cb-cookie-des-table li{display:flex;margin-bottom:6px;font-size:12px}
.cb-cookie-des-table li div:first-child{font-weight:600;min-width:90px;color:${s.textColor};opacity:.6}
.cb-cookie-des-table li div:last-child{color:${s.textColor}}
.cb-empty-cookies-text{color:${s.textColor};opacity:.5;font-style:italic;text-align:center;padding:16px}
.cb-child-accordion{border-top:1px solid #ebebeb}
.cb-child-accordion:first-child{border-top:none}
.cb-child-accordion-item{display:flex;gap:12px;padding:12px 16px;cursor:pointer;transition:background-color .2s}
.cb-child-accordion-item:hover{background-color:#f9f9f9}
.cb-child-accordion-chevron{flex-shrink:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center}
.cb-child-accordion.active .cb-chevron-right{transform:rotate(90deg)}
.cb-child-accordion-header-wrapper{flex:1;display:flex;justify-content:space-between;align-items:center;gap:16px}
.cb-child-accordion-btn{background:none;border:none;font-size:13px;font-weight:500;color:${s.headingColor};cursor:pointer;text-align:left;padding:0;flex:1}
.cb-child-accordion-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
.cb-child-accordion.active .cb-child-accordion-body{max-height:2000px}
.cb-iab-ad-settings-details{padding:14px;background-color:#f9f9f9;margin:0 14px 14px;border-radius:${brSm}}
.cb-iab-ad-settings-details-des{color:${s.textColor};font-size:13px;line-height:1.6;margin-bottom:12px;font-weight:${s.fontWeight}}
.cb-iab-illustrations-title{font-weight:600;color:${s.headingColor};margin-bottom:6px;font-size:13px}
.cb-iab-illustrations-des{list-style:none;padding-left:0}
.cb-iab-illustrations-des li{padding-left:18px;position:relative;margin-bottom:10px;color:${s.textColor};font-size:12px;line-height:1.6;font-weight:${s.fontWeight}}
.cb-iab-illustrations-des li::before{content:'•';position:absolute;left:0;color:${s.SecButtonColor}}
.cb-iab-vendors-count-wrapper{margin-top:12px;font-size:12px;color:${s.textColor};opacity:.6;font-weight:500}
.cb-switch-wrapper{display:flex;gap:12px;align-items:center;flex-shrink:0}
.cb-switch-separator{padding-right:12px;border-right:1px solid #ddd}
.cb-legitimate-switch-wrapper,.cb-consent-switch-wrapper{display:flex;align-items:center;gap:6px}
.cb-switch-label{font-size:11px;color:${s.textColor};opacity:.6;font-weight:500;white-space:nowrap}
.cb-switch-sm{position:relative;display:inline-block}
.cb-switch-sm input[type="checkbox"]{appearance:none;width:36px;height:20px;background-color:#d0d5d2;border-radius:10px;position:relative;cursor:pointer;transition:background-color .2s}
.cb-switch-sm input[type="checkbox"]:checked{background-color:${s.SecButtonColor}}
.cb-switch-sm input[type="checkbox"]::before{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background-color:#fff;top:3px;left:3px;transition:transform .2s}
.cb-switch-sm input[type="checkbox"]:checked::before{transform:translateX(16px)}
.cb-switch-sm input[type="checkbox"]:disabled{cursor:not-allowed}
.cb-switch-sm input[type="checkbox"]:disabled:checked{opacity:.7}
.cb-footer-wrapper{border-top:1px solid #f4f4f4;background-color:${s.bannerBg};flex-shrink:0}
.cb-footer-shadow{display:block;height:20px;margin-top:-20px;background:linear-gradient(180deg,rgba(255,255,255,0) 0%,${s.bannerBg} 100%)}
.cb-prefrence-btn-wrapper{
  padding:14px 22px;
  display:flex;gap:10px;
  justify-content:${s.textAlign === "center" ? "center" : s.textAlign === "right" ? "flex-start" : "flex-end"};
  flex-wrap:wrap;
}
.cb-btn{
  padding:9px 20px;border-radius:${brSm};
  font-size:13px;font-weight:${s.fontWeight};
  cursor:pointer;transition:opacity .2s;
  border:2px solid;
  white-space:nowrap;
}
.cb-btn:hover{opacity:.85}
.cb-btn-reject{
  background-color:${s.buttonColor};
  color:${s.buttonTextColor};
  border-color:${s.buttonTextColor};
}
.cb-btn-preferences{
  background-color:${s.buttonColor};
  color:${s.buttonTextColor};
  border-color:${s.buttonTextColor};
}
.cb-btn-accept{
  background-color:${s.SecButtonColor};
  color:${s.SecButtonTextColor};
  border-color:${s.SecButtonColor};
}

/* ── Responsive ── */
@media(max-width:768px){
  .consentBit-type-box-bottom-left,
  .consentBit-type-box-bottom-right{left:10px;right:10px;max-width:calc(100% - 20px)}
  .consentBit-type-box-bottom-left{bottom:10px}
  .consentBit-type-box-bottom-right{bottom:10px}
  .consentBit-consent-bar{padding:18px}
  .consentBit-title{font-size:16px}
  .consentBit-notice-btn-wrapper{flex-direction:column}
  .consentBit-btn{width:100%}
  .consentBit-type-banner .consentBit-notice{flex-direction:column;gap:14px}
  .consentBit-type-banner .consentBit-notice-group{flex-direction:column}
  .consentBit-type-banner .consentBit-notice-btn-wrapper{flex-direction:row;flex-wrap:wrap}
  .cb-preference-center{max-height:95vh}
  .cb-iab-navbar{flex-direction:column}
  .cb-prefrence-btn-wrapper{flex-direction:column}
  .cb-btn{width:100%}
  .cb-switch-wrapper{flex-direction:column;align-items:flex-start;gap:6px}
  .cb-switch-separator{border-right:none;padding-right:0;padding-bottom:6px;border-bottom:1px solid #ddd}
}
@media(prefers-reduced-motion:reduce){
  .consentBit-consent-container{animation:none}
  .consentBit-type-popup{animation:none}
}
.consentBit-consent-bar::-webkit-scrollbar{width:6px}
.consentBit-consent-bar::-webkit-scrollbar-track{background:#f5f5f5;border-radius:3px}
.consentBit-consent-bar::-webkit-scrollbar-thumb{background:#c1c1c1;border-radius:3px}
.consentBit-consent-bar::-webkit-scrollbar-thumb:hover{background:#a8a8a8}
`};

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

// ─── Build & inject HTML ─────────────────────────────────────────────────────
function injectHTML() {
  const s = styleConfig;

  // Determine banner container class based on type + boxAlignment
  let bannerPositionClass = "";
  if (s.bannerType === "banner") {
    bannerPositionClass = "consentBit-type-banner";
  } else if (s.bannerType === "popup") {
    bannerPositionClass = "consentBit-type-popup";
  } else {
    // box
    bannerPositionClass = s.boxAlignment === "bottom-right"
      ? "consentBit-type-box-bottom-right"
      : "consentBit-type-box-bottom-left";
  }

  // Popup needs a backdrop overlay div
  const popupOverlay = s.bannerType === "popup"
    ? "<div class="consentBit-popup-overlay" id="consentBitPopupOverlay"></div>"
    : "";

  const bannerHTML = ${`
${popupOverlay}

<div class="consentBit-consent-container ${bannerPositionClass}"
     id="consentBitBanner" tabindex="-1"
     aria-label="We value your privacy" role="region">
  <div class="consentBit-consent-bar" data-consentBit-tag="notice">
    <div class="consentBit-notice">

      <p class="consentBit-title"
         aria-level="2" data-consentBit-tag="title" role="heading">
       Your privacy matters to us
      </p>

      <div class="consentBit-notice-group">
        <div class="consentBit-notice-des" data-consentBit-tag="iab-description">
          <p>We and our trusted partners use cookies and similar technologies to collect and store information from your device. This may include details such as your IP address, browsing behavior, and device information.
This data is used to ensure the website functions properly, enhance your experience, deliver personalized content and advertisements, and analyze performance and user engagement. In certain situations, we may also process location data and use device-based identification methods.
You have the option to manage your preferences and control how your information is used.
          </p>
        </div>

        <div class="consentBit-notice-btn-wrapper" data-consentBit-tag="notice-buttons">
          <button class="consentBit-btn consentBit-btn-customize"
                  id="consentBitCustomiseBtn"
                  aria-label="Customise"
                  aria-haspopup="dialog"
                  aria-controls="cbPreferenceModal"
                  data-consentBit-tag="settings-button">
            Customise
          </button>
          <button class="consentBit-btn consentBit-btn-reject"
                  id="consentBitRejectAllBanner"
                  aria-label="Reject All"
                  data-consentBit-tag="reject-button">
            Reject All
          </button>
          <button class="consentBit-btn consentBit-btn-accept"
                  id="consentBitAcceptAllBanner"
                  aria-label="Accept All"
                  data-consentBit-tag="accept-button">
            Accept All
          </button>
        </div>
      </div>

    </div>
  </div>
</div>

<div class="cb-modal cb-modal-hidden" id="cbPreferenceModal" tabindex="-1">
  <div class="cb-preference-center" role="dialog" aria-modal="true"
       aria-label="Customise Consent Preferences">
    <div class="cb-preference-header">
      <span class="cb-preference-title" role="heading" aria-level="2">
        Customise Consent Preferences
      </span>
      <button aria-label="Close" class="cb-btn-close" id="cbCloseBtn">
        <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='18' y1='6' x2='6' y2='18'%3E%3C/line%3E%3Cline x1='6' y1='6' x2='18' y2='18'%3E%3C/line%3E%3C/svg%3E" alt="Close">
      </button>
    </div>

    <div class="cb-iab-detail-wrapper">
      <div class="cb-iab-preference-des">
        <p>Customise your consent preferences for Cookie Categories and advertising tracking
        preferences for Purposes &amp; Features and Vendors below. You can give granular consent
        for each Third Party Vendor. Most vendors require explicit consent for personal data
        processing, while some rely on legitimate interest. However, you have the right to object
        to their use of legitimate interest.</p>
      </div>

      <div class="cb-iab-navbar-wrapper">
        <ul class="cb-iab-navbar">
          <li class="cb-iab-nav-item cb-iab-nav-item-active" data-tab="cookie">
            <button aria-label="Cookie Categories" class="cb-iab-nav-btn">Cookie Categories</button>
          </li>
          <li class="cb-iab-nav-item" data-tab="purpose">
            <button aria-label="Purposes &amp; Features" class="cb-iab-nav-btn">Purposes &amp; Features</button>
          </li>
          <li class="cb-iab-nav-item" data-tab="vendor">
            <button aria-label="Vendors" class="cb-iab-nav-btn">Vendors</button>
          </li>
        </ul>
      </div>

      <div class="cb-iab-detail-sub-wrapper">
        <div class="cb-preference-body-wrapper active" id="cbIABSectionCookie">
          <p class="cb-iab-detail-title">Cookie Categories</p>
          <div class="cb-preference-content-wrapper">
            <p>We use cookies to help you navigate efficiently and perform certain functions.
            You will find detailed information about all cookies under each consent category below.</p>
            <p>The cookies that are categorised as "Necessary" are stored on your browser as they
            are essential for enabling the basic functionalities of the site.</p>
          </div>
          <div class="cb-horizontal-separator"></div>
          <div class="cb-accordion-wrapper" id="cookieAccordions"></div>
        </div>

        <div class="cb-preference-body-wrapper" id="cbIABSectionPurpose">
          <p class="cb-iab-detail-title">Purposes &amp; Features</p>
          <div class="cb-accordion-wrapper" id="purposeAccordions"></div>
        </div>

        <div class="cb-preference-body-wrapper" id="cbIABSectionVendor">
          <p class="cb-iab-detail-title">Vendors</p>
          <div class="consentBit-vendors-search-wrapper">
            <div class="consentBit-search-container">
              <input type="text" id="vendorsSearch"
                     class="consentBit-search-input"
                     placeholder="Search vendors by name or ID..."
                     autocomplete="off">
              <div class="consentBit-search-icon">🔍</div>
            </div>
            <div id="vendorsLoading" class="consentBit-loading">Loading vendors...</div>
            <div id="vendorsList" class="consentBit-vendors-list" style="display:none;"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="cb-footer-wrapper">
      <span class="cb-footer-shadow"></span>
      <div class="cb-prefrence-btn-wrapper">
        <button aria-label="Reject All" class="cb-btn cb-btn-reject" id="cbRejectBtn">Reject All</button>
        <button aria-label="Save My Preferences" class="cb-btn cb-btn-preferences" id="cbSaveBtn">Save My Preferences</button>
        <button aria-label="Accept All" class="cb-btn cb-btn-accept" id="cbAcceptBtn">Accept All</button>
      </div>
    </div>
  </div>
</div>
`};

  const wrapper = document.createElement("div");
  wrapper.innerHTML = bannerHTML;
  document.body.appendChild(wrapper);
}
  // ─── Cookie Categories Data ──────────────────────────────────────────────────
  const cookieCategories = [
    {
      id: "necessary", name: "Necessary", alwaysActive: true,
      description: "Necessary cookies are required to enable the basic features of this site, such as providing secure log-in or adjusting your consent preferences. These cookies do not store any personally identifiable data.",
      cookies: [
        { name: "_cfuvid", duration: "session", description: "Calendly sets this cookie to track users across sessions to optimize user experience by maintaining session consistency and providing personalized services." },
        { name: "cookieyes-consent", duration: "1 year", description: "CookieYes sets this cookie to remember users' consent preferences so that their preferences are respected on subsequent visits to this site. It does not collect or store any personal information about the site visitors." }
      ]
    },
    {
      id: "functional", name: "Functional", alwaysActive: false,
      description: "Functional cookies help perform certain functionalities like sharing the content of the website on social media platforms, collecting feedback, and other third-party features.",
      cookies: []
    },
    {
      id: "analytics", name: "Analytics", alwaysActive: false,
      description: "Analytical cookies are used to understand how visitors interact with the website. These cookies help provide information on metrics such as the number of visitors, bounce rate, traffic source, etc.",
      cookies: [
        { name: "_hjSessionUser_*", duration: "1 year", description: "Hotjar sets this cookie to ensure data from subsequent visits to the same site is attributed to the same user ID, which persists in the Hotjar User ID, which is unique to that site." },
        { name: "_hjSession_*", duration: "1 hour", description: "Hotjar sets this cookie to ensure data from subsequent visits to the same site is attributed to the same user ID, which persists in the Hotjar User ID, which is unique to that site." }
      ]
    },
    {
      id: "performance", name: "Performance", alwaysActive: false,
      description: "Performance cookies are used to understand and analyse the key performance indexes of the website which helps in delivering a better user experience for the visitors.",
      cookies: [
        { name: "SRM_B", duration: "1 year 24 days", description: "Used by Microsoft Advertising as a unique ID for visitors." }
      ]
    },
    {
      id: "advertisement", name: "Advertisement", alwaysActive: false,
      description: "Advertisement cookies are used to provide visitors with customised advertisements based on the pages you visited previously and to analyse the effectiveness of the ad campaigns.",
      cookies: [
        { name: "MUID", duration: "1 year 24 days", description: "Bing sets this cookie to recognise unique web browsers visiting Microsoft sites. This cookie is used for advertising, site analytics, and other operations." },
        { name: "ANONCHK", duration: "10 minutes", description: "The ANONCHK cookie, set by Bing, is used to store a user's session ID and verify ads' clicks on the Bing search engine. The cookie helps in reporting and personalization as well." }
      ]
    }
  ];

  // ─── Purposes Data ───────────────────────────────────────────────────────────
  const purposesData = [
    {
      id: "purposes", title: "Purposes (11)", hasToggle: true,
      items: [
        { id: "purpose1", title: "Store and/or access information on a device", description: "Cookies, device or similar online identifiers (e.g. login-based identifiers, randomly assigned identifiers, network based identifiers) together with other information (e.g. browser type and information, language, screen size, supported technologies etc.) can be stored or read on your device to recognise it each time it connects to an app or to a website, for one or several of the purposes presented here.", illustrations: ["Most purposes explained in this notice rely on the storage or accessing of information from your device when you use an app or visit a website."], vendorCount: 777, hasConsent: true, hasLegitimate: false },
        { id: "purpose2", title: "Use limited data to select advertising", description: "Advertising presented to you on this service can be based on limited data, such as the website or app you are using, your non-precise location, your device type or which content you are (or have been) interacting with.", illustrations: ["A car manufacturer wants to promote its electric vehicles to environmentally conscious users living in the city after office hours.", "A large producer of watercolour paints wants to carry out an online advertising campaign for its latest watercolour range."], vendorCount: 734, hasConsent: true, hasLegitimate: true },
        { id: "purpose3", title: "Create profiles for personalised advertising", description: "Information about your activity on this service (such as forms you submit, content you look at) can be stored and combined with other information about you.", illustrations: ["If you read several articles about the best bike accessories to buy, this information could be used to create a profile about your interest in bike accessories.", "An apparel company wishes to promote its new line of high-end baby clothes by building profiles of wealthy young parents."], vendorCount: 594, hasConsent: true, hasLegitimate: false },
        { id: "purpose4", title: "Use profiles to select personalised advertising", description: "Advertising presented to you on this service can be based on your advertising profiles, which can reflect your activity on this service or other websites or apps.", illustrations: ["An online retailer targets users who previously looked at running shoes.", "A profile created on one site is used on another app to show relevant ads."], vendorCount: 596, hasConsent: true, hasLegitimate: false },
        { id: "purpose5", title: "Create profiles to personalise content", description: "Information about your activity on this service can be stored and combined with other information to build or improve a profile which is then used to present more relevant content.", illustrations: ["Reading DIY articles leads to more DIY content recommendations.", "Viewing space videos creates interest profile for space content."], vendorCount: 267, hasConsent: true, hasLegitimate: false },
        { id: "purpose6", title: "Use profiles to select personalised content", description: "Content presented to you can be based on your content personalisation profiles and interests.", illustrations: ["Vegetarian recipes shown based on reading habits.", "Rowing videos recommended based on viewing history."], vendorCount: 238, hasConsent: true, hasLegitimate: false },
        { id: "purpose7", title: "Measure advertising performance", description: "Information regarding which advertising is presented to you and how you interact with it can be used to determine how well an advert has worked.", illustrations: ["Clicks and purchases tracked for ad performance.", "Ad placement optimisation based on interaction data."], vendorCount: 847, hasConsent: true, hasLegitimate: true },
        { id: "purpose8", title: "Measure content performance", description: "Information regarding which content is presented to you and how you interact with it can be used to determine content effectiveness.", illustrations: ["Blog engagement tracked for content planning.", "Video watch time used to optimise length."], vendorCount: 404, hasConsent: true, hasLegitimate: true },
        { id: "purpose9", title: "Understand audiences through statistics or combinations of data from different sources", description: "Reports can be generated based on the combination of data sets regarding interactions to identify common characteristics.", illustrations: ["Online bookstore audience analytics.", "Advertiser audience comparison study."], vendorCount: 548, hasConsent: true, hasLegitimate: true },
        { id: "purpose10", title: "Develop and improve services", description: "Information about your activity can be used to improve products and services and build new services.", illustrations: ["Optimising ads for mobile devices.", "Developing new ad formats for new devices."], vendorCount: 633, hasConsent: true, hasLegitimate: true },
        { id: "purpose11", title: "Use limited data to select content", description: "Content can be based on limited data such as website/app used, non-precise location, device type, or interactions.", illustrations: ["Travel content selected by location.", "Shorter videos selected based on fast-forward behaviour."], vendorCount: 174, hasConsent: true, hasLegitimate: true }
      ]
    },
    {
      id: "special_purposes", title: "Special Purposes (3)", hasToggle: false,
      items: [
        { id: "specialPurpose1", title: "Ensure security, prevent and detect fraud, and fix errors", description: "Your data can be used to monitor for and prevent unusual and possibly fraudulent activity (for example, regarding advertising, ad clicks by bots), and ensure systems and processes work properly and securely.", illustrations: ["An advertising intermediary notices a large increase in clicks on ads and uses data to determine 80% come from bots."], vendorCount: 595, hasConsent: false, hasLegitimate: false },
        { id: "specialPurpose2", title: "Deliver and present advertising and content", description: "Certain information (like an IP address or device capabilities) is used to ensure the technical compatibility of the content or advertising, and to facilitate the transmission of the content or ad to your device.", illustrations: ["Clicking on a link in an article might normally send you to another page. Your browser sends a request to a server to properly display the information."], vendorCount: 594, hasConsent: false, hasLegitimate: false },
        { id: "specialPurpose3", title: "Save and communicate privacy choices", description: "The choices you make regarding the purposes and entities listed in this notice are saved and made available to those entities in the form of digital signals.", illustrations: ["When you visit a website and are offered a choice between consenting to personalised advertising or not, the choice you make is saved and made available to advertising providers."], vendorCount: 445, hasConsent: false, hasLegitimate: false }
      ]
    },
    {
      id: "features", title: "Features (3)", hasToggle: false,
      items: [
        { id: "feature1", title: "Match and combine data from other data sources", description: "Information about your activity on this service may be matched and combined with other information relating to you and originating from various sources.", vendorCount: 436, hasConsent: false, hasLegitimate: false },
        { id: "feature2", title: "Link different devices", description: "In support of the purposes explained in this notice, your device might be considered as likely linked to other devices that belong to you or your household.", vendorCount: 369, hasConsent: false, hasLegitimate: false },
        { id: "feature3", title: "Identify devices based on information transmitted automatically", description: "Your device might be distinguished from other devices based on information it automatically sends when accessing the Internet.", vendorCount: 558, hasConsent: false, hasLegitimate: false }
      ]
    },
    {
      id: "special-features", title: "Special Features (2)", hasToggle: true,
      items: [
        { id: "special-feature1", title: "Use precise geolocation data", description: "With your acceptance, your precise location (within a radius of less than 500 metres) may be used in support of the purposes explained in this notice.", vendorCount: 280, hasConsent: true, hasLegitimate: false },
        { id: "special-feature2", title: "Actively scan device characteristics for identification", description: "With your acceptance, certain characteristics specific to your device might be requested and used to distinguish it from other devices.", vendorCount: 157, hasConsent: true, hasLegitimate: false }
      ]
    }
  ];

  // ─── Init Cookie Accordions ──────────────────────────────────────────────────


  // ─── Init Purpose Accordions ─────────────────────────────────────────────────
  
  // ─── Load Vendors ────────────────────────────────────────────────────────────

  // ─── Tabs ────────────────────────────────────────────────────────────────────
  

  // ─── Accordions ──────────────────────────────────────────────────────────────


  // ─── Save Preferences + TCF String ──────────────────────────────────────────
  
  // ─── Button Actions ──────────────────────────────────────────────────────────


 

 


  // ─── Bootstrap ───────────────────────────────────────────────────────────────
  // function bootstrap() {
  //   // Check if already consented — skip banner if so
  //   const saved = localStorage.getItem("cookieConsentPrefs");
  //   if (saved) {
  //     try {
  //       const parsed = JSON.parse(saved);
  //       if (parsed.choice === "accepted" || parsed.choice === "rejected") {
  //         console.log("✅ Consent already recorded, skipping banner.");
  //         return;
  //       }
  //     } catch (_) {}
  //   }

  //   injectStyles();
  //   injectHTML();

  //   // Small delay to ensure DOM is ready
  //   // setTimeout(() => {
  //   //   initCookieAccordions();
  //   //   initPurposeAccordions();
  //   //   initTabs();
  //   //   initAccordions();
  //   //   initButtons();
  //   // }, 0);
  // }
async function bootstrap() {
  const saved = localStorage.getItem("cookieConsentPrefs");

  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.choice === "accepted" || parsed.choice === "rejected") {
        console.log("✅ Consent already recorded, skipping banner.");
        return;
      }
    } catch (_) {}
  }

  injectStyles();
  injectHTML();

  console.log("✅ HTML Injected");

  // ✅ Wait one tick so DOM updates
  await new Promise((r) => setTimeout(r, 0));

  // ✅ NOW elements exist
  // initCookieAccordions();
  // initPurposeAccordions();
  // initTabs();
  // initAccordions();
  // initButtons();

  console.log("✅ UI Initialized");

  // ✅ Vendors depend on TCF Manager → wait for it
  // waitForTCFAndLoad();
}
  // ─── Load external scripts then bootstrap ────────────────────────────────────
  function init() {
    // Load TCF bundle first, then consentui + Tcfmanager
    loadScript(BASE_URL + "/tcf.bundle.js", function () {
      loadScript(BASE_URL + "/consentuiV2.js");
      loadScript(BASE_URL + "/Tcfmanager.js");
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootstrap);
    } else {
      bootstrap();
    }
  }

  init();
})();`

  const loadBaner= resolvedSite.banner_type==="iab"? loaderIab:loader;
  console.log("Resolved Site:", resolvedSite);
  return new Response(loadBaner, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}