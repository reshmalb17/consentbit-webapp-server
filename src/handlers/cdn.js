// handlers/cdn.js
import { getBannerCustomization, getEffectivePlanForOrganization } from '../services/db.js';
import { mergeTranslations } from '../data/defaultTranslations.js';
import { SCRIPT_BLOCK_PROVIDERS } from '../data/scriptBlockProviders.js';

export async function handleCDNScript(request, env, url) {
  try {
  return await _handleCDNScript(request, env, url);
  } catch (err) {
    console.error('[CDN] Unhandled error:', err);
    return new Response(`// CDN error: ${err?.message || err}`, {
      status: 500,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }
}

async function _handleCDNScript(request, env, url) {
  const parts = url.pathname.split('/');

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
      'SELECT id, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id, pendingScan, updatedAt FROM Site WHERE cdnScriptId = ?1'
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
        'SELECT id, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id, pendingScan, updatedAt FROM Site WHERE id = ?1'
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

  // Check subscription status — block banner if subscription is canceled/expired
  try {
    const orgId = resolvedSite.organizationId ?? resolvedSite.organizationid ?? null;
    if (orgId) {
      const { subscription } = await getEffectivePlanForOrganization(db, orgId, env);
      const status = subscription ? String(subscription.status || '').toLowerCase() : null;
      // Block when subscription is definitively inactive: canceled, or payment failed with no recovery path.
      // past_due / unpaid = payment failed; incomplete_expired = trial/setup never completed.
      // trialing, active, cancelAtPeriodEnd still get the banner (access continues until period end).
      const INACTIVE_STATUSES = ['canceled', 'cancelled', 'past_due', 'unpaid', 'incomplete_expired'];
      if (status && INACTIVE_STATUSES.includes(status)) {
        return new Response('// Subscription inactive — banner disabled', {
          status: 402,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    }
  } catch (subErr) {
    console.warn('[CDN] Subscription check failed:', subErr?.message);
    // Fall through — do not block banner on DB errors
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
  // When false, the embed script skips the consent banner entirely (but still injects floating button)
  let bannerEnabled = true;

  // Decide which banner to show (or none) based on visitor location:
  if (regionMode === 'both') {
    // Both configured: EU visitors see GDPR, US visitors see CCPA, everyone else sees GDPR
    if (isEU) {
      effectiveBannerType = 'gdpr';
    } else if (country === 'US') {
      effectiveBannerType = 'ccpa';
    } else {
      effectiveBannerType = 'gdpr';
    }
  } else if (regionMode === 'ccpa') {
    // CCPA-only: only show banner to US visitors; suppress for all other countries
    if (country === 'US') {
      effectiveBannerType = 'ccpa';
    } else {
      bannerEnabled = false;
    }
  }
  // regionMode === 'gdpr': show GDPR banner everywhere (default, no change needed)

  // Generate custom CSS styles from customization
  let customStyles = null;
  /** Passed to embed config for scripts that branch on initial banner shape. */
  let bannerLayoutVisualForConfig = 'box';
  // Declared here so siteConfigPayload can reference it even when customization is null
  let enTrans = {};
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
    /** Accept/Reject share primary colors; Preferences/Save share customise colors (dashboard parity). */
    var acceptBg = customization.acceptButtonBg || '#007aff';
    var acceptTx = customization.acceptButtonText || '#ffffff';
    var custBg = customization.customiseButtonBg || '#ffffff';
    var custTx = customization.customiseButtonText || '#334155';

    /** Typography from stored translations (dashboard Type tab). */
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
    /** box = corner card; banner = full-width bottom bar; bottom-center = centered full-width bottom bar; popup (legacy) = treated as bottom-center. */
    var layoutVisual = 'box';
    try {
      var lvRaw = enTrans.bannerLayoutVisual != null ? String(enTrans.bannerLayoutVisual).toLowerCase() : 'box';
      if (lvRaw === 'banner') layoutVisual = 'banner';
      else if (lvRaw === 'bottom-center' || lvRaw === 'popup') layoutVisual = 'bottom-center';
    } catch (eLayout) {}
    bannerLayoutVisualForConfig = layoutVisual;

    var fontName = enTrans.bannerFontFamily || '';
    var fontWeightStr = String(enTrans.bannerFontWeight || '600');
    var textAlign = enTrans.bannerTextAlign || 'left';
    if (textAlign !== 'center' && textAlign !== 'right') {
      textAlign = 'left';
    }
    var fontFamilyCss =
      fontName && String(fontName).length
        ? "'" + String(fontName).replace(/'/g, '') + "',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
        : "inherit";

    var positionStyles = '';
    var initialSize = 'width:520px;max-width:92vw;max-height:280px;min-height:0;overflow:hidden;';
    var initialRadius = 'border-radius:' + bannerRadius + ';';
    if (layoutVisual === 'banner') {
      initialSize = 'width:100%;max-width:none;';
      positionStyles = 'bottom:0;left:0;right:0;transform:none;';
      initialRadius = 'border-radius:' + bannerRadius + ';';
    } else if (layoutVisual === 'bottom-center') {
      initialSize = 'width:520px;max-width:92vw;max-height:280px;min-height:0;overflow:hidden;';
      positionStyles = 'bottom:32px;left:50%;transform:translateX(-50%);';
      initialRadius = 'border-radius:' + bannerRadius + ';';
    } else {
      if (position === 'bottom-left') {
        positionStyles = 'bottom:32px;left:32px;transform:none;';
      } else if (position === 'bottom-right') {
        positionStyles = 'bottom:32px;right:32px;transform:none;';
      } else if (position === 'bottom') {
        positionStyles = 'bottom:32px;left:50%;transform:translateX(-50%);';
      } else {
        positionStyles = 'bottom:32px;left:32px;transform:none;';
      }
    }

    customStyles = 
      "#cb-initial-banner.cb-banner{" +
        initialSize +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        positionStyles +
        "padding:16px;" +
        "border:1px solid #e2e8f0;" +
        initialRadius +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "font-family:" + fontFamilyCss + ";" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body{" +
        "flex:1 1 auto;" +
        "min-height:0;" +
        "overflow-y:auto;" +
      "}" +
      "#cb-preferences-banner.cb-banner{" +
        "width:540px;" +
        "max-width:92vw;" +
        "max-height:440px;" +
        "min-height:0;" +
        "overflow:hidden;" +
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
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-banner-body{" +
        "flex:1 1 auto;" +
        "min-height:0;" +
        "overflow-y:auto;" +
      "}" +
      ".cb-banner h3{" +
        "margin:0 0 8px;" +
        "font-size:16px!important;" +
        "line-height:1.4!important;" +
        "font-weight:" + fontWeightStr + ";" +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + ";" +
      "}" +
      /* Explicit overrides for both banners — higher specificity to beat static base rules. */
      "#cb-initial-banner.cb-banner h3," +
      "#cb-preferences-banner.cb-banner h3{" +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + ";" +
      "}" +
      ".cb-gdpr-cat-label{" +
        "color:" + headingColor + ";" +
      "}" +
      ".cb-banner p{" +
        "margin:0 0 12px;" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + ";" +
      "}" +
      /* Static base uses `#cb-initial-banner… .cb-banner-body > p` — must match dashboard text color + alignment. */
      "#cb-initial-banner.cb-banner .cb-banner-body > p," +
      "#cb-preferences-banner.cb-banner .cb-banner-body > p," +
      "#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + ";" +
        "opacity:0.92;" +
      "}" +
      ".cb-banner button{" +
        "padding:6px 12px;" +
        "border-radius:" + buttonRadius + ";" +
        "cursor:pointer;" +
        "font-size:14px;" +
        "font-weight:600;" +
        "border:1px solid #e2e8f0;" +
        "transition:opacity 0.2s;" +
      "}" +
      ".cb-banner button#cb-accept-all-btn{" +
        "background-color:" + acceptBg + ";" +
        "color:" + acceptTx + ";" +
        "border-color:" + acceptBg + ";" +
      "}" +
      ".cb-banner button#cb-reject-all-btn{" +
        "background-color:" + acceptBg + ";" +
        "color:" + acceptTx + ";" +
        "border-color:" + acceptBg + ";" +
      "}" +
      ".cb-banner button#cb-preferences-btn," +
      ".cb-banner button#cb-ccpa-donotsell-link{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      ".cb-banner button#cb-prefs-reject-btn{" +
        "background-color:" + acceptBg + ";" +
        "color:" + acceptTx + ";" +
        "border-color:" + acceptBg + ";" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      /* Dashboard preview: main banner row — outline Preference + solid Reject/Accept */
      "#cb-initial-banner.cb-banner .cb-banner-footer{" +
        "display:flex;" +
        "flex-wrap:wrap;" +
        "gap:8px;" +
        "justify-content:flex-start;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-preferences-btn{" +
        "background:" + custBg + "!important;" +
        "color:" + custTx + "!important;" +
        "border:1px solid " + custTx + "!important;" +
        "font-size:13px!important;" +
        "padding:2px 12px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-reject-all-btn," +
      "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
        "background:" + acceptBg + "!important;" +
        "color:" + acceptTx + "!important;" +
        "border-color:" + acceptBg + "!important;" +
        "font-size:13px!important;" +
        "padding:2px 12px!important;" +
        "font-weight:600!important;" +
      "}" +
      /* Cookie category accordion — match banner background (rows sit on same surface as prefs panel). */
      ".cb-gdpr-accordion{" +
        "background-color:" + bgColor + ";" +
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
    bannerEnabled,
    apiBase,
    gaId: GA_ID,
    styles: customStyles || null,
    customization: customization
      ? {
          position: customization.position,
          bannerLayoutVisual: bannerLayoutVisualForConfig,
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
          backgroundColor: customization.backgroundColor || '#ffffff',
          textColor: customization.textColor || '#334155',
          headingColor: customization.headingColor || '#0f172a',
          acceptButtonBg: customization.acceptButtonBg || '#007aff',
          acceptButtonText: customization.acceptButtonText || '#ffffff',
          customiseButtonBg: customization.customiseButtonBg || '#ffffff',
          customiseButtonText: customization.customiseButtonText || '#334155',
          bannerEntranceAnimation: (enTrans && enTrans.bannerEntranceAnimation) ? String(enTrans.bannerEntranceAnimation) : 'fade-in',
          showBannerLogo: customization.showBannerLogo == null ? true : (customization.showBannerLogo === 1 || customization.showBannerLogo === true),
          bannerLogoPosition: customization.bannerLogoPosition || 'left',
        }
      : null,
    floatingLogoUrl: resolveFloatingLogoUrl(),
    floatingLogoFallbackUrl: resolveWorkerFloatingLogoUrl(),
    /** CookieYes-style URL → category rules (serialized into embed). */
    scriptBlockProviders: SCRIPT_BLOCK_PROVIDERS,
    /** When true, the next page load triggers a full browser-based cookie + script scan. */
    pendingScan: resolvedSite.pendingScan === 1,
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
  var BANNER_ENABLED = siteConfig.bannerEnabled !== false;
  var API_BASE = siteConfig.apiBase;
  var GA_MEASUREMENT_ID = siteConfig.gaId || null;
  var CUSTOMIZATION = siteConfig.customization || null;
  var PENDING_SCAN = siteConfig.pendingScan === true;
  var BANNER_LAYOUT_VISUAL = CUSTOMIZATION ? (CUSTOMIZATION.bannerLayoutVisual || 'box') : 'box';
  var PRIVACY_POLICY_URL = CUSTOMIZATION ? CUSTOMIZATION.privacyPolicyUrl : null;
  var STOP_SCROLL = CUSTOMIZATION ? CUSTOMIZATION.stopScroll : false;
  var ANIMATION_ENABLED = CUSTOMIZATION ? (CUSTOMIZATION.animationEnabled !== false) : true;
  var BANNER_ENTRANCE_ANIMATION = CUSTOMIZATION ? (CUSTOMIZATION.bannerEntranceAnimation || 'fade-in') : 'fade-in';
  var PREFERENCE_POSITION = CUSTOMIZATION ? (CUSTOMIZATION.preferencePosition || 'center') : 'center';
  var CENTER_ANIMATION_DIRECTION = CUSTOMIZATION ? (CUSTOMIZATION.centerAnimationDirection || 'fade') : 'fade';
  var BANNER_LANGUAGE = CUSTOMIZATION ? (CUSTOMIZATION.language || 'en') : 'en';
  var AUTO_DETECT_LANGUAGE = CUSTOMIZATION ? (CUSTOMIZATION.autoDetectLanguage === true) : false;
  /** Show ConsentBit logo inside banner body. Default true; set showBannerLogo:false in customization to hide. */
  var SHOW_BANNER_LOGO = CUSTOMIZATION ? (CUSTOMIZATION.showBannerLogo !== false) : true;
  /** Logo alignment: 'left' | 'center' | 'right' — from banner config, default 'left'. */
  var BANNER_LOGO_POSITION = (CUSTOMIZATION && CUSTOMIZATION.bannerLogoPosition) ? String(CUSTOMIZATION.bannerLogoPosition) : 'left';
  
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

  /** First path segment before /, ?, # — no RegExp (loader is embedded in a template literal). */
  function privacyPolicyFirstSegment(u) {
    var s = u;
    var cut = s.indexOf('#');
    if (cut >= 0) s = s.slice(0, cut);
    cut = s.indexOf('?');
    if (cut >= 0) s = s.slice(0, cut);
    cut = s.indexOf('/');
    if (cut >= 0) s = s.slice(0, cut);
    return s.trim();
  }

  function privacyPolicyLooksLikeStaticFile(firstSeg) {
    var dot = firstSeg.lastIndexOf('.');
    if (dot < 0) return false;
    var ext = firstSeg.slice(dot).toLowerCase();
    return (
      ext === '.js' ||
      ext === '.mjs' ||
      ext === '.css' ||
      ext === '.png' ||
      ext === '.jpg' ||
      ext === '.jpeg' ||
      ext === '.gif' ||
      ext === '.svg' ||
      ext === '.webp' ||
      ext === '.pdf' ||
      ext === '.json' ||
      ext === '.xml' ||
      ext === '.ico' ||
      ext === '.woff' ||
      ext === '.woff2'
    );
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
    // Relative paths only — resolve on the host page
    if (
      u.charAt(0) === '/' ||
      u.indexOf('./') === 0 ||
      u.indexOf('../') === 0
    ) {
      try {
        if (typeof window !== 'undefined' && window.location) {
          return new URL(u, window.location.href).href;
        }
      } catch (e0) {}
      return u;
    }
    // Bare hostname (e.g. www.consentbit.com) — must NOT use URL(base) or it becomes
    // https://embed-host/www.consentbit.com
    var firstSeg = privacyPolicyFirstSegment(u);
    if (firstSeg.indexOf('.') > 0) {
      if (!privacyPolicyLooksLikeStaticFile(firstSeg)) {
        while (u.length > 0 && u.charAt(0) === '/') u = u.slice(1);
        return 'https://' + u;
      }
    }
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
    try {
      if (typeof releaseBlockedScripts === 'function') {
        releaseBlockedScripts();
      }
    } catch (eRel) {
      console.warn('[ConsentBit] releaseBlockedScripts failed', eRel);
    }
  }

  // ─── Preference toggle persistence (base64-encoded JSON in localStorage) ────
  var PREFS_KEY = 'consentbit_prefs_' + (SITE_ID || '');

  /**
   * Persist GDPR category toggle states as a base64-encoded JSON value so the
   * preference panel can be pre-populated correctly on every future page load.
   * @param {{ analytics: boolean, preferences: boolean, marketing: boolean }} cats
   */
  function savePreferenceToggles(cats) {
    try {
      var data = {
        analytics:   !!cats.analytics,
        preferences: !!cats.preferences,
        marketing:   !!cats.marketing
      };
      var encoded = btoa(JSON.stringify(data));
      localStorage.setItem(PREFS_KEY, encoded);
      console.log('[ConsentBit] Saved preference toggles (encoded)', data);
    } catch (e) {
      console.warn('[ConsentBit] Failed to save preference toggles', e);
    }
  }

  /**
   * Read back the encoded preference toggle states.
   * Returns null when no value is stored or the value cannot be decoded.
   * @returns {{ analytics: boolean, preferences: boolean, marketing: boolean } | null}
   */
  function loadPreferenceToggles() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return null;
      var decoded = JSON.parse(atob(raw));
      if (decoded && typeof decoded === 'object') {
        return {
          analytics:   !!decoded.analytics,
          preferences: !!decoded.preferences,
          marketing:   !!decoded.marketing
        };
      }
      return null;
    } catch (e) {
      console.warn('[ConsentBit] Failed to load preference toggles', e);
      return null;
    }
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

  // Client-side over-limit cache — avoids sending a network request on every page load
  // once the backend has told us we've exceeded the monthly pageview limit.
  // Stored in localStorage, keyed by yearMonth so it resets automatically next month.
  var CB_OVER_LIMIT_KEY = 'cb_pv_over_limit_' + (SITE_ID || '');
  function isPageviewOverLimit() {
    try {
      var val = localStorage.getItem(CB_OVER_LIMIT_KEY);
      if (!val) return false;
      var parsed = JSON.parse(val);
      var d = new Date();
      var ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      return parsed.yearMonth === ym && parsed.overLimit === true;
    } catch (e) { return false; }
  }
  function markPageviewOverLimit(yearMonth) {
    try { localStorage.setItem(CB_OVER_LIMIT_KEY, JSON.stringify({ overLimit: true, yearMonth: yearMonth })); } catch (e) {}
  }

  // Send anonymous pageview to backend for billing/usage.
  // Skips the network request entirely if already known to be over the monthly limit.
  function sendPageviewToServer() {
    if (!SITE_ID || !API_BASE) return;
    if (isPageviewOverLimit()) return; // skip — already over limit this month
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
      }).then(function(res) {
        return res.json();
      }).then(function(data) {
        // Cache the over-limit flag so the next page load skips the request
        if (data && data.overLimit) {
          var d = new Date();
          var ym = data.yearMonth || (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
          markPageviewOverLimit(ym);
        }
      }).catch(function(e) {
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

  function getPageScripts() {
    try {
      var list = [];
      var tags = document.getElementsByTagName('script');
      for (var i = 0; i < tags.length; i++) {
        var src = tags[i].src;
        if (src && src.indexOf('consentbit') === -1 && src.indexOf('client_data') === -1) {
          list.push(src);
        }
      }
      return list;
    } catch (e) {
      return [];
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
      // Check both src (active) and data-cb-blocked-src (blocked by consent manager)
      var src = s.src || s.getAttribute('data-cb-blocked-src') || '';
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

  /**
   * CookieYes-style dynamic script blocking: document.createElement hook + MutationObserver.
   * - Blocks by setting type="javascript/blocked" and storing src in data-cb-blocked-src.
   * - Re-runs when consent changes (releaseBlockedScripts).
   */
  var __cbInternalCreate = false;
  var __cbCreateElementBackup = null;
  var SCRIPT_BLOCK_PROVIDERS = siteConfig.scriptBlockProviders || [];

  function isGoogleAnalyticsScriptUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var u = url.toLowerCase();
    return (
      u.indexOf('googletagmanager.com/gtag/js') !== -1 ||
      u.indexOf('googletagmanager.com/gtm.js') !== -1 ||
      u.indexOf('google-analytics.com') !== -1
    );
  }

  function userAllowsCategoryForScript(category) {
    var cat = category;
    if (cat === 'behavioral') {
      cat = 'analytics';
    }
    if (cat === 'essential') return true;

    if (BANNER_TYPE === 'ccpa') {
      // CCPA is opt-out: allow all scripts until user explicitly opts out
      if (!consentState || !consentState.accepted) return true;
      var d = consentState.ccpa && consentState.ccpa.doNotSell;
      // If doNotSell is true, block all non-essential categories
      if (d && isNonEssential(cat)) return false;
      return true;
    }

    if (!consentState || !consentState.accepted) return false;
    var cats = consentState.categories || {};
    if (cat === 'analytics') return !!cats.analytics;
    if (cat === 'marketing') return !!cats.marketing;
    if (cat === 'preferences') return !!cats.preferences;
    return true;
  }

  /** data-consentbit /  value → category list, or null */
  function categoriesFromScriptTagAttr(raw) {
    if (!raw) return null;
    var c0 = String(raw).toLowerCase().trim();
    if (
      c0 === 'analytics' ||
      c0 === 'marketing' ||
      c0 === 'behavioral' ||
      c0 === 'preferences' ||
      c0 === 'essential'
    ) {
      return [c0 === 'essential' ? 'essential' : c0];
    }
    var cyLower = c0;
    if (cyLower.indexOf('necessary') >= 0 || cyLower.indexOf('essential') >= 0) {
      return ['essential'];
    }
    if (cyLower.indexOf('functional') >= 0 || cyLower.indexOf('preference') >= 0) {
      return ['preferences'];
    }
    if (cyLower.indexOf('analytics') >= 0 || cyLower.indexOf('performance') >= 0 || cyLower.indexOf('statistics') >= 0) {
      return ['analytics'];
    }
    if (cyLower.indexOf('advertisement') >= 0 || cyLower.indexOf('marketing') >= 0 || cyLower.indexOf('ads') >= 0) {
      return ['marketing'];
    }
    if (cyLower.indexOf('social') >= 0) {
      return ['marketing'];
    }
    if (cyLower.indexOf('other') >= 0) {
      return ['analytics'];
    }
    return null;
  }

  function resolveScriptCategories(url, el) {
    // 1. Explicit attribute on the tag (highest priority)
    if (el && el.getAttribute) {
      var fromCb = categoriesFromScriptTagAttr(el.getAttribute('data-consentbit'));
      if (fromCb) return fromCb;
      var dc = el.getAttribute('data-consentbit-category');
      if (dc) {
        var c1 = String(dc).toLowerCase().trim();
        if (c1 === 'analytics' || c1 === 'marketing' || c1 === 'behavioral' || c1 === 'preferences' || c1 === 'essential') {
          return [c1];
        }
      }
      var fromCy = categoriesFromScriptTagAttr(el.getAttribute('data-cookieyes'));
      if (fromCy) return fromCy;
    }
    // 2. URL pattern matching — SCRIPT_BLOCK_PROVIDERS is the sole source of truth
    if (url && SCRIPT_BLOCK_PROVIDERS.length) {
      for (var pi = 0; pi < SCRIPT_BLOCK_PROVIDERS.length; pi++) {
        var p = SCRIPT_BLOCK_PROVIDERS[pi];
        if (!p || !p.pattern) continue;
        try {
          if (new RegExp(p.pattern, 'i').test(url)) {
            return p.categories && p.categories.length ? p.categories.slice() : ['analytics'];
          }
        } catch (eRe) {}
      }
    }
    // 3. Not matched anywhere — unknown script, allow freely
    return [];
  }

  function shouldBlockScript(url, el) {
    if (__cbInternalCreate) return false;
    if (!url || typeof url !== 'string') return false;
    var u = url.toLowerCase();
    if (u.indexOf('consentbit') !== -1 || u.indexOf('client_data') !== -1) return false;

    var cats = resolveScriptCategories(url, el);
    // Not in SCRIPT_BLOCK_PROVIDERS and no attribute → not managed, allow freely
    if (!cats || cats.length === 0) return false;

    // CCPA: opt-out — allow all unless user explicitly opted out (doNotSell)
    if (BANNER_TYPE === 'ccpa') {
      if (!consentState || !consentState.accepted) return false;
      return !!(consentState.ccpa && consentState.ccpa.doNotSell);
    }

    // GDPR: opt-in — block any non-essential category not yet consented
    for (var j = 0; j < cats.length; j++) {
      var cat = cats[j];
      if (!isNonEssential(cat)) continue;
      // Allow Google Analytics script itself — uses Consent Mode for cookieless tracking
      if (cat === 'analytics' && isGoogleAnalyticsScriptUrl(url)) continue;
      if (!userAllowsCategoryForScript(cat)) return true;
    }
    return false;
  }

  function applyBlockToScriptNode(node) {
    if (!node || node.nodeName !== 'SCRIPT') return;
    if (node.getAttribute && node.getAttribute('type') === 'javascript/blocked') return;
    var src = (node.getAttribute && node.getAttribute('src')) || node.src || '';
    if (!src) return;
    var cats = resolveScriptCategories(src, node);
    var category = cats.length > 0 ? cats[0] : 'uncategorized';
    if (!shouldBlockScript(src, node)) {
      console.log('[ConsentBit][Dynamic] ALLOWED (dynamic inject):', src, '| category:', category);
      return;
    }
    try {
      node.setAttribute('data-cb-blocked-src', src);
      node.setAttribute('type', 'javascript/blocked');
      node.removeAttribute('src');
      console.log('[ConsentBit][Dynamic] BLOCKED (dynamic inject):', src, '| category:', category);
    } catch (eBl) {}
  }

  function patchDynamicScriptElement(el) {
    if (!el || el.__cbPatched) return;
    el.__cbPatched = true;
    try {
      Object.defineProperty(el, 'src', {
        configurable: true,
        enumerable: true,
        get: function () {
          return el.getAttribute('src') || '';
        },
        set: function (v) {
          var cats = resolveScriptCategories(v, el);
          var category = cats.length > 0 ? cats[0] : 'uncategorized';
          if (shouldBlockScript(v, el)) {
            el.setAttribute('data-cb-blocked-src', v);
            el.setAttribute('type', 'javascript/blocked');
            el.removeAttribute('src');
            console.log('[ConsentBit][Dynamic] BLOCKED (src set):', v, '| category:', category);
          } else {
            el.setAttribute('src', v);
            console.log('[ConsentBit][Dynamic] ALLOWED (src set):', v, '| category:', category);
          }
        }
      });
    } catch (eSrc) {}
    try {
      Object.defineProperty(el, 'type', {
        configurable: true,
        enumerable: true,
        get: function () {
          return el.getAttribute('type') || '';
        },
        set: function (val) {
          var v = val;
          if (shouldBlockScript(el.getAttribute('src') || el.src || '', el)) {
            v = 'javascript/blocked';
          }
          el.setAttribute('type', v);
        }
      });
    } catch (eTy) {}
  }

  function processNodeForBlocking(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.nodeName === 'SCRIPT') {
      applyBlockToScriptNode(node);
      return;
    }
    if (node.querySelectorAll) {
      var scripts = node.querySelectorAll('script[src]');
      for (var si = 0; si < scripts.length; si++) {
        applyBlockToScriptNode(scripts[si]);
      }
    }
  }

  function releaseBlockedScripts() {
    var list = document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');
    console.log('[ConsentBit][Release] releaseBlockedScripts called — total blocked scripts found:', list.length);
    var released = 0;
    var stillBlocked = 0;
    var stillBlockedList = [];
    var releasedList = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var src = el.getAttribute('data-cb-blocked-src');
      if (!src) continue;
      if (shouldBlockScript(src, el)) {
        stillBlocked++;
        stillBlockedList.push(src);
        continue;
      }
      __cbInternalCreate = true;
      try {
        var ns = document.createElement('script');
        ns.async = el.hasAttribute('async');
        ns.defer = el.hasAttribute('defer');
        ns.crossOrigin = el.crossOrigin || '';
        ns.integrity = el.integrity || '';
        ns.referrerPolicy = el.referrerPolicy || '';
        if (el.id) ns.id = el.id;
        ns.src = src;
        var attrs = el.attributes;
        for (var a = 0; a < attrs.length; a++) {
          var an = attrs[a].name;
          if (an === 'src' || an === 'type' || an === 'data-cb-blocked-src') continue;
          ns.setAttribute(an, attrs[a].value);
        }
        if (el.parentNode) {
          el.parentNode.replaceChild(ns, el);
        } else {
          document.head.appendChild(ns);
        }
        released++;
        releasedList.push(src);
        console.log('[ConsentBit][Release] RELEASED:', src);
      } catch (eR) {
        console.warn('[ConsentBit][Release] Failed to release script:', src, eR);
      } finally {
        __cbInternalCreate = false;
      }
    }
    console.log('[ConsentBit][Release] Summary — released:', released, '| still blocked:', stillBlocked);
    if (releasedList.length) console.log('[ConsentBit][Release] Released scripts:', releasedList);
    if (stillBlockedList.length) console.log('[ConsentBit][Release] Still blocked scripts:', stillBlockedList);
  }

  function installConsentScriptBlocker() {
    if (window.__cbCreateElementHookInstalled) return;
    window.__cbCreateElementHookInstalled = true;
    try {
      __cbCreateElementBackup = document.createElement.bind(document);
    } catch (eB) {
      __cbCreateElementBackup = document.createElement;
    }
    document.createElement = function (tagName) {
      var el = __cbCreateElementBackup(tagName);
      var tag = String(tagName || '').toLowerCase();
      if (tag === 'script') {
        patchDynamicScriptElement(el);
      }
      return el;
    };
    var obs = new MutationObserver(function (mutations) {
      for (var mi = 0; mi < mutations.length; mi++) {
        var m = mutations[mi];
        if (m.type === 'childList') {
          var adds = m.addedNodes;
          for (var ai = 0; ai < adds.length; ai++) {
            processNodeForBlocking(adds[ai]);
          }
        } else if (m.type === 'attributes' && m.attributeName === 'src' && m.target && m.target.nodeName === 'SCRIPT') {
          applyBlockToScriptNode(m.target);
        }
      }
    });
    try {
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
    } catch (eObs) {
      obs.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.__cbMutationObserver = obs;
    console.log('[ConsentBit] CookieYes-style script blocker installed');
  }

  function blockNonEssentialScripts() {
    // NOTE: This function runs at DOMContentLoaded. Scripts that were already parsed
    // and in the HTML *before* the ConsentBit <script> tag have already executed by this point —
    // setting type='javascript/blocked' on them has no effect on already-executed scripts.
    // For full pre-consent blocking, the ConsentBit <script> must be the FIRST script
    // in <head>, before any tracking tags, so the createElement hook intercepts them
    // as they are dynamically injected or parsed afterward.
    var scripts = collectScripts();
    console.log('[ConsentBit][Block] blockNonEssentialScripts called — total scripts on page:', scripts.length);
    var blocked = 0;
    var allowed = 0;
    var skipped = 0;
    var blockedList = [];
    var allowedList = [];

    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      var src = s.src;

      // Skip already-blocked scripts
      if (s.getAttribute('type') === 'javascript/blocked') {
        skipped++;
        continue;
      }

      // Resolve category from URL pattern
      var cats = resolveScriptCategories(src, s);
      var category = cats.length > 0 ? cats[0] : 'uncategorized';

      if (!isNonEssential(category)) {
        console.log('[ConsentBit][Block] ESSENTIAL (not blocking):', src, '| category:', category);
        allowed++;
        allowedList.push({ src: src, category: category, reason: 'essential' });
        continue;
      }

      // Allow GA for cookieless tracking
      if (category === 'analytics' && GA_MEASUREMENT_ID && isGoogleAnalyticsScriptUrl(src)) {
        console.log('[ConsentBit][Block] ALLOWED (GA cookieless tracking):', src);
        allowed++;
        allowedList.push({ src: src, category: category, reason: 'ga-cookieless' });
        continue;
      }

      // If consent already granted for this category, skip blocking
      if (userAllowsCategoryForScript(category)) {
        console.log('[ConsentBit][Block] ALLOWED (consent granted):', src, '| category:', category);
        allowed++;
        allowedList.push({ src: src, category: category, reason: 'consent-granted' });
        continue;
      }

      // Block: set type='javascript/blocked' so browser won't execute it.
      // Store src in data attribute so releaseBlockedScripts() can re-inject later.
      try {
        s.setAttribute('data-cb-blocked-src', src);
        s.setAttribute('type', 'javascript/blocked');
        s.removeAttribute('src');
        blocked++;
        blockedList.push({ src: src, category: category });
        console.log('[ConsentBit][Block] BLOCKED:', src, '| category:', category);
      } catch (eBl) {
        console.warn('[ConsentBit][Block] Failed to block script:', src, eBl);
      }
    }

    console.group('[ConsentBit][Block] === Consent Reject Summary ===');
    console.log('Total scripts scanned:', scripts.length);
    console.log('Blocked:', blocked);
    console.log('Allowed/essential:', allowed);
    console.log('Already blocked (skipped):', skipped);
    if (blockedList.length) console.table(blockedList);
    if (allowedList.length) console.log('[ConsentBit][Block] Allowed list:', allowedList);
    console.groupEnd();
  }

  function _enableDelayedScripts_unused() {
    console.log('[ConsentBit] Enabling delayed scripts, count:', delayedScripts.length);

    if (!delayedScripts.length) return;

    var remaining = [];
    __cbInternalCreate = true;
    try {
    for (var i = 0; i < delayedScripts.length; i++) {
      var item = delayedScripts[i];
      // Resolve categories from data-category or fallback to stored category
      var itemCats = item.cats || (item.category ? [item.category] : []);
      // Check if any of this script's non-essential categories are now allowed
      var canEnable = itemCats.length === 0 || itemCats.every(function(c) {
        return !isNonEssential(c) || userAllowsCategoryForScript(c);
      });
      if (!canEnable) {
        remaining.push(item);
        continue;
      }
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
    } finally {
      __cbInternalCreate = false;
    }

    delayedScripts = remaining;
  }

  // Optional YouTube/Maps embed + Google Fonts blocking was removed from the bundle (kept in repo history).
  // Using block comments around that code broke parsing: selectors like href*="..." can contain the sequence */.

  function initGoogleConsentMode() {
    if (!GA_MEASUREMENT_ID) {
      console.log('[ConsentBit] GA_MEASUREMENT_ID not set, skipping Google Consent Mode');
      return;
    }

    __cbInternalCreate = true;
    try {
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
    } finally {
      __cbInternalCreate = false;
    }
  }

  /**
   * Single shared helper — builds gtag consent payload from stored categories
   * and updates gtag. If window.gtag not ready, polls up to 2s.
   */
  function updateGtagConsentFromCategories(cats, label) {
    if (!GA_MEASUREMENT_ID && !hasGoogleTracking()) {
      console.warn('[ConsentBit]' + (label || '') + ' No Google tracking detected — gtag update skipped');
      return;
    }
    var payload = {
      analytics_storage:   cats.analytics   ? 'granted' : 'denied',
      ad_storage:          cats.marketing   ? 'granted' : 'denied',
      ad_user_data:        cats.marketing   ? 'granted' : 'denied',
      ad_personalization:  cats.preferences ? 'granted' : 'denied',
    };
    console.log('[ConsentBit]' + (label || '') + ' gtag consent update:', payload);
    if (window.gtag) {
      window.gtag('consent', 'update', payload);
      console.log('[ConsentBit]' + (label || '') + ' gtag updated. dataLayer length:', window.dataLayer ? window.dataLayer.length : 'n/a');
    } else {
      console.log('[ConsentBit]' + (label || '') + ' window.gtag not ready — polling (max 2s)');
      var retries = 0;
      var interval = setInterval(function () {
        retries++;
        if (window.gtag) {
          clearInterval(interval);
          console.log('[ConsentBit]' + (label || '') + ' gtag ready after', retries * 100, 'ms — applying:', payload);
          window.gtag('consent', 'update', payload);
        } else if (retries >= 20) {
          clearInterval(interval);
          console.warn('[ConsentBit]' + (label || '') + ' window.gtag unavailable after 2s — consent NOT updated');
        }
      }, 100);
    }
  }


  // --- Banner styles ---
  // Matching preview banner styles from defaultBannerConfig

  var BANNER_STYLES =
    "#cb-initial-banner.cb-banner{" +
      "width:520px;" +
      "max-width:92vw;" +
      "max-height:280px;" +
      "min-height:0;" +
      "overflow:hidden;" +
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
      "font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "font-size:14px!important;" +
      "line-height:1.5!important;" +
    "}" +
    "#cb-initial-banner.cb-banner .cb-banner-body{" +
      "flex:1 1 auto;" +
      "min-height:0;" +
      "overflow-y:auto;" +
    "}" +
    "#cb-preferences-banner.cb-banner{" +
      "width:540px;" +
      "max-width:92vw;" +
      "max-height:440px;" +
      "min-height:0;" +
      "overflow:hidden;" +
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
      "font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "font-size:14px!important;" +
      "line-height:1.5!important;" +
    "}" +
    "#cb-preferences-banner.cb-banner .cb-banner-body{" +
      "flex:1 1 auto;" +
      "min-height:0;" +
      "overflow-y:auto;" +
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
      "font-size:16px!important;" +
      "line-height:1.4!important;" +
      "font-weight:600;" +
      "color:#0f172a;" +
      "word-break:break-word;" +
      "overflow-wrap:anywhere;" +
      "max-width:100%;" +
    "}" +
    "#cb-initial-banner.cb-banner h3{" +
      "font-size:16px!important;" +
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
    ".cb-gdpr-cat-label{" +
      "color:#0f172a;" +
    "}" +
    ".cb-gdpr-cat-desc{" +
      "color:#64748b;" +
    "}" +
    ".cb-banner p{" +
      "margin:0 0 12px;" +
      "font-size:14px!important;" +
      "line-height:1.5!important;" +
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
      "font-size:14px;" +
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
      "background-color:#007aff;" +
      "color:#ffffff;" +
      "border-color:#007aff;" +
    "}" +
    ".cb-banner button#cb-preferences-btn," +
    ".cb-banner button#cb-ccpa-donotsell-link{" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "border-color:#e2e8f0;" +
    "}" +
    ".cb-banner button#cb-prefs-reject-btn{" +
      "background-color:#007aff;" +
      "color:#ffffff;" +
      "border-color:#007aff;" +
    "}" +
    // Save in prefs footer matches Preferences (customise) colors
    "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
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
    "@keyframes zoomIn{" +
      "from{transform:scale(0.85);opacity:0;}" +
      "to{transform:scale(1);opacity:1;}" +
    "}" +
    "@keyframes prefsZoomIn{" +
      "from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}" +
      "to{transform:translate(-50%,-50%) scale(1);opacity:1;}" +
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
    ".cb-banner-animate-zoom-in{" +
      "animation:zoomIn 0.3s ease-out;" +
    "}" +
    ".cb-banner-animate-prefs-zoom-in{" +
      "animation:prefsZoomIn 0.3s ease-out;" +
    "}" +
    "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
      "background-color:#ffffff;" +
      "color:#334155;" +
      "border-color:#e2e8f0;" +
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
      "color:#334155!important;" +
      "border:1px solid #334155!important;" +
      "font-size:13px!important;" +
      "padding:2px 12px!important;" +
      "font-weight:600!important;" +
    "}" +
    "#cb-initial-banner.cb-banner #cb-reject-all-btn," +
    "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
      "background:#007aff!important;" +
      "color:#ffffff!important;" +
      "border-color:#007aff!important;" +
      "font-size:13px!important;" +
      "padding:2px 12px!important;" +
      "font-weight:600!important;" +
    "}" +
    "#cb-floating-trigger{" +
      "position:fixed;" +
      "z-index:2147483648;" +
      "width:40px;" +
      "height:40px;" +
      "border:none;" +
      "border-radius:9999px;" +
      "background:transparent;" +
      "cursor:pointer;" +
      "padding:0;" +
      "box-shadow:none;" +
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

    var cuBg = (CUSTOMIZATION && CUSTOMIZATION.customiseButtonBg) ? String(CUSTOMIZATION.customiseButtonBg) : '#ffffff';
    var cuTx = (CUSTOMIZATION && CUSTOMIZATION.customiseButtonText) ? String(CUSTOMIZATION.customiseButtonText) : '#334155';
    // Always last: Save in prefs footer matches Preferences (customise) — same as dashboard preview.
    var savePrefsOverride =
      '#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{' +
        'background-color:' + cuBg + ' !important;' +
        'color:' + cuTx + ' !important;' +
        'border-color:#e2e8f0 !important;' +
      '}';
    // Ensure banner + GDPR category accordion surface use saved background (beats stale base CSS order).
    var bannerBgOverride = '';
    if (CUSTOMIZATION && CUSTOMIZATION.backgroundColor) {
      var bbg = String(CUSTOMIZATION.backgroundColor);
      bannerBgOverride =
        '#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{' +
          'background-color:' + bbg + ' !important;' +
        '}' +
        '.cb-gdpr-accordion{' +
          'background-color:' + bbg + ' !important;' +
        '}';
    }

    var headingColorOverride = '';
    if (CUSTOMIZATION && CUSTOMIZATION.headingColor) {
      var hCol = String(CUSTOMIZATION.headingColor);
      headingColorOverride =
        '#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{' +
          'color:' + hCol + ' !important;' +
        '}' +
        '.cb-gdpr-cat-label{' +
          'color:' + hCol + ' !important;' +
        '}';
    }

    var textColorOverride = '';
    if (CUSTOMIZATION && CUSTOMIZATION.textColor) {
      var txCol = String(CUSTOMIZATION.textColor);
      textColorOverride =
        '#cb-initial-banner.cb-banner .cb-banner-body > p,' +
        '#cb-preferences-banner.cb-banner .cb-banner-body > p,' +
        '#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{' +
          'color:' + txCol + ' !important;' +
        '}';
    }

    // Inject Montserrat from Google Fonts as default banner font
    if (!document.getElementById('cb-font-montserrat')) {
      var fontLink = document.createElement('link');
      fontLink.id = 'cb-font-montserrat';
      fontLink.rel = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap';
      document.head.appendChild(fontLink);
    }

    var style = document.createElement("style");
    style.id = "cb-styles";
    style.type = "text/css";
    style.appendChild(document.createTextNode(BANNER_STYLES + '\\n' + savePrefsOverride + '\\n' + bannerBgOverride + '\\n' + headingColorOverride + '\\n' + textColorOverride));
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

  /** Creates logo element for banner headers using the resolved floating logo URL. */
  function createBannerLogo() {
    if (!SHOW_BANNER_LOGO) return null;
    var url = FLOATING_LOGO_URL || FLOATING_LOGO_FALLBACK_URL || '';
    if (!url) return null;
    var alignMap = { left: 'flex-start', center: 'center', right: 'flex-end' };
    var justifyContent = alignMap[BANNER_LOGO_POSITION] || 'flex-start';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;justify-content:' + justifyContent + ';margin-bottom:8px;';
    var img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.setAttribute('width', '80');
    img.setAttribute('height', '20');
    img.draggable = false;
    img.style.cssText = 'display:block;max-width:80px;height:20px;object-fit:contain;';
    img.addEventListener('error', function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); });
    wrap.appendChild(img);
    return wrap;
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
      checkbox.checked = !!(consentState && consentState.accepted && consentState.ccpa && consentState.ccpa.doNotSell);
      label.appendChild(checkbox);
      label.appendChild(labelText);
      prefsBody.appendChild(label);
      prefsBanner.appendChild(prefsBody);
      
      var prefsFooter = document.createElement("div");
      prefsFooter.className = "cb-banner-footer";
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
        lab.className = "cb-gdpr-cat-label";
        lab.style.cssText = "flex:1;font-size:11px;font-weight:600;";
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
        desc.className = "cb-gdpr-cat-desc";
        desc.style.cssText =
          "display:none;padding:0 12px 12px 44px;font-size:13px;line-height:1.5;";
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
      // Prefer the separately encoded toggle state; fall back to categories in consentState.
      var _savedToggles = loadPreferenceToggles();
      var storedCats = _savedToggles
        || (consentState && consentState.accepted && consentState.categories)
        || {};
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: getTranslation("marketing"),
          checkboxId: "cb-pref-marketing",
          defaultChecked: !!storedCats.marketing,
          descText: getTranslation("marketingDescription"),
        })
      );
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: getTranslation("analytics"),
          checkboxId: "cb-pref-analytics",
          defaultChecked: !!storedCats.analytics,
          descText: getTranslation("analyticsDescription"),
        })
      );
      catList.appendChild(
        makeGdprPrefCategoryBlock({
          labelText: getTranslation("preferences"),
          checkboxId: "cb-pref-preferences",
          defaultChecked: !!storedCats.preferences,
          descText: getTranslation("preferencesDescription"),
        })
      );
      if (catList.lastChild) catList.lastChild.style.borderBottom = "none";
      prefsBody.appendChild(catList);
      prefsBanner.appendChild(prefsBody);
      
      var prefsFooter = document.createElement("div");
      prefsFooter.className = "cb-banner-footer";
      var prefsRejectBtn = document.createElement("button");
      prefsRejectBtn.id = "cb-prefs-reject-btn";
      prefsRejectBtn.textContent = getTranslation("rejectAll");
      prefsFooter.appendChild(prefsRejectBtn);
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
    
    // Floating button stays visible even when banner is showing

    // Ensure banner is visible and apply animation
    var initialBannerEl = document.getElementById("cb-initial-banner");
    if (initialBannerEl) {
      initialBannerEl.style.display = "flex";
      initialBannerEl.style.visibility = "visible";
      initialBannerEl.style.opacity = "1";
      
      // Apply animation based on entrance animation setting
      if (ANIMATION_ENABLED) {
        var animClass = '';
        var anim = BANNER_ENTRANCE_ANIMATION;
        if (anim === 'slide-up') animClass = 'cb-banner-animate-bottom';
        else if (anim === 'slide-down') animClass = 'cb-banner-animate-top';
        else if (anim === 'zoom-in') animClass = 'cb-banner-animate-zoom-in';
        else animClass = 'cb-banner-animate-fade';
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
    'cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom ' +
    'cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in';

  function getPreferenceBannerAnimClass() {
    if (!ANIMATION_ENABLED) return '';
    var anim = BANNER_ENTRANCE_ANIMATION;
    if (anim === 'slide-up') return 'cb-banner-animate-center-bottom';
    if (anim === 'slide-down') return 'cb-banner-animate-center-top';
    if (anim === 'zoom-in') return 'cb-banner-animate-prefs-zoom-in';
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
    // Floating button stays visible regardless of banner state

    var initialBanner = document.getElementById("cb-initial-banner");
    var prefsBanner   = document.getElementById("cb-preferences-banner");

    var btnPrefs      = document.getElementById("cb-preferences-btn");
    var btnAcceptAll  = document.getElementById("cb-accept-all-btn");
    var btnRejectAll  = document.getElementById("cb-reject-all-btn");
    var btnPrefsReject   = document.getElementById("cb-prefs-reject-btn");
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
      // Show floating button when banner is dismissed
      var floatBtnEl = document.getElementById('cb-floating-trigger');
      if (floatBtnEl) floatBtnEl.style.display = 'flex';
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
      // Hide floating button while initial banner is visible
      // var floatBtnShow = document.getElementById('cb-floating-trigger');
      // if (floatBtnShow) floatBtnShow.style.display = 'none';
      initialBanner.style.display = "flex";
      initialBanner.style.visibility = "visible";
      initialBanner.style.opacity = "1";
      initialBanner.classList.remove('cb-banner-animate-left', 'cb-banner-animate-right', 'cb-banner-animate-top', 'cb-banner-animate-bottom', 'cb-banner-animate-fade', 'cb-banner-animate-zoom-in');
      if (ANIMATION_ENABLED) {
        var animClass2 = '';
        var anim2 = BANNER_ENTRANCE_ANIMATION;
        if (anim2 === 'slide-up') animClass2 = 'cb-banner-animate-bottom';
        else if (anim2 === 'slide-down') animClass2 = 'cb-banner-animate-top';
        else if (anim2 === 'zoom-in') animClass2 = 'cb-banner-animate-zoom-in';
        else animClass2 = 'cb-banner-animate-fade';
        initialBanner.classList.add(animClass2);
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
      // Sync GDPR toggle states from the encoded localStorage value (most authoritative),
      // falling back to in-memory consentState, before the preferences panel is shown.
      if (!isCCPA) {
        var _toggleState = loadPreferenceToggles() || (consentState && consentState.categories) || {};
        var syncToggle = function (checkboxId, val) {
          var cbEl = document.getElementById(checkboxId);
          if (!cbEl) return;
          cbEl.checked = !!val;
          var track = cbEl.parentNode && cbEl.parentNode.querySelector('button.cb-pref-toggle-track');
          if (track) track.setAttribute('aria-checked', cbEl.checked ? 'true' : 'false');
        };
        syncToggle('cb-pref-analytics', _toggleState.analytics);
        syncToggle('cb-pref-preferences', _toggleState.preferences);
        syncToggle('cb-pref-marketing', _toggleState.marketing);
      }
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

    btnPrefsReject && btnPrefsReject.addEventListener("click", function () {
      console.log("[ConsentBit] User clicked Reject All (preferences banner)");
      var consentR = {
        accepted: true,
        timestamp: new Date().toISOString(),
        categories: { essential: true, analytics: false, preferences: false, marketing: false }
      };
      saveConsent(consentR);
      sendConsentToServer(consentR, { status: 'rejected' });
      savePreferenceToggles(consentR.categories);
      updateGtagConsentFromCategories(consentR.categories, '[PrefsReject]');
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
        savePreferenceToggles(consentR.categories);

        updateGtagConsentFromCategories(consentR.categories, '[Reject]');
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

        releaseBlockedScripts();
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
        savePreferenceToggles(consentG.categories);

        releaseBlockedScripts();
        updateGtagConsentFromCategories(consentG.categories, '[Accept]');
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

        if (!optout) {
          releaseBlockedScripts();
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
        savePreferenceToggles(consentG.categories);

        releaseBlockedScripts();
        updateGtagConsentFromCategories(consentG.categories, '[Save]');
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
      // Always block non-essential scripts first
      blockNonEssentialScripts();

      if (GA_MEASUREMENT_ID || hasGoogle) {
        // Step 1: Always set consent default denied first (required before GTM processes tags)
        if (window.gtag) {
          console.log('[ConsentBit][GDPR] Setting gtag consent default: all denied');
          window.gtag('consent', 'default', {
            analytics_storage: 'denied',
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied',
            functionality_storage: 'denied',
            personalization_storage: 'denied',
            security_storage: 'granted',
            wait_for_update: 500,
          });
        }

        // Step 2: If prior consent exists, immediately update with stored values
        if (consentState.accepted) {
          console.log('[ConsentBit][Reload] Prior consent found — restoring gtag from stored categories:', consentState.categories);
          updateGtagConsentFromCategories(consentState.categories || {}, '[Reload]');
        } else {
          console.log('[ConsentBit][GDPR] No prior consent — banner will show, gtag stays denied');
          if (GA_MEASUREMENT_ID) initGoogleConsentMode();
        }
      }
    }

    console.log('[ConsentBit] Checking if banner should show:', {
      consentAccepted: consentState.accepted,
      bannerType: BANNER_TYPE,
      shouldShow: !consentState.accepted
    });
    
    // Show banner if consent not given and banner is enabled for this visitor's region
    if (!BANNER_ENABLED) {
      // CCPA-only site, visitor is outside US — no banner needed
      console.log('[ConsentBit] Banner suppressed for this region');
    } else if (!consentState.accepted) {
      console.log('[ConsentBit] Calling showBanner()');
      showBanner();
    } else {
      console.log('[ConsentBit] Banner not shown - consent already accepted');
      // Initialize full UI (renders banner DOM + attaches floating button click handler)
      // so the user can always reopen preferences after accepting.
      initConsentBitBannerUI();
      // Immediately hide the initial banner — consent was already given.
      var ib = document.getElementById('cb-initial-banner');
      if (ib) ib.style.display = 'none';
      // Ensure floating button is visible.
      var fb = document.getElementById('cb-floating-trigger');
      if (fb) fb.style.display = 'flex';
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


    console.log('[ConsentBit] Init complete');
  }

  // Install the createElement hook + MutationObserver IMMEDIATELY — before DOMContentLoaded.
  // This ensures scripts added by other tags that load after us (but before DOM ready) are also caught.
  // Static scripts already in the HTML above this tag cannot be intercepted — the browser
  // has already queued them for execution. The consentbit <script> tag must be the FIRST
  // script in <head> before any tracking scripts for full blocking to work.
  installConsentScriptBlocker();

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();`;

  // ETag based on site's updatedAt + customization — changes whenever settings change.
  const etag = `"${resolvedSite.id}-${resolvedSite.updatedAt || Date.now()}"`;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const loaderIab=`
${inlineConfig}
(function () {
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
  var siteConfig = window.__CONSENT_SITE__ || {};
  var CUSTOMIZATION = siteConfig.customization || {};
  var SITE_ID = siteConfig.id || null;
  var API_BASE = siteConfig.apiBase || '';
  var PRIVACY_POLICY_URL = CUSTOMIZATION.privacyPolicyUrl || '';

  const styleConfig = {
    bannerBg:          CUSTOMIZATION.backgroundColor     || "#FFFFFF",
    textColor:         CUSTOMIZATION.textColor           || "#334155",
    headingColor:      CUSTOMIZATION.headingColor        || "#0f172a",
    buttonColor:       CUSTOMIZATION.customiseButtonBg   || "#ffffff",
    buttonTextColor:   CUSTOMIZATION.customiseButtonText || "#334155",
    SecButtonColor:    CUSTOMIZATION.acceptButtonBg      || "#007AFF",
    SecButtonTextColor:CUSTOMIZATION.acceptButtonText    || "#ffffff",
    textAlign:         CUSTOMIZATION.bannerTextAlign     || "left",
    fontWeight:        CUSTOMIZATION.bannerFontWeight    || "400",
    borderRadius:      CUSTOMIZATION.bannerBorderRadius != null ? String(CUSTOMIZATION.bannerBorderRadius).replace('rem','').replace('px','') : "12",
    bannerType:        CUSTOMIZATION.bannerLayoutVisual  || "box",
    boxAlignment:      CUSTOMIZATION.position            || "bottom-left",
  };
// ─── Inject all styles ───────────────────────────────────────────────────────
function injectStyles() {
  const s = styleConfig;
  const br  = s.borderRadius + "px";
  const brSm = Math.min(Number(s.borderRadius), 8) + "px";
  const brPill = Math.min(Number(s.borderRadius), 999) + "px";

  const css = \`
/* ── Vendor List & Search ── */
.consentBit-vendors-search-wrapper{max-height:500px;overflow-y:auto;padding:20px}
.consentBit-search-container{position:relative;margin-bottom:20px}
.consentBit-search-input{width:100%;padding:12px 16px 12px 44px;border:2px solid #e0e0e0;border-radius:\${brSm};font-size:14px;transition:border-color .2s ease;background:#fff;box-sizing:border-box}
.consentBit-search-input:focus{outline:none;border-color:\${s.SecButtonColor};box-shadow:0 0 0 3px \${s.SecButtonColor}22}
.consentBit-search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:16px;color:#666;pointer-events:none}
.consentBit-vendors-list{display:flex;flex-direction:column;gap:12px}
.consentBit-vendor-item{padding:16px;border:1px solid #f0f0f0;border-radius:\${brSm};background:#fafafa;transition:all .2s ease;animation:consentBit-fadeIn .3s ease}
.consentBit-vendor-item:hover{border-color:\${s.SecButtonColor};background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.consentBit-vendor-item.consentBit-hidden{display:none!important}
.consentBit-vendor-header{display:flex;justify-content:space-between;align-items:center;gap:16px}
.consentBit-vendor-info{flex:1}
.consentBit-vendor-name{font-weight:600;font-size:15px;color:\${s.headingColor};margin-bottom:4px}
.consentBit-vendor-id{font-size:12px;color:#666;font-family:monospace}
.consentBit-switch-wrapper{flex-shrink:0}
.consentBit-consent-switch-wrapper{display:flex;align-items:center;gap:8px}
.consentBit-switch-label{font-size:13px;font-weight:500;color:\${s.textColor}}
.consentBit-switch-sm{position:relative;width:36px;height:20px}
.consentBit-switch-sm input{opacity:0;width:0;height:0}
.consentBit-switch-sm input:checked+.consentBit-slider{background-color:\${s.SecButtonColor}}
.consentBit-switch-sm input:focus+.consentBit-slider{box-shadow:0 0 1px \${s.SecButtonColor}}
.consentBit-switch-sm input:checked+.consentBit-slider:before{transform:translateX(16px)}
.consentBit-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#ccc;transition:.2s;border-radius:20px}
.consentBit-slider:before{position:absolute;content:"";height:16px;width:16px;left:2px;top:2px;background-color:#fff;transition:.2s;border-radius:50%}
.consentBit-no-results{text-align:center;padding:40px 20px;color:#666}
.consentBit-no-results p{margin:0 0 4px 0;font-size:16px}
.consentBit-empty-vendors-text{text-align:center;color:#666;padding:40px;font-style:italic}
.consentBit-loading{text-align:center;padding:40px;color:\${s.textColor}}
@keyframes consentBit-fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

/* ── Cookie Consent Banner ── */
.consentBit-consent-container{
  position:fixed;
  z-index:999999;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  border-radius:\${br};
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
  background:\${s.bannerBg};
  border-radius:\${br};
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
  color:\${s.headingColor};
  text-align:\${s.textAlign};
}
.consentBit-notice-group{display:flex;flex-direction:column;gap:20px}
.consentBit-notice-des{
  flex:1;
  color:\${s.textColor};
  line-height:1.6;
  font-size:14px;
  font-weight:\${s.fontWeight};
  text-align:\${s.textAlign};
}
.consentBit-notice-des p{margin:0 0 12px 0}
.consentBit-notice-des p:last-child{margin-bottom:0}
.consentBit-iab-dec-btn{
  background:none;border:none;
  color:\${s.SecButtonColor};
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
  justify-content:\${s.textAlign === "center" ? "center" : s.textAlign === "right" ? "flex-end" : "flex-start"};
}

/* ── Buttons ── */
.consentBit-btn{
  padding:11px 20px;
  border-radius:\${brSm};
  font-size:14px;
  font-weight:\${s.fontWeight};
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
  color:\${s.buttonTextColor};
  background:\${s.buttonColor};
  border-color:\${s.buttonTextColor};
}

/* Accept All — solid primary */
.consentBit-btn-accept{
  color:\${s.SecButtonTextColor};
  background:\${s.SecButtonColor};
  border-color:\${s.SecButtonColor};
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
  background-color:\${s.bannerBg};
  border:1px solid #f4f4f4;
  border-radius:\${br};
  max-width:720px;width:100%;
  max-height:90vh;
  display:flex;flex-direction:column;
  box-shadow:0 4px 20px rgba(0,0,0,.15);
}
.cb-preference-header{padding:20px 24px;border-bottom:1px solid #f4f4f4;display:flex;justify-content:space-between;align-items:center}
.cb-preference-title{font-size:18px;font-weight:600;color:\${s.headingColor}}
.cb-btn-close{background:none;border:none;cursor:pointer;padding:4px;opacity:.5;transition:opacity .2s}
.cb-btn-close:hover{opacity:1}
.cb-btn-close img{width:20px;height:20px}
.cb-iab-detail-wrapper{flex:1;overflow-y:auto;padding:0 24px 24px}
.cb-iab-preference-des{
  padding:16px 0;
  color:\${s.textColor};
  font-size:13px;
  line-height:1.7;
  font-weight:\${s.fontWeight};
  text-align:\${s.textAlign};
}
.cb-iab-dec-btn{background:none;border:none;color:\${s.SecButtonColor};text-decoration:underline;cursor:pointer;font-size:inherit;padding:0}
.cb-iab-navbar-wrapper{margin-bottom:24px;border-bottom:2px solid #f4f4f4}
.cb-iab-navbar{display:flex;list-style:none;gap:0;padding:0;margin:0}
.cb-iab-nav-item{flex:1}
.cb-iab-nav-btn{
  width:100%;padding:12px 16px;
  background:none;border:none;
  border-bottom:3px solid transparent;
  cursor:pointer;font-size:13px;font-weight:\${s.fontWeight};
  color:\${s.textColor};opacity:.6;
  transition:all .2s;
}
.cb-iab-nav-item-active .cb-iab-nav-btn{
  color:\${s.SecButtonColor};
  border-bottom-color:\${s.SecButtonColor};
  opacity:1;font-weight:600;
}
.cb-iab-nav-btn:hover{background-color:#f9f9f9}
.cb-preference-body-wrapper{display:none}
.cb-preference-body-wrapper.active{display:block}
.cb-iab-detail-title{
  font-size:16px;font-weight:600;
  color:\${s.headingColor};
  margin-bottom:14px;
  text-align:\${s.textAlign};
}
.cb-preference-content-wrapper{
  color:\${s.textColor};
  font-size:13px;
  font-weight:\${s.fontWeight};
  line-height:1.6;
  margin-bottom:20px;
  text-align:\${s.textAlign};
}
.cb-show-desc-btn{background:none;border:none;color:\${s.SecButtonColor};cursor:pointer;font-size:inherit;text-decoration:underline;padding:0}
.cb-horizontal-separator{height:1px;background-color:#ebebeb;margin:20px 0}
.cb-accordion-wrapper{display:flex;flex-direction:column;gap:10px}
.cb-accordion{border:1px solid #ebebeb;border-radius:\${brSm};overflow:hidden;background:\${s.bannerBg}}
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
  color:\${s.headingColor};
  cursor:pointer;text-align:\${s.textAlign};padding:0;
}
.cb-always-active{
  padding:3px 10px;
  background-color:#DCFCE7;color:#166534;
  border-radius:\${brPill};
  font-size:11px;font-weight:500;
}
.cb-accordion-header-des{
  color:\${s.textColor};
  font-size:13px;
  font-weight:\${s.fontWeight};
  line-height:1.6;
  text-align:\${s.textAlign};
}
.cb-switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
.cb-switch input{opacity:0;width:0;height:0}
.cb-switch input[type="checkbox"]{appearance:none;width:44px;height:24px;background-color:#d0d5d2;border-radius:12px;position:relative;cursor:pointer;transition:background-color .2s}
.cb-switch input[type="checkbox"]:checked{background-color:\${s.SecButtonColor}}
.cb-switch input[type="checkbox"]::before{content:'';position:absolute;width:18px;height:18px;border-radius:50%;background-color:#fff;top:3px;left:3px;transition:transform .2s}
.cb-switch input[type="checkbox"]:checked::before{transform:translateX(20px)}
.cb-accordion-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
.cb-accordion.active .cb-accordion-body{max-height:2000px}
.cb-audit-table{background-color:#f4f4f4;border:1px solid #ebebeb;border-radius:\${brSm};padding:14px;margin:0 14px 14px 28px}
.cb-cookie-des-table{list-style:none;margin-bottom:14px;padding:0 0 14px 0;border-bottom:1px solid #ebebeb}
.cb-cookie-des-table:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none}
.cb-cookie-des-table li{display:flex;margin-bottom:6px;font-size:12px}
.cb-cookie-des-table li div:first-child{font-weight:600;min-width:90px;color:\${s.textColor};opacity:.6}
.cb-cookie-des-table li div:last-child{color:\${s.textColor}}
.cb-empty-cookies-text{color:\${s.textColor};opacity:.5;font-style:italic;text-align:center;padding:16px}
.cb-child-accordion{border-top:1px solid #ebebeb}
.cb-child-accordion:first-child{border-top:none}
.cb-child-accordion-item{display:flex;gap:12px;padding:12px 16px;cursor:pointer;transition:background-color .2s}
.cb-child-accordion-item:hover{background-color:#f9f9f9}
.cb-child-accordion-chevron{flex-shrink:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center}
.cb-child-accordion.active .cb-chevron-right{transform:rotate(90deg)}
.cb-child-accordion-header-wrapper{flex:1;display:flex;justify-content:space-between;align-items:center;gap:16px}
.cb-child-accordion-btn{background:none;border:none;font-size:13px;font-weight:500;color:\${s.headingColor};cursor:pointer;text-align:left;padding:0;flex:1}
.cb-child-accordion-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
.cb-child-accordion.active .cb-child-accordion-body{max-height:2000px}
.cb-iab-ad-settings-details{padding:14px;background-color:#f9f9f9;margin:0 14px 14px;border-radius:\${brSm}}
.cb-iab-ad-settings-details-des{color:\${s.textColor};font-size:13px;line-height:1.6;margin-bottom:12px;font-weight:\${s.fontWeight}}
.cb-iab-illustrations-title{font-weight:600;color:\${s.headingColor};margin-bottom:6px;font-size:13px}
.cb-iab-illustrations-des{list-style:none;padding-left:0}
.cb-iab-illustrations-des li{padding-left:18px;position:relative;margin-bottom:10px;color:\${s.textColor};font-size:12px;line-height:1.6;font-weight:\${s.fontWeight}}
.cb-iab-illustrations-des li::before{content:'•';position:absolute;left:0;color:\${s.SecButtonColor}}
.cb-iab-vendors-count-wrapper{margin-top:12px;font-size:12px;color:\${s.textColor};opacity:.6;font-weight:500}
.cb-switch-wrapper{display:flex;gap:12px;align-items:center;flex-shrink:0}
.cb-switch-separator{padding-right:12px;border-right:1px solid #ddd}
.cb-legitimate-switch-wrapper,.cb-consent-switch-wrapper{display:flex;align-items:center;gap:6px}
.cb-switch-label{font-size:11px;color:\${s.textColor};opacity:.6;font-weight:500;white-space:nowrap}
.cb-switch-sm{position:relative;display:inline-block}
.cb-switch-sm input[type="checkbox"]{appearance:none;width:36px;height:20px;background-color:#d0d5d2;border-radius:10px;position:relative;cursor:pointer;transition:background-color .2s}
.cb-switch-sm input[type="checkbox"]:checked{background-color:\${s.SecButtonColor}}
.cb-switch-sm input[type="checkbox"]::before{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background-color:#fff;top:3px;left:3px;transition:transform .2s}
.cb-switch-sm input[type="checkbox"]:checked::before{transform:translateX(16px)}
.cb-switch-sm input[type="checkbox"]:disabled{cursor:not-allowed}
.cb-switch-sm input[type="checkbox"]:disabled:checked{opacity:.7}
.cb-footer-wrapper{border-top:1px solid #f4f4f4;background-color:\${s.bannerBg};flex-shrink:0}
.cb-footer-shadow{display:block;height:20px;margin-top:-20px;background:linear-gradient(180deg,rgba(255,255,255,0) 0%,\${s.bannerBg} 100%)}
.cb-prefrence-btn-wrapper{
  padding:14px 22px;
  display:flex;gap:10px;
  justify-content:\${s.textAlign === "center" ? "center" : s.textAlign === "right" ? "flex-start" : "flex-end"};
  flex-wrap:wrap;
}
.cb-btn{
  padding:9px 20px;border-radius:\${brSm};
  font-size:13px;font-weight:\${s.fontWeight};
  cursor:pointer;transition:opacity .2s;
  border:2px solid;
  white-space:nowrap;
}
.cb-btn:hover{opacity:.85}
.cb-btn-reject{
  background-color:\${s.buttonColor};
  color:\${s.buttonTextColor};
  border-color:\${s.buttonTextColor};
}
.cb-btn-preferences{
  background-color:\${s.buttonColor};
  color:\${s.buttonTextColor};
  border-color:\${s.buttonTextColor};
}
.cb-btn-accept{
  background-color:\${s.SecButtonColor};
  color:\${s.SecButtonTextColor};
  border-color:\${s.SecButtonColor};
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
\`;

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
    ? "<div class='consentBit-popup-overlay' id='consentBitPopupOverlay'></div>"
    : "";

  const bannerHTML = \`
\${popupOverlay}

<div class="consentBit-consent-container \${bannerPositionClass}"
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
\`;

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

  const scriptToServe = resolvedSite.banner_type === 'iab' ? loaderIab : loader;
  console.log(`Serving CDN script for banner type: ${resolvedSite.banner_type}`);

  return new Response(scriptToServe, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, must-revalidate',
      'ETag': etag,
    },
  });
}