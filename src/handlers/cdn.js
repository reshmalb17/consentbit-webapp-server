// handlers/cdn.js
import { getBannerCustomization } from '../services/db.js';
import { mergeTranslations } from '../data/defaultTranslations.js';

export async function handleCDNScript(request, env, url) {
  const parts = url.pathname.split('/');
  // Extract script ID: /client_data/{cdnScriptId}/script.js -> {cdnScriptId}
  // or /client_data/{cdnScriptId} -> {cdnScriptId}
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

  if (!site) {
    return new Response('// Unknown site script', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  // Load banner customization
  const customization = await getBannerCustomization(db, site.id);

  const apiBase =
    env.API_BASE_URL ||
    'https://consent-webapp-manager.web-8fb.workers.dev';

  const GA_ID = site.ga_measurement_id || '';

  // Geo info from Cloudflare
  const cf = request.cf || {};
  const country = cf.country || null;          // e.g. "US"
  const isEU = cf.isEUCountry === '1';         // "1" for EU members

  const regionMode = site.region_mode || 'gdpr';           // 'gdpr' | 'ccpa' | 'both'
  let effectiveBannerType = site.banner_type || 'gdpr';    // base type

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
      id: ${JSON.stringify(site.id)},
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

  return new Response(loader, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
