import { getBannerCustomization, getEffectivePlanForOrganization, getSubscriptionBySiteId, inferTierPlanIdFromStripePriceId } from '../services/db.js';
import { authorizeRequestHost } from '../utils/domainValidate.js';
import { trackCustomDomain } from '../services/domainResolver.js';
import { mergeTranslations } from '../data/defaultTranslations.js';
import { SCRIPT_BLOCK_PROVIDERS } from '../data/scriptBlockProviders.js';
import { getLoaderIabScript } from '../utils/IabCode.js';
import { getWebflowSetupScript } from '../utils/webflowSetup.js';

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
  if (cdnScriptId === 'script.js' && parts.length > 2) {
    cdnScriptId = parts[parts.length - 2];
  }
  if (cdnScriptId.endsWith('.js')) {
    cdnScriptId = cdnScriptId.slice(0, -3);
  }

  const db = env.CONSENT_WEBAPP;

  const site = await db
    .prepare(
      'SELECT * FROM Site WHERE cdnScriptId = ?1'
    )
    .bind(cdnScriptId)
    .first();

  let resolvedSite = site;
  if (!resolvedSite) {
    resolvedSite = await db
      .prepare(
        'SELECT * FROM Site WHERE id = ?1'
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

  let authorizedHost = null;

  if (resolvedSite.domain) {
    const siteHost = String(resolvedSite.domain)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();

    const origin = request.headers.get('Origin') || request.headers.get('origin') || '';
    const referer = request.headers.get('Referer') || request.headers.get('referer') || '';

    const sourceHeader = origin || referer;

    if (sourceHeader) {
      try {
        const sourceHost = new URL(sourceHeader).hostname.replace(/^www\./, '').toLowerCase();

        // stagingUrl comes off the Site row already SELECTed above, so this costs no
        // extra query. It used to be read from WEBFLOW_AUTHENTICATION KV on every
        // request — one KV read per pageview for a value D1 already had in hand.
        // Nothing writes stagingUrl to KV any more (setSiteStagingUrl, called from
        // trackCustomDomain, is the live writer), so KV only held stale legacy copies.
        let stagingHost = null;
        const siteStagingUrl = resolvedSite.stagingUrl ?? resolvedSite.stagingurl ?? null;
        // Webflow writes the literal string "Not Published" for unpublished sites.
        if (siteStagingUrl && String(siteStagingUrl).trim().toLowerCase() !== 'not published') {
          try {
            const raw = String(siteStagingUrl).trim();
            stagingHost = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase();
          } catch { }
        }

        let decision = authorizeRequestHost(resolvedSite, sourceHost, { stagingHost });

        if (!decision.allowed && decision.candidate) {
          const tracked = await trackCustomDomain(db, env, resolvedSite, decision.candidate);
          if (tracked.matched) {
            resolvedSite.customDomain = tracked.customDomain;
            if (tracked.stagingUrl) resolvedSite.stagingUrl = tracked.stagingUrl;
            decision = authorizeRequestHost(resolvedSite, sourceHost, { stagingHost });
          }
        }

        if (!decision.allowed) {
          console.warn(`[CDN] Domain mismatch BLOCKED: script for "${siteHost}" from "${sourceHost}" (stagingHost=${stagingHost}, reason=${decision.reason})`);
          return new Response('// Script not authorized for this domain', {
            status: 403,
            headers: { 'Content-Type': 'application/javascript' },
          });
        }

        authorizedHost = sourceHost;
      } catch (domainErr) {
        console.warn('[CDN] Could not parse Origin/Referer, blocking. header="' + sourceHeader + '" err=' + domainErr?.message);
        return new Response('// Script not authorized for this domain', {
          status: 403,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    } else {
    }
  }

  if (!resolvedSite.verified) {
    db.prepare(`UPDATE Site SET verified = 1, verified_at = datetime('now') WHERE id = ?1`)
      .bind(resolvedSite.id).run().catch(() => {});
  }

  let effectivePlanId = 'free';
  let orgIdForDebug = null;
  let subStatusForDebug = null;
  try {
    const orgId = resolvedSite.organizationId ?? resolvedSite.organizationid ?? null;
    orgIdForDebug = orgId ? String(orgId) : null;

    let subscription = await getSubscriptionBySiteId(db, resolvedSite.id);
    let resolvedPlanId = subscription ? (subscription.planId ?? subscription.planid ?? null) : null;
    if (resolvedPlanId) resolvedPlanId = String(resolvedPlanId).toLowerCase();
    if ((!resolvedPlanId || !['basic', 'essential', 'growth'].includes(resolvedPlanId)) && env && subscription) {
      const pid = subscription.stripePriceId ?? subscription.stripepriceid ?? null;
      const inferred = inferTierPlanIdFromStripePriceId(env, pid);
      if (inferred) resolvedPlanId = inferred;
    }

    if (!resolvedPlanId || !['basic', 'essential', 'growth'].includes(resolvedPlanId)) {
      if (orgId) {
        const orgResult = await getEffectivePlanForOrganization(db, orgId, env);
        resolvedPlanId = orgResult.planId || 'free';
        if (!subscription) subscription = orgResult.subscription;
      }
    }

    effectivePlanId = resolvedPlanId && ['basic', 'essential', 'growth'].includes(resolvedPlanId) ? resolvedPlanId : 'free';
    const status = subscription ? String(subscription.status || '').toLowerCase() : null;
    subStatusForDebug = status;
    const INACTIVE_STATUSES = ['canceled', 'cancelled', 'past_due', 'unpaid', 'incomplete_expired'];
    if (status && INACTIVE_STATUSES.includes(status)) {
      return new Response('// Subscription inactive — banner disabled', {
        status: 402,
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
  } catch (subErr) {
    console.warn('[CDN] Subscription check failed:', subErr?.message);
  }

  const customization = await getBannerCustomization(db, resolvedSite.id);

  let customCookieRules = [];
  try {
    const { results: ccrRows } = await db
      .prepare(
        `SELECT name, domain, scriptUrlPattern, category, duration, description
         FROM CustomCookieRule
         WHERE siteId = ?1 AND published = 1
         ORDER BY createdAt DESC`
      )
      .bind(resolvedSite.id)
      .all();
    customCookieRules = ccrRows || [];
  } catch (ccrErr) {
    console.warn('[CDN] Failed to load custom cookie rules:', ccrErr?.message);
  }

  const apiBase =
    env.API_BASE_URL ||
    'https://manager.consentbit.com';

  const GA_ID = resolvedSite.ga_measurement_id || '';

  const cf = request.cf || {};
  const country = cf.country || null;
  const isEU = cf.isEUCountry === '1';
  // Two-letter US state code ("CA", "VA", ...). Workers hands this to us directly —
  // the same source /api/consent already logs at consent.js:18. Do NOT try to read
  // it from headers: CF-IPState / CF-IPREGION are not headers Cloudflare emits
  // (the legacy app.consentbit.com resolver did that and silently saw every US
  // visitor as California).
  const regionCode = cf.regionCode || null;

  const regionMode = resolvedSite.region_mode || 'gdpr';
  let effectiveBannerType = resolvedSite.banner_type || 'gdpr';
  let bannerEnabled = true;

  const siteWantsIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab';

  if (!siteWantsIab) {
    if (regionMode === 'both') {
      if (isEU) {
        effectiveBannerType = 'gdpr';
      } else if (country === 'US') {
        effectiveBannerType = 'ccpa';
      } else {
        effectiveBannerType = 'gdpr';
      }
    } else if (regionMode === 'ccpa') {
      if (country === 'US') {
        effectiveBannerType = 'ccpa';
      } else {
        bannerEnabled = false;
      }
    } else if (effectiveBannerType === 'ccpa') {
      if (country !== 'US') {
        bannerEnabled = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // US state privacy law resolution
  // ---------------------------------------------------------------------------
  // effectiveBannerType deliberately STAYS 'ccpa' for every US state. The runtime
  // has 6 `"ccpa"===i` branches driving the opt-out UI, the Do-Not-Sell link, the
  // GPC auto-opt-out and the Consent Mode defaults; putting a statute name in
  // bannerType would turn all of them off for exactly the visitors we are trying
  // to serve. The statute travels in its own `usLaw` field instead.
  //
  // optOut — which consent categories the opt-out control actually withdraws:
  //   CCPA/CPRA (CA) sale + sharing (cross-context behavioural advertising)
  //   VCDPA (VA), CPA (CO), CTDPA (CT) sale + targeted advertising + profiling
  //   UCPA (UT) sale + targeted advertising ONLY — Utah grants no profiling
  //     opt-out, so analytics stays granted there. This is the one real
  //     category-level divergence between the five statutes.
  //
  // gpcMandated — whether a universal opt-out signal is legally binding:
  //   CA (CCPA regs), CO (since 2024-07-01), CT (since 2025-01-01) yes.
  //   VA and UT have no UOOM mandate. We still HONOUR the signal there — it is
  //   privacy-protective and dropping it would regress today's behaviour — but
  //   the flag is recorded so consent logs show whether it was required or
  //   volunteered.
  const US_STATE_LAWS = {
    CA: { law: 'CCPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: true },
    VA: { law: 'VCDPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: false },
    CO: { law: 'CPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: true },
    CT: { law: 'CTDPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: true },
    UT: { law: 'UCPA', optOut: ['marketing'], gpcMandated: false },
  };

  // Only meaningful when the visitor is actually getting the US opt-out banner.
  // A state we have no statute for falls back to the CCPA profile: it is the
  // strictest of the five, so an unmapped state is over- rather than
  // under-protected. Null for GDPR visitors.
  let usLaw = null;
  if (country === 'US' && String(effectiveBannerType).toLowerCase() === 'ccpa') {
    const matched = regionCode ? US_STATE_LAWS[String(regionCode).toUpperCase()] : null;
    const profile = matched || US_STATE_LAWS.CA;
    usLaw = {
      law: profile.law,
      state: regionCode || null,
      optOut: profile.optOut,
      gpcMandated: profile.gpcMandated,
      // false when we defaulted because regionCode was absent or unmapped —
      // lets the consent log distinguish "known California" from "assumed".
      resolved: !!matched,
    };
  }

  let customStyles = null;
  let bannerLayoutVisualForConfig = 'box';
  const LANG_NAME_TO_CODE = {
    English: 'en', Spanish: 'es', French: 'fr', German: 'de',
    Italian: 'it', Polish: 'pl', Portuguese: 'pt', Swedish: 'sv', Dutch: 'nl'
  };
  function normalizeLangCode(raw) {
    if (!raw) return 'en';
    const s = String(raw).trim();
    return LANG_NAME_TO_CODE[s] || (s.length <= 3 ? s.toLowerCase() : 'en');
  }

  const SECTION_LABELS = {
    en: { essential: 'Strictly Necessary', analytics: 'Analytics',   marketing: 'Marketing',      preferences: 'Preferences'  },
    es: { essential: 'Estrictamente Necesarias', analytics: 'Analíticas',  marketing: 'Marketing',      preferences: 'Preferencias' },
    fr: { essential: 'Strictement Nécessaires',  analytics: 'Analytiques', marketing: 'Marketing',      preferences: 'Préférences'  },
    de: { essential: 'Unbedingt Notwendig',      analytics: 'Analytik',    marketing: 'Marketing',      preferences: 'Einstellungen'},
    it: { essential: 'Strettamente Necessari',   analytics: 'Analitica',   marketing: 'Marketing',      preferences: 'Preferenze'   },
    pt: { essential: 'Estritamente Necessários', analytics: 'Analíticos',  marketing: 'Marketing',      preferences: 'Preferências' },
    sv: { essential: 'Strikt Nödvändiga',        analytics: 'Analytik',    marketing: 'Marknadsföring', preferences: 'Inställningar'},
    nl: { essential: 'Strikt Noodzakelijk',      analytics: 'Analytics',   marketing: 'Marketing',      preferences: 'Voorkeuren'   },
    pl: { essential: 'Ściśle Niezbędne',         analytics: 'Analityczne', marketing: 'Marketingowe',   preferences: 'Preferencje'  },
  };

  let enTrans = {};
  if (customization) {
    const rawPos = customization.position || 'bottom-left';
    const normPos = String(rawPos).trim().toLowerCase().replace(/_/g, '-');
    let position = 'bottom-left';
    if (normPos === 'bottom-right' || normPos === 'right') position = 'bottom-right';
    else if (normPos === 'bottom-center' || normPos === 'center') position = 'bottom-center';
    else if (normPos === 'bottom') position = 'bottom';
    else if (normPos === 'bottom-left' || normPos === 'left') position = 'bottom-left';
    const bgColor = customization.backgroundColor || '#ffffff';
    const textColor = customization.textColor || '#334155';
    const headingColor = customization.headingColor || '#0f172a';
    var _rawRadius = customization.bannerBorderRadius || '1.25rem';
    var _radiusPx = _rawRadius.endsWith('rem') ? Math.round(parseFloat(_rawRadius) * 16) : Math.round(parseFloat(_rawRadius) || 20);
    if (_radiusPx > 25) { _rawRadius = '1.5625rem'; }
    const bannerRadius = _rawRadius;
    var _rawBtnRadius = customization.buttonBorderRadius || '0.3125rem';
    var _btnRadiusPx = _rawBtnRadius.endsWith('rem') ? Math.round(parseFloat(_rawBtnRadius) * 16) : Math.round(parseFloat(_rawBtnRadius) || 5);
    if (_btnRadiusPx > 25) { _rawBtnRadius = '1.5625rem'; }
    const buttonRadius = _rawBtnRadius;
    var acceptBg = customization.acceptButtonBg || '#007aff';
    var acceptTx = customization.acceptButtonText || '#ffffff';
    var rejectBg = acceptBg;
    var rejectTx = acceptTx;
    var custBg = customization.customiseButtonBg || '#ffffff';
    var custTx = customization.customiseButtonText || '#0284c7';
    var saveBg = customization.saveButtonBg || custBg;
    var saveTx = customization.saveButtonText || '#0284c7';

    var configTrans = {};
    try {
      var trRaw = customization.translations;
      if (trRaw) {
        var trParsed = typeof trRaw === 'string' ? JSON.parse(trRaw) : trRaw;
        if (trParsed && trParsed.config) {
          configTrans = trParsed.config;
        }
        if (trParsed && trParsed.en) {
          enTrans = trParsed.en;
        }
      }
    } catch (eTy) {
      enTrans = {};
      configTrans = {};
    }
    const _langCode = enTrans.languageSelected || normalizeLangCode(customization.language);
    const _labels = SECTION_LABELS[_langCode] || SECTION_LABELS['en'];
    enTrans.essential = _labels.essential;
    enTrans.strictlyNecessary = '';
    if (!enTrans.analytics)           enTrans.analytics           = _labels.analytics;
    if (!enTrans.marketing)           enTrans.marketing           = _labels.marketing;
    if (!enTrans.preferences)         enTrans.preferences         = _labels.preferences;
    if (!enTrans.cookiePreferences)   enTrans.cookiePreferences   = 'Cookie Preferences';


    var layoutVisual = 'box';
    try {
      var _lvSrc = configTrans.bannerLayoutVisual != null ? configTrans.bannerLayoutVisual : enTrans.bannerLayoutVisual;
      var lvRaw = _lvSrc != null ? String(_lvSrc).toLowerCase() : 'box';
      if (lvRaw === 'banner' || lvRaw === 'fullwidth') layoutVisual = 'banner';
      else if (lvRaw === 'bottom-center' || lvRaw === 'centeralign' || lvRaw === 'popup') layoutVisual = 'bottom-center';
    } catch (eLayout) {}
    bannerLayoutVisualForConfig = layoutVisual;

    var fontWeightStr = String((configTrans.bannerFontWeight != null ? configTrans.bannerFontWeight : enTrans.bannerFontWeight) || '600');
    var textAlign = (configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : enTrans.bannerTextAlign) || 'left';
    if (textAlign !== 'center' && textAlign !== 'right') {
      textAlign = 'left';
    }
    var footerJustify = textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start';
    var bannerFooterJustify = textAlign === 'center' ? 'center' : 'flex-end';
    var closeButtonEnabled = ((configTrans.closeButtonEnabled != null ? configTrans.closeButtonEnabled : enTrans.closeButtonEnabled) === '1');
    var boxPadding = closeButtonEnabled ? '28px 20px 20px 20px' : '20px';
    var fontFamilyCss = 'inherit';
    try {
      var _fontMode = configTrans.bannerFontMode != null
        ? configTrans.bannerFontMode
        : (enTrans && enTrans.bannerFontMode);
      var _fontEnabled = configTrans.bannerFontEnabled != null
        ? configTrans.bannerFontEnabled
        : (enTrans && enTrans.bannerFontEnabled);
      var _useBannerFont = _fontMode != null
        ? String(_fontMode).toLowerCase() === 'default'
        : (_fontEnabled === '1' || _fontEnabled === 1 || _fontEnabled === true);
      if (_useBannerFont) {
        fontFamilyCss = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      }
    } catch (eFont) {}

    var positionStyles = '';
    var isBoldHeavy = fontWeightStr === '800' || fontWeightStr === '900';
    var descLen = String((enTrans && enTrans.description) || '').length;
    var maxBtnLen = Math.max(
      String((enTrans && enTrans.acceptAll) || '').length,
      String((enTrans && enTrans.rejectAll) || '').length,
      String((enTrans && enTrans.customise) || '').length
    );
    var perBtnPx = Math.max(maxBtnLen * 8 + 56, 90);
    var btnRowWidth = perBtnPx * 3 + 32 + 32;
    var isLongDesc = descLen > 200;
    var baseWidthPx = Math.max(520, btnRowWidth);
    if (isLongDesc && baseWidthPx < 560) baseWidthPx = Math.max(baseWidthPx, isBoldHeavy ? 680 : 560);
    var baseWidth = baseWidthPx + 'px';
    var maxWidth = baseWidthPx + 'px';
    var initialSize =
      'width:' + baseWidth + '!important;min-width:360px;max-width:min(' + maxWidth + ',96vw)!important;max-height:min(80vh,600px);overflow:hidden;';
    var initialRadius = 'border-radius:' + bannerRadius + '!important;';
    if (layoutVisual === 'banner') {
      initialSize = 'width:100%!important;max-width:none!important;';
      positionStyles = 'bottom:0!important;left:0!important;right:auto!important;transform:none;';
      initialRadius = 'border-radius:' + bannerRadius + '!important;';
    } else if (layoutVisual === 'bottom-center') {
      initialSize =
        'width:' + baseWidth + '!important;min-width:360px;max-width:min(' + maxWidth + ',96vw)!important;max-height:min(80vh,600px);overflow:hidden;';
      positionStyles = 'bottom:32px!important;left:50%!important;transform:translateX(-50%);';
      initialRadius = 'border-radius:' + bannerRadius + '!important;';
    } else {
      if (position === 'bottom-right') {
        positionStyles = 'bottom:32px!important;right:21px!important;left:auto!important;transform:none;';
      } else if (position === 'bottom-center' || position === 'bottom') {
        positionStyles = 'bottom:32px!important;left:50%!important;transform:translateX(-50%);';
      } else {
        positionStyles = 'bottom:32px!important;left:21px!important;right:auto!important;transform:none;';
      }
    }

    if (effectiveBannerType === 'ccpa' && layoutVisual !== 'banner') {
      var ccpaWidthPx = Math.max(baseWidthPx, 600);
      initialSize = 'width:' + ccpaWidthPx + 'px!important;min-width:360px;max-width:min(' + ccpaWidthPx + 'px,96vw)!important;max-height:min(80vh,660px);overflow:hidden;';
    }

    customStyles =
      ".cb-banner{border:none !important;}" +
      // font-family is NOT inherited into form controls (button/input/select/
      // textarea): the UA stylesheet declares its own font on them, and a UA
      // declaration outranks inheritance. Force every descendant to inherit so
      // the whole banner follows the container font resolved above. The close
      // (x) buttons set their font inline, so they keep the system stack.
      ".cb-banner *{font-family:inherit;}" +
      "#cb-initial-banner.cb-banner{" +
        initialSize +
        "background-color:" + bgColor + "!important;" +
        "color:" + textColor + ";" +
        "position:fixed!important;" +
        positionStyles +
        "padding:" + (layoutVisual === 'banner' ? "28px 48px" : boxPadding) + "!important;" +
        "border:1px solid #e2e8f0;" +
        initialRadius +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "align-items:stretch;" +
        "font-family:" + fontFamilyCss + ";" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body{" +
        "flex:0 1 auto;" +
        "min-width:0;" +
        "min-height:0;" +
        "overflow-y:auto;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-close-initial-btn," +
      "#cb-initial-banner.cb-banner [consentbit='close']{" +
        "position:absolute!important;" +
        "top:8px!important;" +
        "right:20px!important;" +
        "width:10px!important;" +
        "height:10px!important;" +
        "cursor:pointer!important;" +
        "background:transparent!important;" +
        "border:none!important;" +
        "padding:0!important;" +
        "z-index:10!important;" +
        "display:" + (closeButtonEnabled ? "block" : "none") + "!important;" +
      "}" +
      "#cb-preferences-banner.cb-banner{" +
        "width:600px;" +
        "max-width:94vw;" +
        "max-height:min(88vh,640px);" +
        "min-height:0;" +
        "overflow:hidden;" +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        "top:50%;" +
        "left:50%;" +
        "transform:translate(-50%,-50%);" +
        "padding:28px;" +
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
        "font-weight:600;"  +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      "#cb-initial-banner.cb-banner h3," +
      "#cb-preferences-banner.cb-banner h3{" +
        "font-weight:600!important;"  +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body h3," +
      "#cb-preferences-banner.cb-banner .cb-banner-body h3{" +
        "padding-right:0!important;" +
      "}" +
      ".cb-gdpr-cat-label{" +
        "color:" + headingColor + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-gdpr-cat-label ~ div > span{" +
        "color:" + textColor + "!important;" +
      "}" +
      ".cb-banner p{" +
        "margin:0 0 12px;" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body > p," +
      "#cb-preferences-banner.cb-banner .cb-banner-body > p," +
      "#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "opacity:0.92;" +
        "width:100%;" +
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
      "}" +
      ".cb-banner button#cb-reject-all-btn{" +
        "background-color:" + rejectBg + ";" +
        "color:" + rejectTx + ";" +
      "}" +
      ".cb-banner button#cb-preferences-btn," +
      ".cb-banner button#cb-ccpa-donotsell-link{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
      "}" +
      ".cb-banner button#cb-prefs-reject-btn{" +
        "background-color:" + rejectBg + ";" +
        "color:" + rejectTx + ";" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer{" +
        "display:flex!important;" +
        "flex-direction:row!important;" +
        "gap:10px!important;" +
        "width:100%!important;" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button{" +
        "flex:1 1 0!important;" +
        "width:0!important;" +
        "min-width:0!important;" +
        "white-space:nowrap!important;" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{" +
        "background-color:" + acceptBg + ";" +
        "color:" + acceptTx + ";" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + saveBg + ";" +
        "color:" + saveTx + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + saveBg + ";" +
        "color:" + saveTx + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-banner-footer button{" +
        "padding:10px 36px!important;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-footer{" +
        "display:flex;" +
        "flex-wrap:nowrap;" +
        "gap:8px;" +
        "justify-content:" + footerJustify + "!important;" +
        "flex-shrink:0;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
        "flex:1 1 0;" +
        "min-width:" + perBtnPx + "px;" +
        "white-space:nowrap;" +
        "overflow:visible;" +
        "text-overflow:clip;" +
      "}" +
      (layoutVisual === 'banner'
        ?
          "#cb-initial-banner.cb-banner{" +
            "flex-direction:column!important;align-items:stretch!important;" +
          "}" +
          "#cb-initial-banner.cb-banner .cb-banner-body{" +
            "flex:1 1 auto!important;min-width:0!important;overflow-y:visible!important;padding:0!important;margin:0!important;" +
          "}" +
          "#cb-initial-banner.cb-banner .cb-banner-footer{" +
            "position:relative!important;flex:0 0 auto!important;flex-wrap:nowrap!important;justify-content:" + bannerFooterJustify + "!important;padding:0!important;margin:0!important;" +
          "}" +
          "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
            "flex:0 0 auto!important;width:auto!important;min-width:" + perBtnPx + "px!important;max-width:none!important;white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important;" +
          "}" +
          "@media(max-width:660px){" +
            "#cb-initial-banner.cb-banner{left:0!important;right:0!important;}" +
          "}"
        : "") +
      "#cb-initial-banner.cb-banner #cb-preferences-btn{" +
        "background:" + custBg + "!important;" +
        "color:" + custTx + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-reject-all-btn{" +
        "background:" + rejectBg + "!important;" +
        "color:" + rejectTx + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
        "background:" + acceptBg + "!important;" +
        "color:" + acceptTx + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      ".cb-gdpr-accordion{" +
        "background-color:" + bgColor + ";" +
      "}" +
      ".cb-banner-footer{" +
        "display:flex;" +
        "justify-content:flex-end;" +
        "gap:10px;" +
        "flex-wrap:wrap;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-banner-footer{" +
        "flex:0 0 auto;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-footer{" +
        "flex:0 0 auto;" +
        "box-sizing:border-box;" +
        "height:44px;" +
        "max-height:50px;" +
        "width:calc(100% + 56px);" +
        "margin:20px -28px -28px;" +
        "padding:0 20px;" +
        "display:flex;" +
        "align-items:center;" +
        "justify-content:flex-end;" +
        "gap:8px;" +
        "background:#F7F8FA!important;" +
        "background-color:#F7F8FA!important;" +
        "border-top:1px solid #EFF1F4!important;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-footer a{" +
        "display:inline-flex!important;" +
        "align-items:center;" +
        "gap:7px;" +
        "text-decoration:none!important;" +
        "border-radius:6px;" +
        "padding:4px 6px;" +
        "margin-right:-6px;" +
        "background:transparent!important;" +
        "color:#A2ABBA!important;" +
        "font-weight:500!important;" +
        "transition:opacity .15s ease;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-footer a:hover{opacity:.7;}" +
      "#cb-preferences-banner.cb-banner .cb-brand-credit{" +
        "font-size:11px!important;" +
        "font-weight:500!important;" +
        "letter-spacing:.02em;" +
        "line-height:1;" +
        "white-space:nowrap;" +
        "color:#A2ABBA!important;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-mark{" +
        "display:flex;" +
        "align-items:center;" +
        "opacity:.85;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-mark svg{" +
        "display:block;" +
        "height:9.75px;" +
        "width:auto;" +
      "}" +
      "@media(max-width:660px){" +
        "#cb-initial-banner.cb-banner{" +
          "width:100vw!important;" +
          "max-width:100vw!important;" +
          "min-width:0!important;" +
          "left:0!important;" +
          "right:0!important;" +
          "bottom:0!important;" +
          "transform:none!important;" +
          "border-radius:0!important;" +
          "border-left:none!important;" +
          "border-right:none!important;" +
          "border-bottom:none!important;" +
        "}" +
        "#cb-initial-banner.cb-banner .cb-banner-footer{" +
          "flex-direction:column!important;" +
          "align-items:stretch!important;" +
        "}" +
        "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
          "width:100%!important;" +
          "min-width:0!important;" +
          "box-sizing:border-box!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner{" +
          "width:calc(100vw - 32px)!important;" +
          "max-width:calc(100vw - 32px)!important;" +
          "padding:20px!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner .cb-banner-footer{" +
          "flex-direction:column!important;" +
          "align-items:stretch!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner .cb-banner-footer button{" +
          "width:100%!important;" +
          "min-width:0!important;" +
          "box-sizing:border-box!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner .cb-brand-footer{" +
          "width:calc(100% + 40px)!important;" +
          "margin:16px -20px -20px!important;" +
          "padding:0 16px!important;" +
        "}" +
      "}";
  }

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

  if (translationsForScript && translationsForScript.en) {
    const _enT = translationsForScript.en;
    const _lc = _enT.languageSelected || 'en';
    const _lb = SECTION_LABELS[_lc] || SECTION_LABELS['en'];
    _enT.essential = (_lb && _lb.essential) ? _lb.essential : 'Strictly Necessary';
    _enT.strictlyNecessary = '';
  }

  // The Webflow Designer App mis-maps the CCPA opt-out panel body into ccpaDescription
  // (buildCustomizationPayload.js: `ccpaDescription: ccpaContent.optOutBody`), so the
  // initial CCPA banner renders the opt-out paragraph, truncated mid-word at 320 chars.
  // That app exposes no editor field for the CCPA notice, so an identical pair is the
  // mis-map's signature. Equality ALONE is not enough though: 11 prod rows (framer /
  // webapp) have the pair equal to the *notice* text instead, where ccpaDescription is
  // already correct and it is the opt-out intro that was overwritten - blanking those
  // would break working banners. The two populations separate cleanly by length: every
  // shipped notice default is ~160 chars, every opt-out intro 481-595, with nothing in
  // between. Gate on the runtime's own 320 cap, above which a notice would be truncated
  // anyway. Blanking lets the existing W("ccpaDescription") || W("description") chain
  // fall through to the site's own banner message - what the dashboard already shows.
  if (translationsForScript && translationsForScript.en) {
    const _ccpaT = translationsForScript.en;
    if (
      _ccpaT.ccpaDescription &&
      _ccpaT.ccpaDescription === _ccpaT.ccpaOptOutPreferenceIntro &&
      String(_ccpaT.ccpaDescription).length > 320
    ) {
      _ccpaT.ccpaDescription = '';
    }
  }

  function resolveWorkerFloatingLogoUrl() {
    try {
      return new URL(request.url).origin + '/embed/floating-logo.svg';
    } catch (e) {
      return '';
    }
  }

  function resolveFloatingLogoUrl() {
    var webapp = String(env.WEBAPP_PUBLIC_URL || '')
      .trim()
      .replace(/\/$/, '');
    if (webapp) {
      return webapp + '/asset/logo.webp';
    }
    return resolveWorkerFloatingLogoUrl();
  }

  function normalizePreferencePositionForEmbed(raw) {
    if (raw === 'left') return 'left';
    return 'center';
  }

  const siteConfigPayload = {
    id: resolvedSite.id,
    bannerType: effectiveBannerType,
    // Which US statute applies to THIS request (null outside the US opt-out path).
    // Additive: bannerType is untouched, so every existing runtime branch behaves
    // exactly as before for sites/visitors that ignore this field.
    usLaw,
    bannerEnabled,
    apiBase,
    gaId: GA_ID,
    clarityCmpId: resolvedSite.clarityCmpId || 165,
    clarityConsentMode: resolvedSite.clarityConsentMode !== 0 && resolvedSite.clarityConsentMode !== false,
    gtmConsentMode: resolvedSite.gtmConsentMode !== 0 && resolvedSite.gtmConsentMode !== false,
    platform: resolvedSite.platform || null,
    styles: customStyles || null,
    customization: customization
      ? {
          position: (function () {
            var r = customization.position || 'bottom-left';
            var n = String(r).trim().toLowerCase().replace(/_/g, '-');
            if (n === 'bottom-right' || n === 'right') return 'bottom-right';
            if (n === 'bottom-center' || n === 'center') return 'bottom-center';
            if (n === 'bottom') return 'bottom';
            return 'bottom-left';
          })(),
          bannerLayoutVisual: bannerLayoutVisualForConfig,
          privacyPolicyUrl: customization.privacyPolicyUrl,
          footerLink: customization.footerLink === 1,
          animationEnabled:
            customization.animationEnabled == null ||
            customization.animationEnabled === 1 ||
            Number(customization.animationEnabled) === 1,
          preferencePosition: normalizePreferencePositionForEmbed(
            customization.preferencePosition
          ),
          centerAnimationDirection: customization.centerAnimationDirection || 'fade',
          language: normalizeLangCode(customization.language),
          autoDetectLanguage: customization.autoDetectLanguage === 1,
          cookieExpirationDays:
            customization.cookieExpirationDays != null ? customization.cookieExpirationDays : 30,
          backgroundColor: customization.backgroundColor || '#ffffff',
          textColor: customization.textColor || '#334155',
          headingColor: customization.headingColor || '#0f172a',
          acceptButtonBg: customization.acceptButtonBg || '#007aff',
          acceptButtonText: customization.acceptButtonText || '#ffffff',
          rejectButtonBg: customization.rejectButtonBg || customization.acceptButtonBg || '#007aff',
          rejectButtonText: customization.rejectButtonText || customization.acceptButtonText || '#ffffff',
          customiseButtonBg: customization.customiseButtonBg || '#ffffff',
          customiseButtonText: customization.customiseButtonText || '#0284c7',
          saveButtonBg: customization.saveButtonBg || '#ffffff',
          saveButtonText: customization.saveButtonText || '#0284c7',
          bannerEntranceAnimation: (() => {
            const raw = (configTrans.bannerEntranceAnimation != null && configTrans.bannerEntranceAnimation !== '')
              ? configTrans.bannerEntranceAnimation
              : (customization.centerAnimationDirection != null && customization.centerAnimationDirection !== '')
                ? customization.centerAnimationDirection
                : (enTrans && enTrans.bannerEntranceAnimation) || 'fade-in';
            const v = String(raw || 'fade-in');
            return v === 'zoom' ? 'zoom-in' : v === 'fade' ? 'fade-in' : v;
          })(),
          bannerFontWeight: '',
          bannerBorderRadius: customization.bannerBorderRadius || '1.25rem',
          buttonBorderRadius: customization.buttonBorderRadius || '0.3125rem',
          textAlign: (configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : enTrans.bannerTextAlign) || 'left',
          showBannerLogo: customization.showBannerLogo != null ? customization.showBannerLogo !== 0 && customization.showBannerLogo !== false : true,
          bannerLogoPosition: customization.bannerLogoPosition || 'left',
          font: String((configTrans.bannerFontFamily != null ? configTrans.bannerFontFamily : (enTrans && enTrans.bannerFontFamily)) || customization.font || 'Inter'),
          fontWeight: String((configTrans.bannerFontWeight != null ? configTrans.bannerFontWeight : (enTrans && enTrans.bannerFontWeight)) || customization.fontWeight || 'Regular'),
          fontSize: Number((configTrans.bannerFontSize != null ? configTrans.bannerFontSize : (enTrans && enTrans.bannerFontSize)) || customization.fontSize || 14),
          textAlignment: String((configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : (enTrans && enTrans.bannerTextAlign)) || customization.textAlignment || 'left'),
          bannerBg2: String((configTrans.bannerBg2 != null ? configTrans.bannerBg2 : (enTrans && enTrans.bannerBg2)) || customization.bannerBg2 || '#798EFF'),
          stopScroll: customization.stopScroll === 1 || customization.stopScroll === true,
          // "Powered by ConsentBit" footer removal — Growth-only. Re-checked against the
          // live plan here (not just at save time) so a downgrade brings the footer back
          // without needing the customer to re-save the banner.
          hideBranding:
            effectivePlanId === 'growth' &&
            (customization.hideBranding === 1 || customization.hideBranding === true),
        }
      : null,
    floatingLogoUrl: resolveFloatingLogoUrl(),
    floatingLogoFallbackUrl: resolveWorkerFloatingLogoUrl(),
    scriptBlockProviders: SCRIPT_BLOCK_PROVIDERS,
    customCookieRules: customCookieRules,
    pendingScan: resolvedSite.pendingScan === 1,
    registeredDomain: authorizedHost || resolvedSite.domain
      ? String(resolvedSite.domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()
      : null,
  };

  const inlineConfig = `
    window.__CONSENT_SITE__ = ${jsonForInlineScript(siteConfigPayload)};
  `;

  const translationsVar =
    'var TRANSLATIONS = ' + jsonForInlineScript(translationsForScript) + ';';

  const loader = `
${inlineConfig}
!function(){if(!window.__cbBannerInit){window.__cbBannerInit=!0;var e=window.__CONSENT_SITE__||{};var t=!0;!function(){var n=e.registeredDomain;if(n)try{var r=window.location.hostname.replace(/^www./,"").toLowerCase();if(r!==n&&"webflow"!==e.platform&&!r.endsWith(".webflow.io")){window.__CONSENT_SITE__=null;t=!1}}catch(e){}}();if(t){var n=e.floatingLogoUrl||"";var r=e.floatingLogoFallbackUrl||"";var a=e.id||null;var i=e.bannerType||"gdpr";var cbLaw=e.usLaw||null;var o=!1!==e.bannerEnabled;var c=e.apiBase;var s=e.gaId||null;var l=!1!==e.clarityConsentMode;var d=e.clarityCmpId||165;var p=e.customization||null;var cbHideBrand=!(!p||!p.hideBranding);var b=!0===e.pendingScan;var f=p&&p.bannerLayoutVisual||"box";var m=p?p.privacyPolicyUrl:null;var g=!!p&&p.stopScroll;var u=!p||!1!==p.animationEnabled;var y=p&&p.bannerEntranceAnimation||"fade-in";var v=p&&p.preferencePosition||"center";var h=p&&p.centerAnimationDirection||"fade";var x=p&&p.language||"en";var C=!!p&&!0===p.autoDetectLanguage;${translationsVar}var w=["customise","rejectAll","acceptAll","save","back","doNotSell","saveMyPreferences","confirmChoice","cancel","optOutPreference"];var k=30,_=320,E=20,S=30,O=200;var B=56;var L="consentbit_"+a;var A=void 0!==p&&p&&null!=p.cookieExpirationDays?Math.max(1,Math.min(365,Number(p.cookieExpirationDays)||30)):30;var I=ie();try{if(!(!0!==navigator.globalPrivacyControl||"ccpa"!==i||I&&I.accepted)){I={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:!0},gpc:!0};try{localStorage.setItem(L,JSON.stringify(I))}catch(e){}le(I,{status:"rejected",consentMethod:"gpc"})}}catch(e){}var H="consentbit_prefs_"+(a||"");var T="cb_pv_over_limit_"+(a||"");var P=[];var z=!1;var N=null;var j=e.scriptBlockProviders||[];var V=e.customCookieRules||[];var M=[{domain:"facebook.com",category:"marketing"},{domain:"facebook.net",category:"marketing"},{domain:"adroll.com",category:"marketing"},{domain:"doubleclick.net",category:"marketing"},{domain:"googleadservices.com",category:"marketing"},{domain:"bing.com",category:"marketing"},{domain:"bat.bing.com",category:"marketing"},{domain:"twitter.com",category:"marketing"},{domain:"analytics.twitter.com",category:"marketing"},{domain:"t.co",category:"marketing"},{domain:"linkedin.com",category:"marketing"},{domain:"ads.linkedin.com",category:"marketing"},{domain:"pinterest.com",category:"marketing"},{domain:"ct.pinterest.com",category:"marketing"},{domain:"tiktok.com",category:"marketing"},{domain:"analytics.tiktok.com",category:"marketing"},{domain:"hotjar.com",category:"analytics"},{domain:"clarity.ms",category:"analytics"},{domain:"scorecardresearch.com",category:"analytics"},{domain:"outbrain.com",category:"marketing"},{domain:"taboola.com",category:"marketing"},{domain:"criteo.com",category:"marketing"},{domain:"criteo.net",category:"marketing"},{domain:"quantserve.com",category:"analytics"},{domain:"zemanta.com",category:"marketing"}];var D=".cb-banner,.cb-banner *{box-sizing:border-box;}.cb-banner *{font-family:inherit;}#cb-initial-banner.cb-banner{width:440px;min-width:280px;max-width:min(440px,92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;bottom:32px;left:32px;right:auto;padding:16px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:inline-flex;flex-direction:column;align-items:stretch;font-family:inherit;font-size:14px!important;line-height:1.5!important;}#cb-initial-banner.cb-banner .cb-banner-body{flex:0 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner{width:540px;max-width:92vw;max-height:min(85vh,580px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:flex;flex-direction:column;font-family:inherit;font-size:14px!important;line-height:1.5!important;}#cb-preferences-banner.cb-banner .cb-banner-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner.prefs-left{left:32px;right:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-right{right:32px;left:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-center{left:50%;top:50%;transform:translate(-50%,-50%);}.cb-banner-body{overflow-y:auto;overflow-x:hidden;margin-bottom:12px;}.cb-banner h3{margin:0 0 8px;font-size:16px!important;line-height:1.4!important;font-weight:600;color:#0f172a;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}#cb-initial-banner.cb-banner h3{font-size:16px!important;font-weight:600;color:rgba(0,0,0,0.8);padding-right:36px;}#cb-initial-banner.cb-banner .cb-banner-body > p{color:rgba(0,0,0,0.8);}.cb-gdpr-accordion{margin-top:4px;margin-bottom:4px;}.cb-gdpr-cat-label{color:#0f172a;}.cb-gdpr-cat-desc{color:#64748b;}.cb-banner p{margin:0 0 12px;font-size:14px!important;line-height:1.5!important;color:#334155;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}.cb-banner-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;align-items:center;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex:0 0 auto;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}"+(p&&"banner"===p.bannerLayoutVisual?"#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}":"")+".cb-banner button{padding:12px 32px;border-radius:0.375rem;cursor:pointer;font-size:14px;font-weight:600;border:1px solid #e2e8f0;transition:opacity 0.2s;white-space:normal;word-break:break-word;min-width:0;text-align:center;}@media (max-width:660px){#cb-initial-banner.cb-banner{width:100vw!important;max-width:100vw!important;left:0!important;right:0!important;bottom:0!important;transform:none!important;border-radius:0!important;border-left:none!important;border-right:none!important;border-bottom:none!important;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-initial-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}#cb-preferences-banner.cb-banner{width:calc(100vw - 32px)!important;max-width:calc(100vw - 32px)!important;padding:20px!important;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-preferences-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}}@media (max-width:350px){#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{font-size:12px!important;}#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-size:13px!important;}#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,.cb-gdpr-cat-desc{font-size:12px!important;}#cb-initial-banner.cb-banner .cb-banner-footer button,#cb-preferences-banner.cb-banner .cb-banner-footer button{font-size:12px!important;padding:10px 16px!important;}}.cb-banner button:hover:not(.cb-pref-toggle-track){opacity:0.8;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{display:block !important;width:40px !important;min-width:40px !important;height:22px !important;padding:0 !important;margin:0 !important;border:none !important;border-radius:11px !important;background:#d1d5db !important;box-shadow:none !important;flex-shrink:0 !important;position:relative !important;overflow:visible !important;box-sizing:border-box !important;cursor:pointer !important;appearance:none !important;-webkit-appearance:none !important;font-size:0 !important;line-height:0 !important;opacity:1 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{background:#22c55e !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{content:'' !important;position:absolute !important;top:2px !important;left:2px !important;width:18px !important;height:18px !important;border-radius:50% !important;background:#ffffff !important;box-shadow:0 1px 3px rgba(0,0,0,.2) !important;pointer-events:none !important;transition:left .15s ease !important;z-index:2 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{left:20px !important;}.cb-banner button#cb-accept-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-reject-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-preferences-btn,.cb-banner button#cb-ccpa-donotsell-link{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner button#cb-prefs-reject-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner label{display:block;margin-bottom:6px;font-size:11px;}.cb-banner input[type='checkbox']{margin-right:6px;}.cb-banner a{color:#007aff !important;text-decoration:underline !important;font-size:inherit !important;display:inline !important;font-weight:inherit !important;white-space:normal;}@keyframes slideInFromLeft{from{transform:translateX(-100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromRight{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromTop{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes slideInFromBottom{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}@keyframes prefsSlideInFromLeft{from{transform:translate(-120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideInFromRight{from{transform:translate(120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideCenterFromBottom{from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes prefsSlideCenterFromTop{from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes zoomIn{from{transform:scale(0.85);opacity:0;}to{transform:scale(1);opacity:1;}}@keyframes cbInitialCenterSlideFromBottom{from{transform:translate(-50%,100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterSlideFromTop{from{transform:translate(-50%,-100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterZoomIn{from{transform:translateX(-50%) scale(0.85);opacity:0;}to{transform:translateX(-50%) scale(1);opacity:1;}}.cb-banner-animate-initial-center-bottom{animation:cbInitialCenterSlideFromBottom 0.35s ease-out;}.cb-banner-animate-initial-center-top{animation:cbInitialCenterSlideFromTop 0.35s ease-out;}.cb-banner-animate-initial-center-zoom{animation:cbInitialCenterZoomIn 0.3s ease-out;}@keyframes prefsZoomIn{from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}to{transform:translate(-50%,-50%) scale(1);opacity:1;}}.cb-banner-animate-left{animation:slideInFromLeft 0.4s ease-out;}.cb-banner-animate-right{animation:slideInFromRight 0.4s ease-out;}.cb-banner-animate-top{animation:slideInFromTop 0.4s ease-out;}.cb-banner-animate-bottom{animation:slideInFromBottom 0.4s ease-out;}.cb-banner-animate-fade{animation:fadeIn 0.3s ease-out;}.cb-banner-animate-prefs-left{animation:prefsSlideInFromLeft 0.4s ease-out;}.cb-banner-animate-prefs-right{animation:prefsSlideInFromRight 0.4s ease-out;}.cb-banner-animate-center-top{animation:prefsSlideCenterFromTop 0.35s ease-out;}.cb-banner-animate-center-bottom{animation:prefsSlideCenterFromBottom 0.35s ease-out;}.cb-banner-animate-zoom-in{animation:zoomIn 0.3s ease-out;}.cb-banner-animate-prefs-zoom-in{animation:prefsZoomIn 0.3s ease-out;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}#cb-initial-banner.cb-banner .cb-banner-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex-shrink:0;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}#cb-initial-banner.cb-banner #cb-preferences-btn{background:#ffffff!important;color:#334155!important;border:1px solid #334155!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-initial-banner.cb-banner #cb-reject-all-btn,#cb-initial-banner.cb-banner #cb-accept-all-btn{background:#007aff!important;color:#ffffff!important;border-color:#007aff!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-floating-trigger{position:fixed;z-index:2147483646!important;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;}#cb-floating-trigger img,#cb-floating-trigger svg{display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;}#cb-preferences-banner.cb-banner .cb-brand-footer{flex:0 0 auto;box-sizing:border-box;height:44px;max-height:50px;width:calc(100% + 40px);margin:16px -20px -20px;padding:0 16px;display:flex;align-items:center;justify-content:flex-end;gap:8px;background:#F7F8FA !important;background-color:#F7F8FA !important;border-top:1px solid #EFF1F4 !important;}#cb-preferences-banner.cb-banner .cb-brand-footer a{display:inline-flex !important;align-items:center;gap:7px;text-decoration:none !important;background:transparent !important;color:#A2ABBA !important;font-weight:500 !important;border-radius:6px;padding:4px 6px;margin-right:-6px;transition:opacity .15s ease;}#cb-preferences-banner.cb-banner .cb-brand-footer a:hover{opacity:.7;}#cb-preferences-banner.cb-banner .cb-brand-credit{font-size:11px !important;font-weight:500 !important;letter-spacing:.02em;line-height:1;white-space:nowrap;color:#A2ABBA !important;}#cb-preferences-banner.cb-banner .cb-brand-mark{display:flex;align-items:center;opacity:.85;}#cb-preferences-banner.cb-banner .cb-brand-mark svg{display:block;height:9.75px;width:auto;}";e.styles&&(D=D+"\\n"+e.styles);var F="cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in";Ue();"complete"===document.readyState||"interactive"===document.readyState?ut():window.addEventListener("DOMContentLoaded",ut)}var Z={analytics:["_ga","_ga_*","_gid","_gat","_gat_*","_gac_*","_hjid","_hjSessionUser_*","_hjSession_*","_hjAbsoluteSessionInProgress","_clck","_clsk"],marketing:["_fbp","_fbc","_gcl_au","_gcl_ls","_gcl_aw","_ttp","tt_webid_v2","_pin_unauth","_pinterest_ct_ua","li_sugr","bcookie","bscookie","lidc","_uetsid","_uetvid","IDE","test_cookie","fr"],preferences:[]}}function R(){if(C){var e=(navigator.language||navigator.userLanguage||"en").split("-")[0].toLowerCase();return TRANSLATIONS[e]?e:"en"}return x}function W(e){var t=R();var n=TRANSLATIONS[t]||TRANSLATIONS.en;var r=null!=n[e]?n[e]:null!=TRANSLATIONS.en[e]?TRANSLATIONS.en[e]:"";return""===r&&"title"===e?"We value your privacy":""===r&&"description"===e?"We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.":r}function U(e){var t=R();var n=(TRANSLATIONS[t]||TRANSLATIONS.en)[e];n&&n.length>80&&(n=TRANSLATIONS.en[e]||e);return n||TRANSLATIONS.en[e]||e}function q(e,t){var n=null==e?"":String(e);return n.length>t?n.slice(0,t):n}function J(e,t){return q(W(e),t)}function Y(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.cookiePolicyLinkEnabled?t.cookiePolicyLinkEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).cookiePolicyLinkEnabled;return!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function X(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.closeButtonEnabled?t.closeButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).closeButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function $(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.rejectButtonEnabled?t.rejectButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).rejectButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function G(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.customizeButtonEnabled?t.customizeButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).customizeButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function K(e){var t=String(e||"bottom-left").trim().toLowerCase().replace(/_/g,"-");return"bottom-right"===t||"right"===t?"bottom-right":"bottom"===t||"bottom-center"===t?"bottom":"bottom-left"}function Q(e){if(e){e.style.marginLeft="";e.style.marginRight="";e.style.paddingLeft="";e.style.paddingRight="";if(ot()){var t=f||"box";var n=K(p&&p.position);var r=st();var a="56px";"banner"!==t?"left"===r?"bottom-center"!==t&&"popup"!==t&&"bottom"!==n||(e.style.marginLeft=a):"bottom-center"!==t&&"popup"!==t&&"bottom"!==n||(e.style.marginRight=a):"left"===r?e.style.paddingLeft=a:e.style.paddingRight=a}}}function ee(e){if(!e)return!1;var t=f||"box";var n=K(p&&p.position);e.style.left="";e.style.right="";e.style.top="";e.style.bottom="";e.style.transform="";e.style.width="";e.style.maxWidth="";e.style.marginLeft="";e.style.marginRight="";e.style.paddingLeft="";e.style.paddingRight="";if("banner"===t){e.style.left="0";e.style.right="0";e.style.bottom="0";e.style.transform="none";e.style.width="100%";e.style.maxWidth="none";e.setAttribute("data-cb-initial-centered","0");Q(e);return!1}if(window.innerWidth<=660){e.style.setProperty("left","0","important");e.style.setProperty("right","0","important");e.style.setProperty("bottom","0","important");e.style.setProperty("transform","none","important");e.style.setProperty("width","100vw","important");e.style.setProperty("max-width","100vw","important");e.style.setProperty("min-width","0","important");e.style.setProperty("border-radius","0","important");e.style.setProperty("border-left","none","important");e.style.setProperty("border-right","none","important");e.style.setProperty("border-bottom","none","important");e.setAttribute("data-cb-initial-centered","0");return!1}if("bottom-center"===t||"popup"===t||"bottom"===n){e.style.bottom="32px";e.style.left="50%";e.style.transform="translateX(-50%)";e.setAttribute("data-cb-initial-centered","1");Q(e);return!0}e.style.bottom="32px";"bottom-right"===n?e.style.right="32px":e.style.left="32px";e.style.transform="none";e.setAttribute("data-cb-initial-centered","0");Q(e);return!1}function te(e){var t=e;var n=t.indexOf("#");n>=0&&(t=t.slice(0,n));(n=t.indexOf("?"))>=0&&(t=t.slice(0,n));(n=t.indexOf("/"))>=0&&(t=t.slice(0,n));return t.trim()}function ne(e){var t=e.lastIndexOf(".");if(t<0)return!1;var n=e.slice(t).toLowerCase();return".js"===n||".mjs"===n||".css"===n||".png"===n||".jpg"===n||".jpeg"===n||".gif"===n||".svg"===n||".webp"===n||".pdf"===n||".json"===n||".xml"===n||".ico"===n||".woff"===n||".woff2"===n}function re(e){if(!e||"string"!=typeof e)return"";var t=e.trim();if(!t)return"";var n=t.toLowerCase();if(0===n.indexOf("mailto:")||0===n.indexOf("tel:"))return t;if(0===n.indexOf("http://")||0===n.indexOf("https://"))return t;if(0===t.indexOf("//"))return"https:"+t;if("/"===t.charAt(0)||0===t.indexOf("./")||0===t.indexOf("../")){try{if("undefined"!=typeof window&&window.location)return new URL(t,window.location.href).href}catch(e){}return t}var r=te(t);if(r.indexOf(".")>0&&!ne(r)){for(;t.length>0&&"/"===t.charAt(0);)t=t.slice(1);return"https://"+t}try{if("undefined"!=typeof window&&window.location)return new URL(t,window.location.href).href}catch(e){}return t}function ae(e,t){var n=re(t);if(n){e.href=n;e.target="_blank";e.rel="noopener noreferrer";e.addEventListener("click",function(e){e.stopPropagation&&e.stopPropagation();e.preventDefault&&e.preventDefault();try{window.open(n,"_blank","noopener,noreferrer")}catch(e){}},!0)}}function ie(){try{var e=localStorage.getItem(L);var t=e?JSON.parse(e):{accepted:!1,timestamp:null};if(!t||!t.accepted)return t||{accepted:!1,timestamp:null};var n=Date.now();var r=24*A*60*60*1e3;var a=t.expiresAt?new Date(t.expiresAt).getTime():t.timestamp?new Date(t.timestamp).getTime()+r:0;return a>0&&n>a?{accepted:!1,timestamp:null}:t}catch(e){return{accepted:!1,timestamp:null}}}function oe(e){try{var t=24*A*60*60*1e3;e.expiresAt=e.expiresAt||new Date(Date.now()+t).toISOString();localStorage.setItem(L,JSON.stringify(e));localStorage.removeItem(L+"_closed")}catch(e){}I=e;try{je()}catch(e){}}function ce(e){try{var t={analytics:!!e.analytics,preferences:!!e.preferences,marketing:!!e.marketing};var n=btoa(JSON.stringify(t));localStorage.setItem(H,n)}catch(e){}}function se(){try{var e=localStorage.getItem(H);if(!e)return null;var t=JSON.parse(atob(e));return t&&"object"==typeof t?{analytics:!!t.analytics,preferences:!!t.preferences,marketing:!!t.marketing}:null}catch(e){return null}}function le(e,t){if(a&&c){t=t||{};var n=e&&e.expiresAt||t.expiresAt||new Date(Date.now()+24*A*60*60*1e3).toISOString();var r={siteId:a,regulation:"gdpr"===i?"gdpr":"ccpa",bannerType:i,consentMethod:t.consentMethod||"banner",status:t.status||"given",expiresAt:n,consent:e};try{fetch(c+"/api/consent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(r)}).catch(function(e){})}catch(e){}}}function de(){try{var e=localStorage.getItem(T);if(!e)return!1;var t=JSON.parse(e);var n=new Date;var r=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0");return t.yearMonth===r&&!0===t.overLimit}catch(e){return!1}}function pe(e){try{localStorage.setItem(T,JSON.stringify({overLimit:!0,yearMonth:e}))}catch(e){}}function be(){if(a&&c&&!de())try{var e={siteId:a,pageUrl:"undefined"!=typeof window&&window.location?window.location.href:null};fetch(c+"/api/pageview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e),keepalive:!0}).then(function(e){return e.json()}).then(function(e){if(e&&e.overLimit){var t=new Date;pe(e.yearMonth||t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0"))}}).catch(function(e){})}catch(e){}}function fe(){try{var e="undefined"!=typeof document&&document.cookie?document.cookie:"";return e?e.split(";").map(function(e){return e.trim()}).filter(Boolean):[]}catch(e){return[]}}function me(){try{var e=[];var t=document.getElementsByTagName("script");for(var n=0;n<t.length;n++){var r=t[n].src;r&&-1===r.indexOf("consentbit")&&-1===r.indexOf("client_data")&&e.push(r)}return e}catch(e){return[]}}function ge(e){try{var t=new URL(e).hostname;return-1!==t.indexOf("google-analytics.com")||-1!==e.indexOf("gtag/js")||-1!==t.indexOf("googletagmanager.com")?"analytics":-1!==t.indexOf("facebook.com")||-1!==t.indexOf("fbcdn.net")||-1!==t.indexOf("doubleclick.net")||0===t.indexOf("ads.")?"marketing":-1!==t.indexOf("hotjar.com")||-1!==t.indexOf("intercom.io")||-1!==t.indexOf("fullstory.com")?"behavioral":"uncategorized"}catch(e){return"uncategorized"}}function ue(){var t=[];var n=document.scripts;for(var r=0;r<n.length;r++){var a=n[r];if(a.src)t.push(a)}return t}function ye(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("googletagmanager.com/gtag/js")||-1!==t.indexOf("googletagmanager.com/gtm.js")||-1!==t.indexOf("google-analytics.com")||-1!==t.indexOf("googlesyndication.com")||-1!==t.indexOf("googleadservices.com")||-1!==t.indexOf("googletagservices.com")||-1!==t.indexOf("securepubads.g.doubleclick.net")}function ve(){var e=document.scripts;for(var t=0;t<e.length;t++){var n=e[t];var r;if(ye(n.src||n.getAttribute("data-cb-blocked-src")||""))return!0}return!(!window.adsbygoogle&&!window.googletag)}function he(){window.dataLayer=window.dataLayer||[];window.gtag||(window.gtag=function(){dataLayer.push(arguments)});return window.gtag}function xe(){var e=he();e("set","ads_data_redaction",!0);e("set","url_passthrough",!0)}function Ce(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("clarity.ms")||-1!==t.indexOf("clarity.microsoft.com")}function we(e,t){return!("analytics"!==e||!Oe(t))||l&&Ce(t)}function ke(){window.clarity||(window.clarity=function(){(window.clarity.q=window.clarity.q||[]).push(arguments)});return window.clarity}function _e(e){if(l)try{var t=e||{};var n=t.marketing?"granted":"denied";var r=t.analytics?"granted":"denied";var a=n+"|"+r;if(window.__cbClaritySignal===a)return;window.__cbClaritySignal=a;ke()("consentv2",{source:d,ad_Storage:n,analytics_Storage:r})}catch(e){}}function Ee(e,t){try{var n=e||{};window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:"consentbit_consent_update",consentbit_regulation:i,consentbit_source:String(t||"banner").replace(/[[]]/g,"").toLowerCase(),consentbit_essential:!0,consentbit_analytics:!!n.analytics,consentbit_marketing:!!n.marketing,consentbit_preferences:!!n.preferences})}catch(e){}}function Se(e){return"analytics"===e||"marketing"===e||"behavioral"===e||"advertisement"===e||"functional"===e||"performance"===e}function Oe(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("googletagmanager.com/gtag/js")||-1!==t.indexOf("googletagmanager.com/gtm.js")||-1!==t.indexOf("google-analytics.com")}function Be(e){var t=e;"behavioral"===t&&(t="analytics");if("essential"===t)return!0;if("ccpa"===i)return!(I&&I.accepted&&I.ccpa&&I.ccpa.doNotSell&&Se(t));if(!I||!I.accepted)return!1;var n=I.categories||{};return"analytics"===t?!!n.analytics:"marketing"===t||"advertisement"===t?!!n.marketing:"preferences"!==t&&"functional"!==t&&"performance"!==t||!!n.preferences}function Le(e){if(!e)return!1;var t=String(e).split(",");for(var n=0;n<t.length;n++){var r=String(t[n]||"").toLowerCase().trim();if(r){"personalization"===r&&(r="preferences");if(!Be(r))return!1}}return!0}function Ae(e){if(!e)return null;var t=String(e).toLowerCase().trim();return"analytics"===t||"marketing"===t||"behavioral"===t||"preferences"===t||"essential"===t?["essential"===t?"essential":t]:t.indexOf("necessary")>=0||t.indexOf("essential")>=0?["essential"]:t.indexOf("functional")>=0||t.indexOf("preference")>=0?["preferences"]:t.indexOf("analytics")>=0||t.indexOf("performance")>=0||t.indexOf("statistics")>=0?["analytics"]:t.indexOf("advertisement")>=0||t.indexOf("marketing")>=0||t.indexOf("ads")>=0||t.indexOf("social")>=0?["marketing"]:t.indexOf("other")>=0?["analytics"]:null}function Ie(e,t){if(t&&t.getAttribute){var n=Ae(t.getAttribute("data-consentbit"));if(n)return n;var r=t.getAttribute("data-consentbit-category");r||window.__CB_WEBFLOW_MODE__||(r=t.getAttribute("data-category"));if(r){var a=[];var i=String(r).split(",");for(var o=0;o<i.length;o++){var c=String(i[o]||"").toLowerCase().trim();if(c){var s=Ae("personalization"===c?"preferences":c);if(s)for(var l=0;l<s.length;l++)-1===a.indexOf(s[l])&&a.push(s[l])}}if(a.length)return a}var d=Ae(t.getAttribute("data-cookieyes"));if(d)return d}if(e&&j.length)for(var p=0;p<j.length;p++){var b=j[p];if(b&&b.pattern)try{if(new RegExp(b.pattern,"i").test(e))return b.categories&&b.categories.length?b.categories.slice():["analytics"]}catch(e){}}if(e&&V.length)for(var f=0;f<V.length;f++){var m=V[f];if(m&&m.scriptUrlPattern)try{if(new RegExp(m.scriptUrlPattern,"i").test(e))return[m.category||"uncategorized"]}catch(e){}}return[]}function He(e,t){if(z)return!1;if(!e)return!1;if("string"!=typeof e){try{e=String(e)}catch(__cbTT){return!1}}var n=e.toLowerCase();if(-1!==n.indexOf("consentbit")||-1!==n.indexOf("client_data"))return!1;var r=Ie(e,t);if(!r||0===r.length)return!1;if("ccpa"===i)return!!(I&&I.accepted&&I.ccpa&&I.ccpa.doNotSell);for(var a=0;a<r.length;a++){var o=r[a];if(Se(o)&&!we(o,e)&&!Be(o))return!0}return!1}function Te(e){return e&&"string"==typeof e?e.indexOf("fbq(")>=0||e.indexOf("fbq (")>=0||e.indexOf("connect.facebook.net")>=0||e.indexOf("ttq(")>=0||e.indexOf("ttq (")>=0||e.indexOf("analytics.tiktok.com")>=0||e.indexOf("pintrk(")>=0||e.indexOf("pintrk (")>=0||e.indexOf("ct.pinterest.com")>=0||e.indexOf("twq(")>=0||e.indexOf("twq (")>=0||e.indexOf("ads-twitter.com")>=0||e.indexOf("_linkedin_partner_id")>=0||e.indexOf("lintrk(")>=0||e.indexOf("lintrk (")>=0||e.indexOf("bat.bing.com")>=0?"marketing":e.indexOf("hotjar.com")>=0?"analytics":e.indexOf("window.clarity")>=0||e.indexOf("clarity.ms")>=0?l?null:"analytics":null:null}function Pe(e){if(e&&"SCRIPT"===e.nodeName&&(!e.getAttribute||"javascript/blocked"!==e.getAttribute("type"))){var t=e.getAttribute&&e.getAttribute("src")||e.src||"";if(t){if(He(t,e))try{var Ot=e.getAttribute("type")||"";Ot&&"javascript/blocked"!==Ot&&e.setAttribute("data-cb-orig-type",Ot);e.setAttribute("data-cb-blocked-src",t);e.setAttribute("type","javascript/blocked");e.removeAttribute("src")}catch(e){}}else{var n=e.getAttribute&&(e.getAttribute("data-consentbit-category")||!window.__CB_WEBFLOW_MODE__&&e.getAttribute("data-category"))||Te(e.textContent||"");if(n&&!Be(n))try{e.__ci=e.textContent||"";var r=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");r&&r.set?r.set.call(e,""):e.textContent="";e.setAttribute("type","javascript/blocked");e.setAttribute("data-cb-inline","1")}catch(e){}}}}function ze(e){if(e&&!e.__cp){e.__cp=!0;var Sv="";try{Object.defineProperty(e,"src",{configurable:!0,enumerable:!0,get:function(){if(Sv)return String(Sv);var v="";try{v=e.getAttribute&&(e.getAttribute("src")||e.getAttribute("data-cb-blocked-src"))||""}catch(n){}return String(v)},set:function(t){Sv=t;if(He(t,e)){var Ot=e.getAttribute("type")||"";Ot&&"javascript/blocked"!==Ot&&!e.getAttribute("data-cb-orig-type")&&e.setAttribute("data-cb-orig-type",Ot);e.setAttribute("data-cb-blocked-src",t);e.setAttribute("type","javascript/blocked");e.removeAttribute("src")}else e.setAttribute("src",t)}})}catch(e){}try{Object.defineProperty(e,"type",{configurable:!0,enumerable:!0,get:function(){return e.getAttribute("type")||""},set:function(t){var n=t;if(He(e.getAttribute("src")||e.src||"",e)){t&&"javascript/blocked"!==t&&e.setAttribute("data-cb-orig-type",t);n="javascript/blocked"}e.setAttribute("type",n)}})}catch(e){}try{var t=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");if(t&&t.set){var n=t.set;Object.defineProperty(e,"textContent",{configurable:!0,get:function(){return t.get?t.get.call(e):""},set:function(t){var r=e.getAttribute&&(e.getAttribute("data-consentbit-category")||!window.__CB_WEBFLOW_MODE__&&e.getAttribute("data-category"))||Te(t);if(r&&!Be(r)){e.__ci=t;e.setAttribute("type","javascript/blocked");e.setAttribute("data-cb-inline","1")}else n.call(e,t)}})}}catch(e){}}}function Ne(e){if(e&&1===e.nodeType)if("SCRIPT"!==e.nodeName){if(e.querySelectorAll){var t=e.querySelectorAll("script[src]");for(var n=0;n<t.length;n++)Pe(t[n])}}else Pe(e)}function je(e){if(window.__CB_WEBFLOW_MODE__)We(e||I&&I.categories||{analytics:!0,marketing:!0,preferences:!0,essential:!0});else{var t=document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');for(var n=0;n<t.length;n++){var r=t[n];var a=r.getAttribute("data-cb-blocked-src");if(a&&!He(a,r)){z=!0;try{var i=document.createElement("script");i.async=r.hasAttribute("async");i.defer=r.hasAttribute("defer");r.id&&(i.id=r.id);i.src=a;var o=r.attributes;for(var c=0;c<o.length;c++){var s=o[c].name;"src"!==s&&"type"!==s&&"data-cb-blocked-src"!==s&&"data-cb-orig-type"!==s&&"nonce"!==s&&i.setAttribute(s,o[c].value)}var Ty=r.getAttribute("data-cb-orig-type");Ty&&(i.type=Ty);var Nz=r.nonce||r.getAttribute("nonce")||"";if(Nz)try{i.nonce=Nz}catch(e){}r.parentNode?r.parentNode.replaceChild(i,r):document.head.appendChild(i)}catch(e){}finally{z=!1}}}var l=document.querySelectorAll('script[type="text/plain"][data-consentbit-category],script[type="text/plain"][data-category]');for(var d=0;d<l.length;d++){var p=l[d];var b=p.getAttribute("data-consentbit-category")||p.getAttribute("data-category");if(b&&Le(b)){z=!0;try{var f=document.createElement("script");f.async=p.hasAttribute("async");f.defer=p.hasAttribute("defer");var m=p.getAttribute("src")||"";m?f.src=m:f.textContent=p.textContent;var g=p.attributes;for(var u=0;u<g.length;u++){var y=g[u].name;"type"!==y&&"src"!==y&&"data-consentbit-category"!==y&&"data-category"!==y&&f.setAttribute(y,g[u].value)}p.parentNode?p.parentNode.replaceChild(f,p):document.head.appendChild(f)}catch(e){}finally{z=!1}}}var v=document.querySelectorAll('script[type="javascript/blocked"][data-cb-inline="1"]');for(var h=0;h<v.length;h++){var x=v[h];var C=x.__ci||"";var w=x.getAttribute&&(x.getAttribute("data-consentbit-category")||x.getAttribute("data-category"))||Te(C);if(w&&Le(w)){z=!0;try{var k=document.createElement("script");C&&(k.textContent=C);var Nz2=x.nonce||x.getAttribute&&x.getAttribute("nonce")||"";if(Nz2)try{k.nonce=Nz2}catch(e){}x.parentNode?x.parentNode.replaceChild(k,x):document.head.appendChild(k)}catch(e){}finally{z=!1}}}var Fr=document.querySelectorAll("iframe[data-cb-blocked-src]");for(var Fi=0;Fi<Fr.length;Fi++){var Ff=Fr[Fi];var Fs=Ff.getAttribute("data-cb-blocked-src");if(Fs&&!Ze(Fs))try{Ff.removeAttribute("data-cb-blocked-src");Ff.setAttribute("src",Fs)}catch(e){}}}}function Ve(e){var t=window.location.hostname;var n=0===t.indexOf("www.")?t.slice(4):t;var r=[null,t,"."+t,n,"."+n,"www."+n,".www."+n];var a=["/",window.location.pathname];var i="Thu, 01 Jan 1970 00:00:00 GMT";for(var o=0;o<r.length;o++)for(var c=0;c<a.length;c++){var s=e+"=; expires="+i+"; path="+a[c];r[o]&&(s+="; domain="+r[o]);try{document.cookie=s}catch(e){}}}function Me(e){var t=e.indexOf("*");var n=t>=0?e.slice(0,t):null;var r=document.cookie.split(";").map(function(e){return e.trim().split("=")[0]});return n?r.filter(function(e){return e.startsWith(n)}):r.indexOf(e)>=0?[e]:[]}function De(e){for(var t in Z)if(e.indexOf(t)>=0){var n=Z[t];for(var r=0;r<n.length;r++){var a=Me(n[r]);for(var i=0;i<a.length;i++)Ve(a[i])}}for(var o=0;o<V.length;o++){var c=V[o];!c||!c.category||e.indexOf(c.category)<0||c.name&&Ve(c.name)}}function Fe(e){if(!e||"string"!=typeof e)return null;var t=e.toLowerCase();if(0!==t.indexOf("http"))return null;for(var n=0;n<M.length;n++)if(-1!==t.indexOf(M[n].domain))return M[n].category;for(var r=0;r<V.length;r++){var a=V[r];if(a&&a.scriptUrlPattern)try{if(new RegExp(a.scriptUrlPattern,"i").test(e))return a.category||"marketing"}catch(e){}}return null}function Ze(e){if(!e)return!1;if("string"!=typeof e){try{e=String(e)}catch(__cbTT){return!1}}var t=e.toLowerCase();if(-1!==t.indexOf("consentbit")||-1!==t.indexOf("client_data"))return!1;var n=Fe(e);return!(!n||!Se(n)||("ccpa"===i?!(I&&I.accepted&&I.ccpa&&I.ccpa.doNotSell):I&&I.accepted&&Be(n)))}function Re(e){if(e&&!e.__ip){e.__ip=!0;var Iv="";try{Object.defineProperty(e,"src",{configurable:!0,enumerable:!0,get:function(){if(Iv)return String(Iv);var n="";try{n=e.getAttribute&&(e.getAttribute("src")||e.getAttribute("data-cb-blocked-src"))||""}catch(r){}return String(n)},set:function(t){Iv=t;if(Ze(t)){e.setAttribute("data-cb-blocked-src",t);e.removeAttribute("src")}else e.setAttribute("src",t)}})}catch(e){}}}function We(e){if(window.__CB_WEBFLOW_MODE__){var t=e||{};window.userConsent=t;try{document.dispatchEvent(new CustomEvent("consentUpdated",{detail:t,bubbles:!0}))}catch(e){}}}function Ue(){if(!window.__CB_WEBFLOW_MODE__&&!window.__ce){window.__ce=!0;try{N=document.createElement.bind(document)}catch(e){N=document.createElement}document.createElement=function(e,r){var t=arguments.length>1?N(e,r):N(e);var n=String(e||"").toLowerCase();"script"===n?ze(t):"iframe"===n&&Re(t);return t};var e=new MutationObserver(function(e){for(var t=0;t<e.length;t++){var n=e[t];if("childList"===n.type){var r=n.addedNodes;for(var a=0;a<r.length;a++)Ne(r[a])}else"attributes"===n.type&&"src"===n.attributeName&&n.target&&"SCRIPT"===n.target.nodeName&&Pe(n.target)}});try{e.observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["src"]})}catch(t){e.observe(document.documentElement,{childList:!0,subtree:!0})}window.__cm=e}}function qe(){if(window.__CB_WEBFLOW_MODE__)try{document.dispatchEvent(new CustomEvent("cbBlockScripts",{detail:{},bubbles:!0}))}catch(e){}else{var e=ue();for(var t=0;t<e.length;t++){var n=e[t];var r=n.src;if("javascript/blocked"!==n.getAttribute("type")){var a=Ie(r,n);var i=a.length>0?a[0]:"uncategorized";if(Se(i))if("analytics"===i&&s&&Oe(r));else if(l&&Ce(r));else if(Be(i));else try{var Ot=n.getAttribute("type")||"";Ot&&"javascript/blocked"!==Ot&&n.setAttribute("data-cb-orig-type",Ot);n.setAttribute("data-cb-blocked-src",r);n.setAttribute("type","javascript/blocked");n.removeAttribute("src")}catch(e){}}}}}function Je(){if(P.length){var e=[];z=!0;try{for(var t=0;t<P.length;t++){var n=P[t];var r=n.cats||(n.category?[n.category]:[]);if(0===r.length||r.every(function(e){return!Se(e)||Be(e)})){var a=document.createElement("script");a.src=n.src;var i=n.attrs;for(var o in i)Object.prototype.hasOwnProperty.call(i,o)&&"src"!==o&&a.setAttribute(o,i[o]);document.head.appendChild(a)}else e.push(n)}}finally{z=!1}P=e}}function Ye(){if(s){z=!0;try{var e=!1;var t=document.scripts;for(var n=0;n<t.length;n++){var r=t[n].src||"";if(-1!==r.indexOf("googletagmanager.com/gtag/js")||-1!==r.indexOf("googletagmanager.com/gtm.js")||-1!==r.indexOf("google-analytics.com")){e=!0;break}}if(!e){var a=document.createElement("script");a.async=!0;a.src="https://www.googletagmanager.com/gtag/js?id="+s;document.head.appendChild(a)}window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}window.gtag=gtag;xe();gtag("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500});gtag("js",new Date);gtag("config",s,{anonymize_ip:!0});gtag("event","page_view",{page_path:window.location.pathname,page_title:document.title||""})}finally{z=!1}}}function Xe(e,t){var n={analytics_storage:e.analytics?"granted":"denied",ad_storage:e.marketing?"granted":"denied",ad_user_data:e.marketing?"granted":"denied",ad_personalization:e.marketing?"granted":"denied",functionality_storage:e.preferences?"granted":"denied",personalization_storage:e.preferences?"granted":"denied"};he()("consent","update",n);_e(e);Ee(e,t)}function $e(e){var oo=cbLaw&&cbLaw.optOut||["analytics","marketing","preferences"];var ca=!!e&&oo.indexOf("analytics")>=0;var cm=!!e&&oo.indexOf("marketing")>=0;var cp=!!e&&oo.indexOf("preferences")>=0;var t={analytics_storage:ca?"denied":"granted",ad_storage:cm?"denied":"granted",ad_user_data:cm?"denied":"granted",ad_personalization:cm?"denied":"granted",functionality_storage:cp?"denied":"granted",personalization_storage:cp?"denied":"granted"};he()("consent","update",t);var n={analytics:!ca,marketing:!cm,preferences:!cp};_e(n);Ee(n,"ccpa");try{window.dataLayer.push({consentbit_do_not_sell:!!e,consentbit_us_law:cbLaw&&cbLaw.law||null})}catch(e){}}function Ge(e){var t=String(e).replace("#","");3===t.length&&(t=t[0]+t[0]+t[1]+t[1]+t[2]+t[2]);var n;var r;var a;return.299*(parseInt(t.substr(0,2),16)||0)+.587*(parseInt(t.substr(2,2),16)||0)+.114*(parseInt(t.substr(4,2),16)||0)>128?"#0f172a":"#ffffff"}function Ke(){if(!document.getElementById("cb-styles")){var e="#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{background-color:"+(p&&p.saveButtonBg?String(p.saveButtonBg):"#ffffff")+" !important;color:"+(p&&p.saveButtonText?String(p.saveButtonText):"#334155")+" !important;border-color:#e2e8f0 !important;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{background-color:"+(p&&p.acceptButtonBg?String(p.acceptButtonBg):"#ffffff")+" !important;color:"+(p&&p.acceptButtonText?String(p.acceptButtonText):"#334155")+" !important;border-color:"+(p&&p.acceptButtonBg?String(p.acceptButtonBg):"#e2e8f0")+" !important;}";var t="";if(p&&p.backgroundColor){var n=String(p.backgroundColor);t="#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{background-color:"+n+" !important;}.cb-gdpr-accordion{background-color:"+n+" !important;}"}var r="";if(p&&p.headingColor){var a=String(p.headingColor);r="#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{color:"+a+" !important;}.cb-gdpr-cat-label{color:"+a+" !important;}"}var i="";p&&p.textColor&&(i="#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{color:"+String(p.textColor)+" !important;}");var o="";if(p&&p.bannerFontWeight){var c=String(p.bannerFontWeight);o="#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-weight:"+c+" !important;}.cb-gdpr-cat-label{font-weight:"+c+" !important;}.cb-gdpr-cat-desc{font-weight:"+c+" !important;}.cb-banner p{font-weight:"+c+" !important;}"}var s="#cb-preferences-banner.cb-banner h3{padding-right:36px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs h3{padding-right:0 !important;padding-top:16px !important;margin-bottom:14px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs .cb-banner-body>p{margin-bottom:16px !important;}";var l="#cb-preferences-banner.cb-banner .cb-banner-body{padding-right:4px;}#cb-preferences-banner.cb-banner .cb-gdpr-accordion > div{margin-right:2px;}";var d="";if(p&&p.acceptButtonBg){var b=String(p.acceptButtonBg);var f=p.acceptButtonText?String(p.acceptButtonText):"#ffffff";d=".cb-banner button#cb-accept-all-btn{background-color:"+b+" !important;color:"+f+" !important;}#cb-initial-banner.cb-banner #cb-accept-all-btn{background:"+b+" !important;color:"+f+" !important;}"}var m="";if(p&&p.acceptButtonBg){var g=String(p.acceptButtonBg);var u=p.acceptButtonText?String(p.acceptButtonText):"#ffffff";m=".cb-banner button#cb-reject-all-btn{background-color:"+g+" !important;color:"+u+" !important;}#cb-initial-banner.cb-banner #cb-reject-all-btn{background:"+g+" !important;color:"+u+" !important;}.cb-banner button#cb-prefs-reject-btn{background-color:"+g+" !important;color:"+u+" !important;}"}var y=document.createElement("style");y.id="cb-styles";y.type="text/css";var v="";p&&p.backgroundColor&&(v="#cb-close-initial-btn,#cb-close-prefs-btn{color:"+Ge(p.backgroundColor)+" !important;}");y.appendChild(document.createTextNode(D+"\\n"+e+"\\n"+t+"\\n"+r+"\\n"+i+"\\n"+o+"\\n"+s+"\\n"+l+"\\n"+d+"\\n"+m+"\\n"+v));document.head.appendChild(y)}}function Qe(e,t){if(X()){var n=document.createElement("button");n.type="button";n.id=t;n.setAttribute("aria-label","Close");n.textContent="×";var r="#0f172a";p&&p.backgroundColor&&(r=Ge(p.backgroundColor));n.style.cssText="position:absolute;top:8px;right:24px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:"+r+";opacity:0.75;";e.appendChild(n)}}function et(e){if(X()){var t=document.createElement("button");t.type="button";t.id="cb-close-prefs-btn";t.setAttribute("aria-label","Close");t.textContent="×";var n="#0f172a";p&&p.backgroundColor&&(n=Ge(p.backgroundColor));t.style.cssText="position:absolute;top:8px;right:30px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:"+n+";opacity:0.75;";e.appendChild(t)}}function tt(){return'<svg viewBox="0 0 735 90" role="img" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="#98A2B3"><path d="M234.357 89.2656C227.796 89.2656 222.045 87.925 217.107 85.2439C212.238 82.4923 208.464 78.647 205.782 73.7081C203.101 68.7692 201.761 62.9484 201.761 56.2456C201.761 49.5428 203.101 43.722 205.782 38.7831C208.464 33.8442 212.238 30.0342 217.107 27.3531C222.045 24.6014 227.796 23.2256 234.357 23.2256C241.131 23.2256 246.916 24.5661 251.714 27.2472C256.582 29.9284 260.322 33.7384 262.932 38.6772C265.614 43.6161 266.954 49.4722 266.954 56.2456C266.954 62.9484 265.614 68.8045 262.932 73.8139C260.322 78.7528 256.582 82.5628 251.714 85.2439C246.846 87.925 241.06 89.2656 234.357 89.2656ZM234.357 78.8939C240.919 78.8939 245.999 76.9184 249.597 72.9672C253.266 68.9456 255.101 63.3717 255.101 56.2456C255.101 49.0489 253.266 43.475 249.597 39.5239C245.999 35.5728 240.919 33.5972 234.357 33.5972C227.866 33.5972 222.786 35.6081 219.117 39.6298C215.449 43.5809 213.614 49.1195 213.614 56.2456C213.614 63.3717 215.449 68.9456 219.117 72.9672C222.786 76.9184 227.866 78.8939 234.357 78.8939Z"/><path d="M158.471 89.3708C149.793 89.3708 142.208 87.5717 135.717 83.9733C129.297 80.3044 124.322 75.1539 120.795 68.5217C117.267 61.8894 115.503 54.0931 115.503 45.1325C115.503 36.1719 117.267 28.4108 120.795 21.8492C124.322 15.2169 129.297 10.1017 135.717 6.50333C142.208 2.83444 149.793 1 158.471 1C165.103 1 170.96 2.09361 176.04 4.28083C181.19 6.3975 185.423 9.53722 188.74 13.7C192.056 17.7922 194.313 22.7664 195.513 28.6225H183.236C181.966 23.1897 179.179 18.9917 174.875 16.0283C170.642 13.065 165.174 11.5833 158.471 11.5833C148.805 11.5833 141.22 14.5819 135.717 20.5792C130.214 26.5764 127.462 34.7608 127.462 45.1325C127.462 55.5747 130.214 63.7944 135.717 69.7917C141.22 75.7183 148.805 78.6817 158.471 78.6817C165.174 78.6817 170.642 77.2353 174.875 74.3425C179.179 71.3792 181.966 67.1811 183.236 61.7483H195.513C194.313 67.5339 192.056 72.5081 188.74 76.6708C185.423 80.7631 181.19 83.9028 176.04 86.09C170.96 88.2772 165.103 89.3708 158.471 89.3708Z"/><path d="M372.231 89.2656C363.412 89.2656 356.462 87.4311 351.382 83.7623C346.302 80.0934 343.515 74.9781 343.021 68.4164H354.769C355.263 72.297 356.956 75.1545 359.849 76.9889C362.742 78.8234 367.01 79.7406 372.655 79.7406C382.533 79.7406 387.471 76.6361 387.471 70.4272C387.471 67.8872 386.695 65.947 385.143 64.6064C383.661 63.1953 381.121 62.1722 377.523 61.5372L363.659 58.9973C351.876 56.81 345.985 51.2009 345.985 42.1697C345.985 36.3136 348.207 31.6923 352.652 28.3056C357.097 24.9189 363.165 23.2256 370.856 23.2256C378.828 23.2256 385.143 24.9542 389.8 28.4114C394.527 31.8686 397.208 36.737 397.843 43.0164H386.307C385.602 39.4886 383.944 36.8781 381.333 35.1847C378.793 33.4914 375.195 32.6448 370.538 32.6448C366.234 32.6448 362.883 33.3856 360.484 34.8673C358.156 36.3489 356.991 38.5009 356.991 41.3231C356.991 43.5103 357.732 45.2389 359.214 46.5089C360.766 47.7084 363.236 48.6256 366.622 49.2606L380.486 51.9064C386.695 53.0353 391.246 55.0461 394.139 57.9389C397.032 60.8317 398.478 64.7122 398.478 69.5806C398.478 75.7895 396.22 80.6225 391.705 84.0798C387.189 87.537 380.698 89.2656 372.231 89.2656Z"/><path d="M437.465 89.2656C430.833 89.2656 425.083 87.925 420.215 85.2439C415.346 82.4923 411.572 78.6117 408.89 73.6022C406.28 68.5928 404.975 62.7367 404.975 56.0339C404.975 49.3311 406.28 43.5456 408.89 38.6772C411.572 33.7384 415.311 29.9284 420.109 27.2472C424.907 24.5661 430.516 23.2256 436.936 23.2256C443.075 23.2256 448.366 24.4603 452.811 26.9297C457.327 29.3992 460.819 32.8917 463.289 37.4073C465.758 41.9228 466.993 47.285 466.993 53.4939V58.2564H416.405C416.757 64.8886 418.768 70.0745 422.437 73.8139C426.177 77.4828 431.151 79.3172 437.36 79.3172C441.663 79.3172 445.297 78.4353 448.26 76.6714C451.224 74.837 453.27 72.1559 454.399 68.6281H466.464C464.912 75.1897 461.56 80.2697 456.41 83.8681C451.33 87.4664 445.015 89.2656 437.465 89.2656ZM416.828 49.5781H455.563C454.998 44.357 453.058 40.3 449.742 37.4073C446.497 34.5145 442.193 33.0681 436.83 33.0681C431.539 33.0681 427.129 34.5145 423.601 37.4073C420.073 40.3 417.816 44.357 416.828 49.5781Z"/><path d="M564.448 87.9953C561.061 87.9953 558.415 87.1486 556.51 85.4553C554.676 83.6914 553.759 81.0809 553.759 77.6236V33.597H541.905V24.4953H553.864V7.99512H565.506V24.4953H582.122V33.597H565.612V78.682H583.815V87.9953H564.448Z"/><path d="M672 88V35H687V88H672Z"/><path d="M671 23V8H687V23H671Z"/><path d="M716.594 87.9955C712.693 87.9955 709.652 87.0038 707.47 85.0205C705.355 83.0372 704.297 80.0291 704.297 75.9963L704.297 35.4985H693.785V23.9951H704.396L704.53 7.99512L718.875 7.99512L718.874 23.9951H735V35.4985H719.073L719.073 76.393H734.642V87.9955H716.594Z"/><path d="M283.197 33.4209H287.594C289.814 29.8402 292.857 27.1189 296.725 25.2568C300.592 23.3231 305.14 22.3565 310.368 22.3564C318.676 22.3564 325.229 24.7554 330.027 29.5537C334.826 34.2805 337.226 40.6188 337.226 48.5684V87.9951H325.193V50.6104C325.193 44.8093 323.618 40.4045 320.467 37.3965C317.387 34.3885 312.839 32.8838 306.823 32.8838C300.879 32.8838 296.331 34.3885 293.18 37.3965C290.029 40.4045 288.453 44.8093 288.453 50.6104V87.9951H276.421V36.2266H267.972V21H283.197V33.4209Z"/><path d="M486 34.2314H489.33C491.517 30.7038 494.516 28.0229 498.326 26.1885C502.136 24.2835 506.617 23.3311 511.768 23.3311C519.952 23.3311 526.408 25.6947 531.135 30.4219C535.862 35.0785 538.226 41.3227 538.226 49.1543V87.9951H526.372V51.165C526.372 45.4501 524.82 41.1108 521.716 38.1475C518.682 35.1841 514.201 33.7031 508.274 33.7031C502.419 33.7032 497.938 35.1843 494.834 38.1475C491.73 41.1108 490.177 45.4501 490.177 51.165V87.9951H478.324V36.9951H470V20.9951H486V34.2314Z"/><path d="M631.386 7.66992C636.211 7.66997 640.376 8.52936 643.88 10.248C647.45 11.9008 650.26 14.2815 652.31 17.3887C654.359 20.4297 655.384 23.9999 655.384 28.0986C655.384 32.2635 653.684 36.2398 652 38.9951C649.075 43.7811 645.5 44.7578 645.627 44.7578L648.988 45.1553C651.963 45.8164 654.673 47.0394 657.119 48.8242C659.631 50.6092 661.615 52.8569 663.069 55.5674C664.59 58.2779 665.351 61.4843 665.351 65.1865C665.351 69.7482 664.226 73.7478 661.979 77.1855C659.797 80.5572 656.723 83.2019 652.756 85.1191C648.855 87.0363 644.326 87.9951 639.17 87.9951H596.826V21H611.999V40.2959H629.303C632.807 40.2959 635.484 39.4691 637.335 37.8164C639.252 36.0975 640.211 33.6844 640.211 30.5771C640.211 27.3378 639.252 24.892 637.335 23.2393C635.484 21.5866 632.807 20.7598 629.303 20.7598H612V7.66992H631.386ZM611.999 74.9053H636.394C640.823 74.9053 644.227 73.9463 646.607 72.0293C648.987 70.046 650.178 67.2031 650.178 63.501C650.178 59.8649 648.987 57.1206 646.607 55.2695C644.228 53.3526 640.856 52.3946 636.493 52.3945H611.999V74.9053Z"/></g><path d="M32.7604 87.4506C32.0233 88.1831 30.8281 88.1831 30.0909 87.4506L8.45288 65.9485C-2.81763 54.7488 -2.81763 36.5904 8.45288 25.3907C8.97709 24.8698 9.827 24.8698 10.3512 25.3907L51.4471 66.2285C52.1843 66.961 52.1843 68.1487 51.4471 68.8813L32.7604 87.4506Z" fill="#B4BCC8"/><path d="M35.3829 43.3719C34.8671 42.8423 34.8732 41.9897 35.3966 41.4677L76.4272 0.544909C77.1632 -0.189157 78.3479 -0.180458 79.0733 0.564338L97.4615 19.4444C98.1869 20.1891 98.1783 21.388 97.4423 22.1221L75.8387 43.669C64.5861 54.892 46.4734 54.759 35.3829 43.3719Z" fill="#8C95A3"/></svg>'}function nt(e){if(cbHideBrand)return;var t=document.createElement("div");t.className="cb-brand-footer";var n=document.createElement("a");n.href="https://consentbit.com";n.target="_blank";n.rel="noopener noreferrer";n.setAttribute("aria-label","Powered by ConsentBit");var r=document.createElement("span");r.className="cb-brand-credit";r.textContent="Powered by";n.appendChild(r);var a=document.createElement("span");a.className="cb-brand-mark";a.innerHTML='<svg viewBox="0 0 735 90" role="img" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="#98A2B3"><path d="M234.357 89.2656C227.796 89.2656 222.045 87.925 217.107 85.2439C212.238 82.4923 208.464 78.647 205.782 73.7081C203.101 68.7692 201.761 62.9484 201.761 56.2456C201.761 49.5428 203.101 43.722 205.782 38.7831C208.464 33.8442 212.238 30.0342 217.107 27.3531C222.045 24.6014 227.796 23.2256 234.357 23.2256C241.131 23.2256 246.916 24.5661 251.714 27.2472C256.582 29.9284 260.322 33.7384 262.932 38.6772C265.614 43.6161 266.954 49.4722 266.954 56.2456C266.954 62.9484 265.614 68.8045 262.932 73.8139C260.322 78.7528 256.582 82.5628 251.714 85.2439C246.846 87.925 241.06 89.2656 234.357 89.2656ZM234.357 78.8939C240.919 78.8939 245.999 76.9184 249.597 72.9672C253.266 68.9456 255.101 63.3717 255.101 56.2456C255.101 49.0489 253.266 43.475 249.597 39.5239C245.999 35.5728 240.919 33.5972 234.357 33.5972C227.866 33.5972 222.786 35.6081 219.117 39.6298C215.449 43.5809 213.614 49.1195 213.614 56.2456C213.614 63.3717 215.449 68.9456 219.117 72.9672C222.786 76.9184 227.866 78.8939 234.357 78.8939Z"/><path d="M158.471 89.3708C149.793 89.3708 142.208 87.5717 135.717 83.9733C129.297 80.3044 124.322 75.1539 120.795 68.5217C117.267 61.8894 115.503 54.0931 115.503 45.1325C115.503 36.1719 117.267 28.4108 120.795 21.8492C124.322 15.2169 129.297 10.1017 135.717 6.50333C142.208 2.83444 149.793 1 158.471 1C165.103 1 170.96 2.09361 176.04 4.28083C181.19 6.3975 185.423 9.53722 188.74 13.7C192.056 17.7922 194.313 22.7664 195.513 28.6225H183.236C181.966 23.1897 179.179 18.9917 174.875 16.0283C170.642 13.065 165.174 11.5833 158.471 11.5833C148.805 11.5833 141.22 14.5819 135.717 20.5792C130.214 26.5764 127.462 34.7608 127.462 45.1325C127.462 55.5747 130.214 63.7944 135.717 69.7917C141.22 75.7183 148.805 78.6817 158.471 78.6817C165.174 78.6817 170.642 77.2353 174.875 74.3425C179.179 71.3792 181.966 67.1811 183.236 61.7483H195.513C194.313 67.5339 192.056 72.5081 188.74 76.6708C185.423 80.7631 181.19 83.9028 176.04 86.09C170.96 88.2772 165.103 89.3708 158.471 89.3708Z"/><path d="M372.231 89.2656C363.412 89.2656 356.462 87.4311 351.382 83.7623C346.302 80.0934 343.515 74.9781 343.021 68.4164H354.769C355.263 72.297 356.956 75.1545 359.849 76.9889C362.742 78.8234 367.01 79.7406 372.655 79.7406C382.533 79.7406 387.471 76.6361 387.471 70.4272C387.471 67.8872 386.695 65.947 385.143 64.6064C383.661 63.1953 381.121 62.1722 377.523 61.5372L363.659 58.9973C351.876 56.81 345.985 51.2009 345.985 42.1697C345.985 36.3136 348.207 31.6923 352.652 28.3056C357.097 24.9189 363.165 23.2256 370.856 23.2256C378.828 23.2256 385.143 24.9542 389.8 28.4114C394.527 31.8686 397.208 36.737 397.843 43.0164H386.307C385.602 39.4886 383.944 36.8781 381.333 35.1847C378.793 33.4914 375.195 32.6448 370.538 32.6448C366.234 32.6448 362.883 33.3856 360.484 34.8673C358.156 36.3489 356.991 38.5009 356.991 41.3231C356.991 43.5103 357.732 45.2389 359.214 46.5089C360.766 47.7084 363.236 48.6256 366.622 49.2606L380.486 51.9064C386.695 53.0353 391.246 55.0461 394.139 57.9389C397.032 60.8317 398.478 64.7122 398.478 69.5806C398.478 75.7895 396.22 80.6225 391.705 84.0798C387.189 87.537 380.698 89.2656 372.231 89.2656Z"/><path d="M437.465 89.2656C430.833 89.2656 425.083 87.925 420.215 85.2439C415.346 82.4923 411.572 78.6117 408.89 73.6022C406.28 68.5928 404.975 62.7367 404.975 56.0339C404.975 49.3311 406.28 43.5456 408.89 38.6772C411.572 33.7384 415.311 29.9284 420.109 27.2472C424.907 24.5661 430.516 23.2256 436.936 23.2256C443.075 23.2256 448.366 24.4603 452.811 26.9297C457.327 29.3992 460.819 32.8917 463.289 37.4073C465.758 41.9228 466.993 47.285 466.993 53.4939V58.2564H416.405C416.757 64.8886 418.768 70.0745 422.437 73.8139C426.177 77.4828 431.151 79.3172 437.36 79.3172C441.663 79.3172 445.297 78.4353 448.26 76.6714C451.224 74.837 453.27 72.1559 454.399 68.6281H466.464C464.912 75.1897 461.56 80.2697 456.41 83.8681C451.33 87.4664 445.015 89.2656 437.465 89.2656ZM416.828 49.5781H455.563C454.998 44.357 453.058 40.3 449.742 37.4073C446.497 34.5145 442.193 33.0681 436.83 33.0681C431.539 33.0681 427.129 34.5145 423.601 37.4073C420.073 40.3 417.816 44.357 416.828 49.5781Z"/><path d="M564.448 87.9953C561.061 87.9953 558.415 87.1486 556.51 85.4553C554.676 83.6914 553.759 81.0809 553.759 77.6236V33.597H541.905V24.4953H553.864V7.99512H565.506V24.4953H582.122V33.597H565.612V78.682H583.815V87.9953H564.448Z"/><path d="M672 88V35H687V88H672Z"/><path d="M671 23V8H687V23H671Z"/><path d="M716.594 87.9955C712.693 87.9955 709.652 87.0038 707.47 85.0205C705.355 83.0372 704.297 80.0291 704.297 75.9963L704.297 35.4985H693.785V23.9951H704.396L704.53 7.99512L718.875 7.99512L718.874 23.9951H735V35.4985H719.073L719.073 76.393H734.642V87.9955H716.594Z"/><path d="M283.197 33.4209H287.594C289.814 29.8402 292.857 27.1189 296.725 25.2568C300.592 23.3231 305.14 22.3565 310.368 22.3564C318.676 22.3564 325.229 24.7554 330.027 29.5537C334.826 34.2805 337.226 40.6188 337.226 48.5684V87.9951H325.193V50.6104C325.193 44.8093 323.618 40.4045 320.467 37.3965C317.387 34.3885 312.839 32.8838 306.823 32.8838C300.879 32.8838 296.331 34.3885 293.18 37.3965C290.029 40.4045 288.453 44.8093 288.453 50.6104V87.9951H276.421V36.2266H267.972V21H283.197V33.4209Z"/><path d="M486 34.2314H489.33C491.517 30.7038 494.516 28.0229 498.326 26.1885C502.136 24.2835 506.617 23.3311 511.768 23.3311C519.952 23.3311 526.408 25.6947 531.135 30.4219C535.862 35.0785 538.226 41.3227 538.226 49.1543V87.9951H526.372V51.165C526.372 45.4501 524.82 41.1108 521.716 38.1475C518.682 35.1841 514.201 33.7031 508.274 33.7031C502.419 33.7032 497.938 35.1843 494.834 38.1475C491.73 41.1108 490.177 45.4501 490.177 51.165V87.9951H478.324V36.9951H470V20.9951H486V34.2314Z"/><path d="M631.386 7.66992C636.211 7.66997 640.376 8.52936 643.88 10.248C647.45 11.9008 650.26 14.2815 652.31 17.3887C654.359 20.4297 655.384 23.9999 655.384 28.0986C655.384 32.2635 653.684 36.2398 652 38.9951C649.075 43.7811 645.5 44.7578 645.627 44.7578L648.988 45.1553C651.963 45.8164 654.673 47.0394 657.119 48.8242C659.631 50.6092 661.615 52.8569 663.069 55.5674C664.59 58.2779 665.351 61.4843 665.351 65.1865C665.351 69.7482 664.226 73.7478 661.979 77.1855C659.797 80.5572 656.723 83.2019 652.756 85.1191C648.855 87.0363 644.326 87.9951 639.17 87.9951H596.826V21H611.999V40.2959H629.303C632.807 40.2959 635.484 39.4691 637.335 37.8164C639.252 36.0975 640.211 33.6844 640.211 30.5771C640.211 27.3378 639.252 24.892 637.335 23.2393C635.484 21.5866 632.807 20.7598 629.303 20.7598H612V7.66992H631.386ZM611.999 74.9053H636.394C640.823 74.9053 644.227 73.9463 646.607 72.0293C648.987 70.046 650.178 67.2031 650.178 63.501C650.178 59.8649 648.987 57.1206 646.607 55.2695C644.228 53.3526 640.856 52.3946 636.493 52.3945H611.999V74.9053Z"/></g><path d="M32.7604 87.4506C32.0233 88.1831 30.8281 88.1831 30.0909 87.4506L8.45288 65.9485C-2.81763 54.7488 -2.81763 36.5904 8.45288 25.3907C8.97709 24.8698 9.827 24.8698 10.3512 25.3907L51.4471 66.2285C52.1843 66.961 52.1843 68.1487 51.4471 68.8813L32.7604 87.4506Z" fill="#B4BCC8"/><path d="M35.3829 43.3719C34.8671 42.8423 34.8732 41.9897 35.3966 41.4677L76.4272 0.544909C77.1632 -0.189157 78.3479 -0.180458 79.0733 0.564338L97.4615 19.4444C98.1869 20.1891 98.1783 21.388 97.4423 22.1221L75.8387 43.669C64.5861 54.892 46.4734 54.759 35.3829 43.3719Z" fill="#8C95A3"/></svg>';n.appendChild(a);t.appendChild(n);e.appendChild(t)}function rt(e){return e?"slide-up"===y?"cb-banner-animate-initial-center-bottom":"slide-down"===y?"cb-banner-animate-initial-center-top":"zoom-in"===y?"cb-banner-animate-initial-center-zoom":"cb-banner-animate-fade":"slide-up"===y?"cb-banner-animate-bottom":"slide-down"===y?"cb-banner-animate-top":"zoom-in"===y?"cb-banner-animate-zoom-in":"cb-banner-animate-fade"}function at(){if(!document.getElementById("cb-initial-banner"))if(document.body){var e="ccpa"===i;var t=document.createElement("div");if(e){var n=document.createElement("div");n.className="cb-banner";n.id="cb-initial-banner";n.style.display="none";var r=document.createElement("div");r.className="cb-banner-body";var a=document.createElement("h3");a.textContent=J("title",k);r.appendChild(a);var o=document.createElement("p");var c=q(W("ccpaDescription")||W("description"),_);if(m&&Y()){o.appendChild(document.createTextNode(c+" "));var s=document.createElement("a");s.textContent=J("privacyPolicy",S);s.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(s,m);o.appendChild(s);o.appendChild(document.createTextNode("."))}else o.textContent=c;r.appendChild(o);var l=document.createElement("p");l.style.marginTop="20px";l.style.marginBottom="0";var d=document.createElement("button");d.id="cb-ccpa-donotsell-link";d.type="button";d.textContent=W("doNotSell");d.style.cssText="background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;text-align:left;display:inline;";l.appendChild(d);r.appendChild(l);n.appendChild(r);Qe(n,"cb-close-initial-btn");t.appendChild(n);var p=document.createElement("div");p.className="cb-banner cb-ccpa-prefs";p.id="cb-preferences-banner";p.style.display="none";"left"===v?p.classList.add("prefs-left"):"right"===v?p.classList.add("prefs-right"):p.classList.add("prefs-center");var b=document.createElement("div");b.className="cb-banner-body";var f=document.createElement("h3");f.textContent=W("optOutPreference");b.appendChild(f);var y=document.createElement("p");var h=(W("ccpaOptOutPreferenceIntro")||W("ccpaOptOut")||"").replace(/s*More info.?s*$/i,"").trim();if(m&&Y()){y.appendChild(document.createTextNode(h+" "));var x=document.createElement("a");x.textContent=W("privacyPolicy");x.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(x,m);y.appendChild(x);y.appendChild(document.createTextNode("."))}else y.textContent=h;y.style.lineHeight="1.45";b.appendChild(y);var C=document.createElement("label");C.style.cssText="display:flex;align-items:flex-start;gap:12px;margin-top:20px;cursor:pointer;";var w=document.createElement("span");w.style.cssText="flex:1;line-height:1.45;";w.textContent=W("doNotSell");var O=document.createElement("input");O.type="checkbox";O.id="cb-ccpa-optout";O.style.cssText="flex-shrink:0;margin-top:2px;";O.checked=!!(I&&I.accepted&&I.ccpa&&I.ccpa.doNotSell);C.appendChild(O);C.appendChild(w);b.appendChild(C);p.appendChild(b);var B=document.createElement("div");B.className="cb-banner-footer";var L=document.createElement("button");L.id="cb-cancel-prefs-btn";L.textContent=U("cancel");B.appendChild(L);var A=document.createElement("button");A.id="cb-save-prefs-btn";A.textContent=W("saveMyPreferences")||W("save");B.appendChild(A);p.appendChild(B);nt(p);et(p);t.appendChild(p)}else{var H=function(e){var t=document.createElement("div");t.style.borderBottom="1px solid #e5e7eb";var n=document.createElement("div");n.style.cssText="display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";var r=document.createElement("button");r.type="button";r.setAttribute("aria-expanded","false");r.textContent="+";r.style.cssText="flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";var a=document.createElement("span");a.className="cb-gdpr-cat-label";a.style.cssText="flex:1;font-size:11px;font-weight:600;";a.textContent=e.labelText;n.appendChild(r);n.appendChild(a);var i=document.createElement("div");i.style.flexShrink="0";if(e.alwaysActive){var o=document.createElement("span");o.style.cssText="font-size:11px;font-weight:600;color:#374151;";o.textContent=J("alwaysActive",20);i.appendChild(o)}else{var c=document.createElement("input");c.type="checkbox";c.id=e.checkboxId;e.defaultChecked&&(c.checked=!0);c.style.cssText="position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";var s=document.createElement("button");s.type="button";s.className="cb-pref-toggle-track";s.setAttribute("role","switch");s.setAttribute("aria-label",e.labelText);var l=function(){s.setAttribute("aria-checked",c.checked?"true":"false")};s.addEventListener("click",function(){c.checked=!c.checked;l()});l();i.appendChild(c);i.appendChild(s)}n.appendChild(i);var d=document.createElement("div");d.className="cb-gdpr-cat-desc";d.style.cssText="display:grid;grid-template-rows:0fr;opacity:0;font-size:13px;line-height:1.5;transition:grid-template-rows .3s ease,opacity .25s ease;";var p=document.createElement("div");p.style.cssText="overflow:hidden;min-height:0;padding:0 12px 12px 44px;";p.textContent=e.descText;d.appendChild(p);var b=function(e){e.style.gridTemplateRows="1fr";e.style.opacity=""};var f=function(e){e.style.gridTemplateRows="0fr";e.style.opacity="0"};r.addEventListener("click",function(){var e="true"!==r.getAttribute("aria-expanded");var n=t.parentNode;if(n){var a=n.children;for(var i=0;i<a.length;i++){var o=a[i].querySelector(".cb-gdpr-cat-desc");var c=a[i].querySelector("button[aria-expanded]");if(o&&o!==d){f(o);if(c){c.textContent="+";c.setAttribute("aria-expanded","false")}}}}e?b(d):f(d);r.textContent=e?"−":"+";r.setAttribute("aria-expanded",e?"true":"false")});t.appendChild(n);t.appendChild(d);return t};var T=document.createElement("div");T.className="cb-banner";T.id="cb-initial-banner";T.style.display="none";var P=document.createElement("div");P.className="cb-banner-body";var z=document.createElement("h3");z.textContent=W("title");P.appendChild(z);var N=document.createElement("p");var j=W("description");if(m&&Y()){N.appendChild(document.createTextNode(j+" "));var V=document.createElement("a");V.textContent=W("privacyPolicy");V.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(V,m);N.appendChild(V);N.appendChild(document.createTextNode("."))}else N.textContent=j;P.appendChild(N);T.appendChild(P);var M=document.createElement("div");M.className="cb-banner-footer";var D=document.createElement("button");D.id="cb-preferences-btn";D.textContent=q(U("customise"),E);G()&&M.appendChild(D);var F=document.createElement("button");F.id="cb-reject-all-btn";F.textContent=q(U("rejectAll"),E);$()&&M.appendChild(F);var Z=document.createElement("button");Z.id="cb-accept-all-btn";Z.textContent=q(U("acceptAll"),E);M.appendChild(Z);T.appendChild(M);Qe(T,"cb-close-initial-btn");t.appendChild(T);var R=document.createElement("div");R.className="cb-banner";R.id="cb-preferences-banner";R.style.display="none";"left"===v?R.classList.add("prefs-left"):"right"===v?R.classList.add("prefs-right"):R.classList.add("prefs-center");var X=document.createElement("div");X.className="cb-banner-body";var K=document.createElement("h3");K.textContent=J("cookiePreferences",k);X.appendChild(K);var Q=document.createElement("p");var te=(q(W("managePreferences"),_)||"").replace(/s*More info.?s*$/i,"").trim();if(m&&Y()){Q.appendChild(document.createTextNode(te+" "));var ne=document.createElement("a");ne.textContent=J("privacyPolicy",S);ne.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(ne,m);Q.appendChild(ne);Q.appendChild(document.createTextNode("."))}else Q.textContent=te;X.appendChild(Q);var re=document.createElement("div");re.className="cb-gdpr-accordion";re.style.cssText="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";var ie=J("strictlyNecessary",20)||J("essential",20);re.appendChild(H({labelText:ie,alwaysActive:!0,descText:J("essentialDescription",300)}));var oe=se()||I&&I.accepted&&I.categories||{};re.appendChild(H({labelText:J("marketing",20),checkboxId:"cb-pref-marketing",defaultChecked:!!oe.marketing,descText:J("marketingDescription",300)}));re.appendChild(H({labelText:J("analytics",20),checkboxId:"cb-pref-analytics",defaultChecked:!!oe.analytics,descText:J("analyticsDescription",300)}));re.appendChild(H({labelText:J("preferences",20),checkboxId:"cb-pref-preferences",defaultChecked:!!oe.preferences,descText:J("preferencesDescription",300)}));re.lastChild&&(re.lastChild.style.borderBottom="none");X.appendChild(re);R.appendChild(X);var ce=document.createElement("div");ce.className="cb-banner-footer";var le=document.createElement("button");le.id="cb-prefs-reject-btn";le.textContent=q(U("rejectAll"),E);ce.appendChild(le);var de=document.createElement("button");de.id="cb-save-prefs-btn";de.textContent=q(U("saveMyPreferences")||U("save"),E);ce.appendChild(de);R.appendChild(ce);nt(R);et(R);t.appendChild(R)}document.body.appendChild(t);g&&(document.body.style.overflow="hidden");if(!window.__cbResizeInit){window.__cbResizeInit=!0;window.addEventListener("resize",function(){var e=document.getElementById("cb-initial-banner");e&&"none"!==e.style.display&&"hidden"!==e.style.visibility&&ee(e)})}var pe=document.getElementById("cb-initial-banner");if(pe){var be=ee(pe);pe.style.display="flex";pe.style.visibility="visible";pe.style.opacity="1";u&&pe.classList.add(rt(be))}}else setTimeout(at,100)}function it(){g&&(document.body.style.overflow="")}function ot(){try{if(p&&!1===p.showBannerLogo)return!1;if(p&&0===p.showBannerLogo)return!1;var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.floatingButtonEnabled?t.floatingButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).floatingButtonEnabled;return!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function ct(){try{var e=parseInt(localStorage.getItem(L+"_closed")||"0",10);if(!e)return!1;if(ot())return!0;if(Date.now()-e<864e5)return!0;localStorage.removeItem(L+"_closed");return!1}catch(e){return!1}}function st(){try{if(p&&p.bannerLogoPosition)return"right"===p.bannerLogoPosition?"right":"left";var e=R();var t=TRANSLATIONS.config||{};var n;return"right"===(null!=t.floatingButtonPosition?t.floatingButtonPosition:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).floatingButtonPosition)?"right":"left"}catch(e){return"left"}}function lt(){var e="http://www.w3.org/2000/svg";var t=document.createElementNS(e,"svg");t.setAttribute("xmlns",e);t.setAttribute("viewBox","0 0 40 40");t.setAttribute("width","44");t.setAttribute("height","44");t.setAttribute("aria-hidden","true");t.setAttribute("focusable","false");t.style.cssText="display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";var n=document.createElementNS(e,"circle");n.setAttribute("cx","20");n.setAttribute("cy","20");n.setAttribute("r","18");n.setAttribute("fill","#007aff");t.appendChild(n);var r=[{cx:"14",cy:"14",r:"2.2"},{cx:"24",cy:"18",r:"2.5"},{cx:"17",cy:"25",r:"2"}];for(var a=0;a<r.length;a++){var i=document.createElementNS(e,"circle");i.setAttribute("cx",r[a].cx);i.setAttribute("cy",r[a].cy);i.setAttribute("r",r[a].r);i.setAttribute("fill","#ffffff");t.appendChild(i)}return t}function dt(){try{var e=document.getElementsByTagName("script");for(var t=e.length-1;t>=0;t--){var n=e[t].src||"";if(-1!==n.indexOf("/consentbit/")||-1!==n.indexOf("/client_data/"))return new URL(n).origin}}catch(e){}return""}function pt(){if(!document.getElementById("cb-floating-trigger")&&ot()){var e=st();var t=n||"";var a=r||"";if(!t){var i=dt();if(i){t=i+"/embed/floating-logo.svg";a||(a=t)}}var o=document.createElement("button");o.id="cb-floating-trigger";o.type="button";o.setAttribute("aria-label",W("cookiePreferences"));o.style.cssText="position:fixed;bottom:28px;"+("right"===e?"right:16px;":"left:16px;")+"z-index:2147483646;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;";if(t){var c=document.createElement("img");c.alt="";c.src=t;c.setAttribute("width","44");c.setAttribute("height","44");c.draggable=!1;c.style.cssText="display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";var s=!1;c.addEventListener("error",function e(){if(s||!a||t===a){c.removeEventListener("error",e);c.parentNode&&c.parentNode.replaceChild(lt(),c)}else{s=!0;c.src=a}});o.appendChild(c)}else o.appendChild(lt());document.body.appendChild(o)}}function bt(){return u?"left"===v?"zoom-in"===y?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-prefs-left":"right"===v?"zoom-in"===y?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-prefs-right":"slide-up"===y?"cb-banner-animate-center-bottom":"slide-down"===y?"cb-banner-animate-center-top":"zoom-in"===y?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-fade":""}function ft(e){if(e){var t=F.split(" ");for(var n=0;n<t.length;n++)t[n]&&e.classList.remove(t[n])}}function mt(){Ke();at();pt();var e=document.getElementById("cb-initial-banner");var t=document.getElementById("cb-preferences-banner");var n=document.getElementById("cb-preferences-btn");var r=document.getElementById("cb-accept-all-btn");var a=document.getElementById("cb-reject-all-btn");var o=document.getElementById("cb-prefs-reject-btn");var c=document.getElementById("cb-cancel-prefs-btn");var s=document.getElementById("cb-save-prefs-btn");var l=document.getElementById("cb-ccpa-donotsell-link");var d="ccpa"===i;function p(){if(e){e.style.setProperty("display","none","important");e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade")}if(t){t.style.display="none";ft(t)}var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="flex");it()}function b(){if(e){if(t){t.style.display="none";ft(t)}var n=ee(e);e.style.setProperty("display","flex","important");e.style.setProperty("visibility","visible","important");e.style.setProperty("opacity","1","important");e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade","cb-banner-animate-zoom-in");u&&e.classList.add(rt(n));g&&(document.body.style.overflow="hidden")}}function f(){e.style.display="none";var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="none");t.style.display="flex";t.style.visibility="visible";t.style.opacity="1";ft(t);var r=bt();r&&t.classList.add(r)}var m=document.getElementById("cb-floating-trigger");m&&m.addEventListener("click",function(e){e&&e.preventDefault&&e.preventDefault();e&&e.stopPropagation&&e.stopPropagation();b()});n&&n.addEventListener("click",function(){if(e&&t){if(!d){var n=se()||I&&I.categories||{};var r=function(e,t){var n=document.getElementById(e);if(n){n.checked=!!t;var r=n.parentNode&&n.parentNode.querySelector("button.cb-pref-toggle-track");r&&r.setAttribute("aria-checked",n.checked?"true":"false")}};r("cb-pref-analytics",n.analytics);r("cb-pref-preferences",n.preferences);r("cb-pref-marketing",n.marketing)}e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade");f()}});o&&o.addEventListener("click",function(){var e={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!1,preferences:!1,marketing:!1}};De(["analytics","marketing","preferences"]);oe(e);le(e,{status:"rejected"});ce(e.categories);Xe(e.categories,"[PrefsReject]");We(e.categories);p()});var y=document.getElementById("cb-close-initial-btn");var v=document.getElementById("cb-close-prefs-btn");y&&y.addEventListener("click",function(){try{localStorage.setItem(L+"_closed",String(Date.now()))}catch(e){}p()});v&&v.addEventListener("click",function(){try{localStorage.setItem(L+"_closed",String(Date.now()))}catch(e){}p()});d&&l&&l.addEventListener("click",function(){e&&t&&f()});c&&c.addEventListener("click",function(){b()});a&&a.addEventListener("click",function(){if(!d){var e={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!1,preferences:!1,marketing:!1}};De(["analytics","marketing","preferences"]);oe(e);le(e,{status:"rejected"});ce(e.categories);Xe(e.categories,"[Reject]");We(e.categories)}p()});r&&r.addEventListener("click",function(){if(d){var e={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:!1}};oe(e);le(e,{status:"given"});je({analytics:!0,marketing:!0,preferences:!0,essential:!0});$e(!1)}else{var t={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!0,preferences:!0,marketing:!0}};oe(t);le(t,{status:"given"});ce(t.categories);je(t.categories);Xe(t.categories,"[Accept]")}p()});s&&s.addEventListener("click",function(){if(d){var e=document.getElementById("cb-ccpa-optout");var t=!(!e||!e.checked);var n={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:t}};oe(n);le(n,{status:t?"rejected":"given"});t||je({analytics:!0,marketing:!0,preferences:!0,essential:!0});$e(t)}else{var r=document.getElementById("cb-pref-analytics");var a=document.getElementById("cb-pref-preferences");var i=document.getElementById("cb-pref-marketing");var o={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!(!r||!r.checked),preferences:!(!a||!a.checked),marketing:!(!i||!i.checked)}};var c=[];o.categories.analytics||c.push("analytics");o.categories.marketing||c.push("marketing");o.categories.preferences||c.push("preferences");c.length&&De(c);oe(o);le(o,{status:"partial"});ce(o.categories);je(o.categories);Xe(o.categories,"[Save]");We(o.categories)}p()})}function gt(){mt();var e=document.getElementById("cb-initial-banner");if(e){e.style.display="flex";e.style.visibility="visible";e.style.opacity="1"}var t=document.getElementById("cb-floating-trigger");t&&(t.style.display="none")}function ut(){if("gdpr"===i){qe();if(!window.__cbConsentDefaultSet){xe();he()("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500});window.__cbConsentDefaultSet=!0}if(I.accepted)Xe(I.categories||{},"[Reload]");else{_e({});s&&Ye()}}else if("ccpa"===i){if(!window.__cbConsentDefaultSet){xe();he()("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500});window.__cbConsentDefaultSet=!0}s&&Ye();$e(!!(I&&I.accepted&&I.ccpa&&I.ccpa.doNotSell))}if(!window.__CB_WEBFLOW_MODE__)try{je()}catch(e){}if(window.__CB_WEBFLOW_MODE__){mt();if(I.accepted||ct()){var e=document.getElementById("cb-initial-banner");if(e){e.style.setProperty("display","none","important");e.style.setProperty("visibility","hidden","important")}var t=document.getElementById("cb-preferences-banner");t&&t.style.setProperty("display","none","important");var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="flex")}else if(o){var r=document.getElementById("cb-initial-banner");if(r){r.style.display="flex";r.style.setProperty("visibility","visible","important");r.style.setProperty("opacity","1","important")}var a=document.getElementById("cb-floating-trigger");a&&(a.style.display="none")}else{var c=document.getElementById("cb-initial-banner");if(c){c.style.setProperty("display","none","important");c.style.setProperty("visibility","hidden","important")}var l=document.getElementById("cb-floating-trigger");l&&l.style.setProperty("display","none","important")}}else if(o)if(I.accepted||ct()){mt();var d=document.getElementById("cb-floating-trigger");d&&(d.style.display="flex");var p=document.getElementById("cb-initial-banner");if(p){p.style.setProperty("display","none","important");p.style.setProperty("visibility","hidden","important")}}else gt();try{be()}catch(e){}function b(){document.addEventListener("click",function(e){var t=e.target;for(;t&&t!==document.body;){var n=t.hasAttribute&&t.hasAttribute("data-consentbit-trigger");var r=t.hasAttribute&&t.hasAttribute("data-consentbit-banner");if(n||r){e.preventDefault();e.stopPropagation();if(n)try{localStorage.removeItem(L);localStorage.removeItem(L+"_closed");I={accepted:!1,timestamp:null}}catch(e){}var a=document.getElementById("cb-initial-banner");if(a){a.style.display="flex";a.style.visibility="visible";a.style.opacity="1";g&&(document.body.style.overflow="hidden");var i=document.getElementById("cb-floating-trigger");i&&(i.style.display="none");a.scrollIntoView({behavior:"smooth",block:"start"})}else{gt();setTimeout(function(){var e=document.getElementById("cb-initial-banner");e&&e.scrollIntoView({behavior:"smooth",block:"start"})},100)}return!1}t=t.parentElement}},!0)}"loading"===document.readyState?document.addEventListener("DOMContentLoaded",b):b()}}();
`;

  const SCRIPT_VERSION = '2026-08-22-script-recreation-fixes';
  const customizationUpdatedAt = customization?.updatedAt || customization?.updated_at || '';
  const translationsSig = await (async () => {
    try {
      const tr = customization?.translations;
      if (!tr) return '';
      const s = typeof tr === 'string' ? tr : JSON.stringify(tr);
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  })();
  const etag = `"${resolvedSite.id}-${resolvedSite.updatedAt || ''}-${customizationUpdatedAt}-${translationsSig}-${SCRIPT_VERSION}"`;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }
function remToPx(rem, baseFontSize = 16) {
  return rem * baseFontSize;
}

const banerBr=remToPx(parseFloat(customization?.bannerBorderRadius) || 12);
const isGoogleAc = enTrans?.isGoogleAc === true || enTrans?.isGoogleAc === 1 || enTrans?.isGoogleAc === '1' || String(enTrans?.isGoogleAc || '').toLowerCase() === 'true';
const loaderIab=`
${inlineConfig}
${getLoaderIabScript(customization, { rawPos: customization?.position || 'bottom-left', bannerLayoutVisual: enTrans?.bannerLayoutVisual, textAlign: (typeof textAlign !== 'undefined' && (textAlign === 'center' || textAlign === 'right')) ? textAlign : 'left', bannerEntranceAnimation: siteConfigPayload?.customization?.bannerEntranceAnimation, hideBranding: siteConfigPayload?.customization?.hideBranding === true }, isGoogleAc)}
`

  const loaderCore = loader.replace(inlineConfig, '');
  const loaderWebflow = `${inlineConfig}${getWebflowSetupScript()}
` + loaderCore;

  const loaderIabCore = loaderIab.replace(inlineConfig, '');
  const loaderIabWebflow = `${inlineConfig}${getWebflowSetupScript()}
(function(){function _cbInstallTcfBridge(){if(!window.__tcfapi){setTimeout(_cbInstallTcfBridge,150);return;}try{window.__tcfapi('addEventListener',2,function(a,b){if(!b)return;if(a.eventStatus==='useractioncomplete'||a.eventStatus==='tcloaded'){var c=!!(a.purpose&&a.purpose.consents&&a.purpose.consents[1]);var d={essential:true,analytics:c,marketing:c,preferences:c};window.userConsent=d;try{document.dispatchEvent(new CustomEvent('consentUpdated',{detail:d,bubbles:true}));}catch(e){}}});}catch(e){}}_cbInstallTcfBridge();})();
` + loaderIabCore;

  const iabAllowed = effectivePlanId === 'growth' || effectivePlanId === 'essential';
  const wantsIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab';
  const rawIsWebflow = String(resolvedSite.platform || '').toLowerCase() === 'webflow';
  const isWebflowV2 = rawIsWebflow && String(resolvedSite.version || '').toLowerCase() === 'v2';
  const isWebflow = rawIsWebflow && !isWebflowV2;
  const serveKind = (wantsIab && iabAllowed && isWebflow) ? 'iabwebflow'
    : (wantsIab && iabAllowed) ? 'iab'
    : isWebflow ? 'webflow'
    : 'standard';
  const why = {
    wantsIab,
    iabAllowed,
    isWebflow,
    isWebflowV2,
    version: resolvedSite.version || null,
    plan: effectivePlanId,
    orgId: orgIdForDebug,
    subscriptionStatus: subStatusForDebug,
    siteId: resolvedSite.id,
    cdnScriptId: resolvedSite.cdnScriptId,
    bannerType: resolvedSite.banner_type,
    regionMode: resolvedSite.region_mode,
    platform: resolvedSite.platform,
    bannerEnabled,
  };
  const bannerIsCcpa = String(effectiveBannerType || '').toLowerCase() === 'ccpa';

  // Microsoft issued ConsentBit CMP ID 165. Sent as a NUMBER, not a string: the
  // integration guide writes `source: <your-cmp-id>` unquoted while quoting the
  // storage values, so JSON.stringify() below must emit 165 rather than "165".
  const clarityCmpSource = siteConfigPayload.clarityCmpId || 165;
  const clarityBootstrap = siteConfigPayload.clarityConsentMode === false ? '' :
    `try{` +
    `window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments);};` +
    `var ca=c?(e?'denied':'granted'):(d&&d.analytics?'granted':'denied');` +
    `var cm=c?(e?'denied':'granted'):(d&&d.marketing?'granted':'denied');` +
    `window.clarity('consentv2',{source:${JSON.stringify(clarityCmpSource)},ad_Storage:cm,analytics_Storage:ca});` +
    `window.__cbClaritySignal=cm+'|'+ca;` +
    `}catch(_){}`;
  const consentModeBootstrap = `(function(){try{var c=${bannerIsCcpa ? 'true' : 'false'};var d=null,e=false,hasStored=false;try{for(var i=0;i<localStorage.length;i++){var w=localStorage.key(i);if(w&&w.indexOf('consentbit_prefs_')===0){try{var x=localStorage.getItem(w);if(x){d=JSON.parse(atob(x));break;}}catch(_){}}}}catch(_){}try{for(var i=0;i<localStorage.length;i++){var w=localStorage.key(i);if(w&&w.indexOf('consentbit_')===0&&w.indexOf('consentbit_prefs_')!==0){try{var v=JSON.parse(localStorage.getItem(w));if(v&&v.accepted){hasStored=true;if(!d&&v.categories)d=v.categories;if(v.ccpa&&v.ccpa.doNotSell)e=true;break;}}catch(_){}}}}catch(_){}try{if(navigator.globalPrivacyControl===true&&c&&!hasStored){e=true;}}catch(_){}${clarityBootstrap}window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};window.gtag('set','ads_data_redaction',true);window.gtag('set','url_passthrough',true);if(!c){window.gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',functionality_storage:'denied',personalization_storage:'denied',security_storage:'granted',wait_for_update:500});if(d){window.gtag('consent','update',{analytics_storage:d.analytics?'granted':'denied',ad_storage:d.marketing?'granted':'denied',ad_user_data:d.marketing?'granted':'denied',ad_personalization:d.marketing?'granted':'denied',functionality_storage:d.preferences?'granted':'denied',personalization_storage:d.preferences?'granted':'denied'});}}else{window.gtag('consent','default',{ad_storage:e?'denied':'granted',analytics_storage:e?'denied':'granted',ad_user_data:e?'denied':'granted',ad_personalization:e?'denied':'granted',functionality_storage:e?'denied':'granted',personalization_storage:e?'denied':'granted',security_storage:'granted'});}window.__cbConsentDefaultSet=true;}catch(_){}})();\n`;

  const scriptToServe =
    (serveKind === 'iab' ? loaderIab : serveKind === 'iabwebflow' ? loaderIabWebflow : serveKind === 'webflow' ? loaderWebflow : (consentModeBootstrap + loader));


  return new Response(scriptToServe, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'ETag': etag,
      'X-ConsentBit-Loader': serveKind,
      'X-ConsentBit-Plan': String(effectivePlanId || 'free'),
      'X-ConsentBit-IabAllowed': iabAllowed ? '1' : '0',
      'X-ConsentBit-OrgId': orgIdForDebug ? String(orgIdForDebug) : 'none',
      'X-ConsentBit-Webflow': isWebflow ? '1' : '0',
    },
  });
}