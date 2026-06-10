// @ts-nocheck
// handlers/cdn.js
import { getBannerCustomization, getEffectivePlanForOrganization, getSubscriptionBySiteId, inferTierPlanIdFromStripePriceId } from '../services/db.js';
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
      'SELECT id, organizationId, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id, pendingScan, updatedAt, platform, platformSiteId FROM Site WHERE cdnScriptId = ?1'
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
        'SELECT id, organizationId, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id, pendingScan, updatedAt, platform, platformSiteId FROM Site WHERE id = ?1'
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

  // Domain validation — only serve the banner to the registered domain.
  // Checks both Origin (reliable, always sent by browsers on cross-origin requests)
  // and Referer (fallback). If either header is present and the hostname does not
  // match the registered site domain, return a no-op script so the banner never appears.
  if (resolvedSite.domain) {
    const siteHost = String(resolvedSite.domain)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();

    const origin = request.headers.get('Origin') || request.headers.get('origin') || '';
    const referer = request.headers.get('Referer') || request.headers.get('referer') || '';

    // Prefer Origin (more reliable — always sent by browsers on cross-origin loads).
    const sourceHeader = origin || referer;

    if (sourceHeader) {
      try {
        const sourceHost = new URL(sourceHeader).hostname.replace(/^www\./, '').toLowerCase();
        if (sourceHost !== siteHost) {
          // Check if the request comes from the Webflow staging domain for this site
          let stagingHost = null;
          const platformSiteId = resolvedSite.platformSiteId ?? resolvedSite.platformsiteid ?? null;
          if (platformSiteId && env.WEBFLOW_AUTHENTICATION) {
            try {
              const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(platformSiteId);
              if (kvRaw) {
                const kvData = JSON.parse(kvRaw);
                if (kvData.stagingUrl) {
                  stagingHost = new URL(kvData.stagingUrl.startsWith('http') ? kvData.stagingUrl : `https://${kvData.stagingUrl}`).hostname.replace(/^www\./, '').toLowerCase();
                }
              }
            } catch { /* ignore KV errors */ }
          }

          if ((stagingHost && sourceHost === stagingHost) || sourceHost.endsWith('.webflow.io')) {
            // Staging domain allowed — site-specific staging URL or Webflow infrastructure domain
            // console.log(`[CDN] Domain mismatch allowed: script for "${siteHost}" from "${sourceHost}" (stagingHost=${stagingHost}, isWebflowIO=${sourceHost.endsWith('.webflow.io')})`);
          } else {
            console.warn(`[CDN] Domain mismatch BLOCKED: script for "${siteHost}" from "${sourceHost}" (stagingHost=${stagingHost})`);
            return new Response('// Script not authorized for this domain', {
              status: 403,
              headers: { 'Content-Type': 'application/javascript' },
            });
          }
        }
      } catch (domainErr) {
        // Malformed Origin/Referer — fail safe and block
        console.warn('[CDN] Could not parse Origin/Referer, blocking. header="' + sourceHeader + '" err=' + domainErr?.message);
        return new Response('// Script not authorized for this domain', {
          status: 403,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    } else {
      // console.log('[CDN] No Origin/Referer header — allowing (client-side guard will enforce)');
    }
    // Neither Origin nor Referer present: could be a direct/server-side fetch.
    // Allow through — the client-side domain guard in the embedded script will
    // enforce the domain restriction in the browser.
  }

  // Auto-verify: domain validation just passed, so this is a genuine install.
  if (!resolvedSite.verified) {
    db.prepare(`UPDATE Site SET verified = 1, verified_at = datetime('now') WHERE id = ?1`)
      .bind(resolvedSite.id).run().catch(() => {});
  }

  // Check subscription status — block banner if subscription is canceled/expired
  // Also capture planId so we can gate IAB features below.
  // Prefer site-specific subscription over org-level to avoid migration-created 'basic'
  // rows for sibling sites polluting the org-level query result.
  let effectivePlanId = 'free';
  let orgIdForDebug = null;
  let subStatusForDebug = null;
  try {
    const orgId = resolvedSite.organizationId ?? resolvedSite.organizationid ?? null;
    orgIdForDebug = orgId ? String(orgId) : null;

    // 1. Try site-specific subscription first
    let subscription = await getSubscriptionBySiteId(db, resolvedSite.id);
    let resolvedPlanId = subscription ? (subscription.planId ?? subscription.planid ?? null) : null;
    if (resolvedPlanId) resolvedPlanId = String(resolvedPlanId).toLowerCase();
    if ((!resolvedPlanId || !['basic', 'essential', 'growth'].includes(resolvedPlanId)) && env && subscription) {
      const pid = subscription.stripePriceId ?? subscription.stripepriceid ?? null;
      const inferred = inferTierPlanIdFromStripePriceId(env, pid);
      if (inferred) resolvedPlanId = inferred;
    }

    // 2. Fall back to org-level if no valid site-specific subscription found
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
  } catch (subErr) {
    console.warn('[CDN] Subscription check failed:', subErr?.message);
    // Fall through — do not block banner on DB errors
  }

  // Load banner customization
  const customization = await getBannerCustomization(db, resolvedSite.id);

  // Fetch published custom cookie rules for this site (user-defined via dashboard)
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

  // Geo info from Cloudflare
  const cf = request.cf || {};
  const country = cf.country || null;          // e.g. "US"
  const isEU = cf.isEUCountry === '1';         // "1" for EU members

  const regionMode = resolvedSite.region_mode || 'gdpr';           // 'gdpr' | 'ccpa' | 'both'
  let effectiveBannerType = resolvedSite.banner_type || 'gdpr';    // base type
  // When false, the embed script skips the consent banner entirely (but still injects floating button)
  let bannerEnabled = true;

  // IAB/TCF banner overrides all geo-based routing — show to everyone when enabled.
  const siteWantsIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab';

  // Decide which banner to show (or none) based on visitor location:
  // IAB takes priority: skip geo routing so US visitors still see the IAB/TCF banner.
  if (!siteWantsIab) {
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
    } else if (effectiveBannerType === 'ccpa') {
      // banner_type is CCPA but region_mode was not explicitly set to 'ccpa'.
      // CCPA is a US-only law — still restrict to US visitors by default.
      if (country !== 'US') {
        bannerEnabled = false;
      }
    }
  }
  // regionMode === 'gdpr': show GDPR banner everywhere (default, no change needed)

  // Generate custom CSS styles from customization
  let customStyles = null;
  /** Passed to embed config for scripts that branch on initial banner shape. */
  let bannerLayoutVisualForConfig = 'box';
  // Map full language names to ISO codes
  const LANG_NAME_TO_CODE = {
    English: 'en', Spanish: 'es', French: 'fr', German: 'de',
    Italian: 'it', Polish: 'pl', Portuguese: 'pt', Swedish: 'sv', Dutch: 'nl'
  };
  function normalizeLangCode(raw) {
    if (!raw) return 'en';
    const s = String(raw).trim();
    return LANG_NAME_TO_CODE[s] || (s.length <= 3 ? s.toLowerCase() : 'en');
  }

  // Section labels per language — used to fill in missing labels for existing published data
  // that was saved before buildCustomizationPayload started writing them to translations.en
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

  // Declared here so siteConfigPayload can reference it even when customization is null
  let enTrans = {};
  if (customization) {
    // Normalize DB/API values (case, legacy "Right", underscores) so corner CSS matches dashboard.
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
    // Cap border radius at 25px to prevent over-rounding.
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

    /** Typography — read from translations.config (Option 2) with translations.en as backward-compat fallback. */
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
    // Fill in missing section labels using languageSelected from enTrans (or DB language as fallback)
    const _langCode = enTrans.languageSelected || normalizeLangCode(customization.language);
    const _labels = SECTION_LABELS[_langCode] || SECTION_LABELS['en'];
    enTrans.essential = _labels.essential;
    enTrans.strictlyNecessary = '';
    if (!enTrans.analytics)           enTrans.analytics           = _labels.analytics;
    if (!enTrans.marketing)           enTrans.marketing           = _labels.marketing;
    if (!enTrans.preferences)         enTrans.preferences         = _labels.preferences;
    if (!enTrans.cookiePreferences)   enTrans.cookiePreferences   = 'Cookie Preferences';


    /** box = corner card; banner = full-width bottom bar; bottom-center = centered full-width bottom bar; popup (legacy) = treated as bottom-center. */
    var layoutVisual = 'box';
    try {
      var _lvSrc = configTrans.bannerLayoutVisual != null ? configTrans.bannerLayoutVisual : enTrans.bannerLayoutVisual;
      var lvRaw = _lvSrc != null ? String(_lvSrc).toLowerCase() : 'box';
      if (lvRaw === 'banner' || lvRaw === 'fullwidth') layoutVisual = 'banner';
      else if (lvRaw === 'bottom-center' || lvRaw === 'centeralign' || lvRaw === 'popup') layoutVisual = 'bottom-center';
    } catch (eLayout) {}
    bannerLayoutVisualForConfig = layoutVisual;

    var fontName = (configTrans.bannerFontFamily != null ? configTrans.bannerFontFamily : enTrans.bannerFontFamily) || '';
    var fontWeightStr = String((configTrans.bannerFontWeight != null ? configTrans.bannerFontWeight : enTrans.bannerFontWeight) || '600');
    var textAlign = (configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : enTrans.bannerTextAlign) || 'left';
    if (textAlign !== 'center' && textAlign !== 'right') {
      textAlign = 'left';
    }
    var footerJustify = textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start';
    // Full-width banner: left text → buttons right, center → center, right → right
    var bannerFooterJustify = textAlign === 'center' ? 'center' : 'flex-end';
    var closeButtonEnabled = ((configTrans.closeButtonEnabled != null ? configTrans.closeButtonEnabled : enTrans.closeButtonEnabled) === '1');
    var boxPadding = closeButtonEnabled ? '28px 20px 20px 20px' : '20px';
    var _fontName = (fontName && String(fontName).length) ? String(fontName).replace(/'/g, '') : 'Inter';
    var fontFamilyCss = "'" + _fontName + "',ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

    var positionStyles = '';
    // Three-tier banner width:
    //  1. Default (short content, normal weight) → 480px
    //  2. Max content (long description > 120 chars, normal weight) → 560px
    //  3. Max content + Extra Bold / Black (800/900) → 640px
    var isBoldHeavy = fontWeightStr === '800' || fontWeightStr === '900';
    var descLen = String((enTrans && enTrans.description) || '').length;
    var maxBtnLen = Math.max(
      String((enTrans && enTrans.acceptAll) || '').length,
      String((enTrans && enTrans.rejectAll) || '').length,
      String((enTrans && enTrans.customise) || '').length
    );
    // Calculate width needed for 3 equal-width buttons in one row (flex:1 1 0)
    // Each button: ~8px per char + 56px padding; 3 buttons + 32px total gap + 32px panel padding
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

    // CCPA initial banner: wider + taller than default box
    if (effectiveBannerType === 'ccpa' && layoutVisual !== 'banner') {
      var ccpaWidthPx = Math.max(baseWidthPx, 600);
      initialSize = 'width:' + ccpaWidthPx + 'px!important;min-width:360px;max-width:min(' + ccpaWidthPx + 'px,96vw)!important;max-height:min(80vh,660px);overflow:hidden;';
    }

    customStyles =
      ".cb-banner{border:none !important;}" +
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
        "font-weight:600;" +
        "font-family:inherit;" +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      /* Explicit overrides for both banners — higher specificity to beat static base rules. */
      "#cb-initial-banner.cb-banner h3," +
      "#cb-preferences-banner.cb-banner h3{" +
        "font-weight:600!important;" +
        "font-family:inherit!important;" +
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
      /* Static base uses `#cb-initial-banner… .cb-banner-body > p` — must match dashboard text color + alignment. */
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
      /* Initial banner actions — nowrap keeps all buttons in one row regardless of text length */
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
        ? /* Column layout: heading, text, buttons all share same container — alignment works via text-align + justify-content */
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
          /* Mobile: stretch edge-to-edge */
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
      /* Cookie category accordion — match banner background (rows sit on same surface as prefs panel). */
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
      /* Mobile overrides — must come LAST so they win over the desktop !important rules above */
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

  // Apply essential/strictlyNecessary overrides to TRANSLATIONS so the browser receives correct labels.
  // Use languageSelected from within translations.en (the actual language code) — not the key name 'en',
  // which is always 'en' regardless of the selected language.
  if (translationsForScript && translationsForScript.en) {
    const _enT = translationsForScript.en;
    const _lc = _enT.languageSelected || 'en';
    const _lb = SECTION_LABELS[_lc] || SECTION_LABELS['en'];
    _enT.essential = (_lb && _lb.essential) ? _lb.essential : 'Strictly Necessary';
    _enT.strictlyNecessary = '';
  }

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
            // Priority: translations.config → centerAnimationDirection (direct column) → translations.en → default
            const raw = (configTrans.bannerEntranceAnimation != null && configTrans.bannerEntranceAnimation !== '')
              ? configTrans.bannerEntranceAnimation
              : (customization.centerAnimationDirection != null && customization.centerAnimationDirection !== '')
                ? customization.centerAnimationDirection
                : (enTrans && enTrans.bannerEntranceAnimation) || 'fade-in';
            const v = String(raw || 'fade-in');
            // Normalize legacy values: 'fade' → 'fade-in', 'zoom' → 'zoom-in'
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
        }
      : null,
    floatingLogoUrl: resolveFloatingLogoUrl(),
    floatingLogoFallbackUrl: resolveWorkerFloatingLogoUrl(),
    /** CookieYes-style URL → category rules (serialized into embed). */
    scriptBlockProviders: SCRIPT_BLOCK_PROVIDERS,
    /** User-defined cookie rules published from the dashboard — used for runtime script blocking. */
    customCookieRules: customCookieRules,
    /** When true, the next page load triggers a full browser-based cookie + script scan. */
    pendingScan: resolvedSite.pendingScan === 1,
    /** Registered domain — used by the embed script to validate it is running on the correct site. */
    registeredDomain: resolvedSite.domain
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
! function () {
  var e = window.__CONSENT_SITE__ || {};
  var t = !0;
  ! function () {
    var n = e.registeredDomain;
    if (n) try {
      var a = window.location.hostname.replace(/^www\./, "").toLowerCase();
      if (a !== n && e.platform !== 'webflow' && !a.endsWith('.webflow.io')) {
        window.__CONSENT_SITE__ = null;
        t = !1
      }
    } catch (e) {}
  }();
  if (t) {
    var n = e.floatingLogoUrl || "";
    var a = e.floatingLogoFallbackUrl || "";
    var r = e.id || null;
    var i = e.bannerType || "gdpr";
    var o = !1 !== e.bannerEnabled;
    var c = e.apiBase;
    var s = e.gaId || null;
    var l = e.customization || null;
    var d = !0 === e.pendingScan;
    var p = l && l.bannerLayoutVisual || "box";
    var b = l ? l.privacyPolicyUrl : null;
    var f = !!l && l.stopScroll;
    var m = !l || !1 !== l.animationEnabled;
    var u = l && l.bannerEntranceAnimation || "fade-in";
    var g = l && l.preferencePosition || "center";
    var v = l && l.centerAnimationDirection || "fade";
    var y = l && l.language || "en";
    var h = !!l && !0 === l.autoDetectLanguage;
    ${translationsVar}
    var x = ["customise", "rejectAll", "acceptAll", "save", "back", "doNotSell", "saveMyPreferences", "confirmChoice", "cancel", "optOutPreference"];
    var w = 30,
      k = 320,
      C = 20,
      E = 30,
      S = 200;
    var _ = 56;
    var I = "consentbit_" + r;
    var O = void 0 !== l && l && null != l.cookieExpirationDays ? Math.max(1, Math.min(365, Number(l.cookieExpirationDays) || 30)) : 30;
    var A = ee();
    var B = "consentbit_prefs_" + (r || "");
    var L = "cb_pv_over_limit_" + (r || "");
    var T = [];
    var z = !1;
    var N = null;
    var j = e.scriptBlockProviders || [];
    var P = e.customCookieRules || [];
    var F = [{
      domain: "facebook.com",
      category: "marketing"
    }, {
      domain: "facebook.net",
      category: "marketing"
    }, {
      domain: "adroll.com",
      category: "marketing"
    }, {
      domain: "doubleclick.net",
      category: "marketing"
    }, {
      domain: "googleadservices.com",
      category: "marketing"
    }, {
      domain: "bing.com",
      category: "marketing"
    }, {
      domain: "bat.bing.com",
      category: "marketing"
    }, {
      domain: "twitter.com",
      category: "marketing"
    }, {
      domain: "analytics.twitter.com",
      category: "marketing"
    }, {
      domain: "t.co",
      category: "marketing"
    }, {
      domain: "linkedin.com",
      category: "marketing"
    }, {
      domain: "ads.linkedin.com",
      category: "marketing"
    }, {
      domain: "pinterest.com",
      category: "marketing"
    }, {
      domain: "ct.pinterest.com",
      category: "marketing"
    }, {
      domain: "tiktok.com",
      category: "marketing"
    }, {
      domain: "analytics.tiktok.com",
      category: "marketing"
    }, {
      domain: "hotjar.com",
      category: "analytics"
    }, {
      domain: "clarity.ms",
      category: "analytics"
    }, {
      domain: "scorecardresearch.com",
      category: "analytics"
    }, {
      domain: "outbrain.com",
      category: "marketing"
    }, {
      domain: "taboola.com",
      category: "marketing"
    }, {
      domain: "criteo.com",
      category: "marketing"
    }, {
      domain: "criteo.net",
      category: "marketing"
    }, {
      domain: "quantserve.com",
      category: "analytics"
    }, {
      domain: "zemanta.com",
      category: "marketing"
    }];
    var D = ".cb-banner,.cb-banner *{box-sizing:border-box;}#cb-initial-banner.cb-banner{width:440px;min-width:280px;max-width:min(440px,92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;bottom:32px;left:32px;right:auto;padding:16px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:inline-flex;flex-direction:column;align-items:stretch;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-initial-banner.cb-banner .cb-banner-body{flex:0 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner{width:540px;max-width:92vw;max-height:min(85vh,580px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:flex;flex-direction:column;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-preferences-banner.cb-banner .cb-banner-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner.prefs-left{left:32px;right:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-right{right:32px;left:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-center{left:50%;top:50%;transform:translate(-50%,-50%);}.cb-banner-body{overflow-y:auto;overflow-x:hidden;margin-bottom:12px;}.cb-banner h3{margin:0 0 8px;font-size:16px!important;line-height:1.4!important;font-weight:600;color:#0f172a;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}#cb-initial-banner.cb-banner h3{font-size:16px!important;font-weight:600;color:rgba(0,0,0,0.8);padding-right:36px;}#cb-initial-banner.cb-banner .cb-banner-body > p{color:rgba(0,0,0,0.8);}.cb-gdpr-accordion{margin-top:4px;margin-bottom:4px;}.cb-gdpr-cat-label{color:#0f172a;}.cb-gdpr-cat-desc{color:#64748b;}.cb-banner p{margin:0 0 12px;font-size:14px!important;line-height:1.5!important;color:#334155;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}.cb-banner-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;align-items:center;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex:0 0 auto;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}" + (l && "banner" === l.bannerLayoutVisual ? "#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}" : "") + ".cb-banner button{padding:12px 32px;border-radius:0.375rem;cursor:pointer;font-size:14px;font-weight:600;border:1px solid #e2e8f0;transition:opacity 0.2s;white-space:normal;word-break:break-word;min-width:0;text-align:center;}@media (max-width:660px){#cb-initial-banner.cb-banner{width:100vw!important;max-width:100vw!important;left:0!important;right:0!important;bottom:0!important;transform:none!important;border-radius:0!important;border-left:none!important;border-right:none!important;border-bottom:none!important;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-initial-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}#cb-preferences-banner.cb-banner{width:calc(100vw - 32px)!important;max-width:calc(100vw - 32px)!important;padding:20px!important;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-preferences-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}}@media (max-width:350px){#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{font-size:12px!important;}#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-size:13px!important;}#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,.cb-gdpr-cat-desc{font-size:12px!important;}#cb-initial-banner.cb-banner .cb-banner-footer button,#cb-preferences-banner.cb-banner .cb-banner-footer button{font-size:12px!important;padding:10px 16px!important;}}.cb-banner button:hover:not(.cb-pref-toggle-track){opacity:0.8;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{display:block !important;width:40px !important;min-width:40px !important;height:22px !important;padding:0 !important;margin:0 !important;border:none !important;border-radius:11px !important;background:#d1d5db !important;box-shadow:none !important;flex-shrink:0 !important;position:relative !important;overflow:visible !important;box-sizing:border-box !important;cursor:pointer !important;appearance:none !important;-webkit-appearance:none !important;font-size:0 !important;line-height:0 !important;opacity:1 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{background:#22c55e !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{content:'' !important;position:absolute !important;top:2px !important;left:2px !important;width:18px !important;height:18px !important;border-radius:50% !important;background:#ffffff !important;box-shadow:0 1px 3px rgba(0,0,0,.2) !important;pointer-events:none !important;transition:left .15s ease !important;z-index:2 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{left:20px !important;}.cb-banner button#cb-accept-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-reject-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-preferences-btn,.cb-banner button#cb-ccpa-donotsell-link{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner button#cb-prefs-reject-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner label{display:block;margin-bottom:6px;font-size:11px;}.cb-banner input[type='checkbox']{margin-right:6px;}.cb-banner a{color:#007aff;text-decoration:underline;font-size:inherit;}@keyframes slideInFromLeft{from{transform:translateX(-100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromRight{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromTop{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes slideInFromBottom{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}@keyframes prefsSlideInFromLeft{from{transform:translate(-120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideInFromRight{from{transform:translate(120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideCenterFromBottom{from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes prefsSlideCenterFromTop{from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes zoomIn{from{transform:scale(0.85);opacity:0;}to{transform:scale(1);opacity:1;}}@keyframes cbInitialCenterSlideFromBottom{from{transform:translate(-50%,100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterSlideFromTop{from{transform:translate(-50%,-100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterZoomIn{from{transform:translateX(-50%) scale(0.85);opacity:0;}to{transform:translateX(-50%) scale(1);opacity:1;}}.cb-banner-animate-initial-center-bottom{animation:cbInitialCenterSlideFromBottom 0.35s ease-out;}.cb-banner-animate-initial-center-top{animation:cbInitialCenterSlideFromTop 0.35s ease-out;}.cb-banner-animate-initial-center-zoom{animation:cbInitialCenterZoomIn 0.3s ease-out;}@keyframes prefsZoomIn{from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}to{transform:translate(-50%,-50%) scale(1);opacity:1;}}.cb-banner-animate-left{animation:slideInFromLeft 0.4s ease-out;}.cb-banner-animate-right{animation:slideInFromRight 0.4s ease-out;}.cb-banner-animate-top{animation:slideInFromTop 0.4s ease-out;}.cb-banner-animate-bottom{animation:slideInFromBottom 0.4s ease-out;}.cb-banner-animate-fade{animation:fadeIn 0.3s ease-out;}.cb-banner-animate-prefs-left{animation:prefsSlideInFromLeft 0.4s ease-out;}.cb-banner-animate-prefs-right{animation:prefsSlideInFromRight 0.4s ease-out;}.cb-banner-animate-center-top{animation:prefsSlideCenterFromTop 0.35s ease-out;}.cb-banner-animate-center-bottom{animation:prefsSlideCenterFromBottom 0.35s ease-out;}.cb-banner-animate-zoom-in{animation:zoomIn 0.3s ease-out;}.cb-banner-animate-prefs-zoom-in{animation:prefsZoomIn 0.3s ease-out;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}#cb-initial-banner.cb-banner .cb-banner-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex-shrink:0;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}#cb-initial-banner.cb-banner #cb-preferences-btn{background:#ffffff!important;color:#334155!important;border:1px solid #334155!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-initial-banner.cb-banner #cb-reject-all-btn,#cb-initial-banner.cb-banner #cb-accept-all-btn{background:#007aff!important;color:#ffffff!important;border-color:#007aff!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-floating-trigger{position:fixed;z-index:2147483646!important;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;}#cb-floating-trigger img,#cb-floating-trigger svg{display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;}";
    e.styles && (D = D + "\\n" + e.styles);
    var M = "cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in";
    Oe();
    "complete" === document.readyState || "interactive" === document.readyState ? He() : window.addEventListener("DOMContentLoaded", He)
  }

  function R() {
    if (h) {
      var e = (navigator.language || navigator.userLanguage || "en").split("-")[0].toLowerCase();
      return TRANSLATIONS[e] ? e : "en"
    }
    return y
  }

  function U(e) {
    var t = R();
    var n = TRANSLATIONS[t] || TRANSLATIONS.en;
    var a = null != n[e] ? n[e] : null != TRANSLATIONS.en[e] ? TRANSLATIONS.en[e] : "";
    return "" === a && "title" === e ? "We value your privacy" : "" === a && "description" === e ? "We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you." : a
  }

  function W(e) {
    var t = R();
    var n;
    var a = (TRANSLATIONS[t] || TRANSLATIONS.en)[e];
    a && a.length > 80 && (a = TRANSLATIONS.en[e] || e);
    return a || TRANSLATIONS.en[e] || e
  }

  function J(e, t) {
    var n = null == e ? "" : String(e);
    return n.length > t ? n.slice(0, t) : n
  }

  function Y(e, t) {
    return J(U(e), t)
  }

  function X() {
    try {
      var e = R();
      var cf = TRANSLATIONS.config || {};
      var n = cf.cookiePolicyLinkEnabled != null ? cf.cookiePolicyLinkEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).cookiePolicyLinkEnabled;
      return !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function q() {
    try {
      var e = R();
      var cf = TRANSLATIONS.config || {};
      var n = cf.closeButtonEnabled != null ? cf.closeButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).closeButtonEnabled;
      return !0 === n || 1 === n || !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function qR() {
    try {
      var e = R();
      var cf = TRANSLATIONS.config || {};
      var n = cf.rejectButtonEnabled != null ? cf.rejectButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).rejectButtonEnabled;
      return !0 === n || 1 === n || !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function qC() {
    try {
      var e = R();
      var cf = TRANSLATIONS.config || {};
      var n = cf.customizeButtonEnabled != null ? cf.customizeButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).customizeButtonEnabled;
      return !0 === n || 1 === n || !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function H(e) {
    var t = String(e || "bottom-left").trim().toLowerCase().replace(/_/g, "-");
    return "bottom-right" === t || "right" === t ? "bottom-right" : "bottom" === t || "bottom-center" === t ? "bottom" : "bottom-left"
  }

  function V(e) {
    if (e) {
      e.style.marginLeft = "";
      e.style.marginRight = "";
      e.style.paddingLeft = "";
      e.style.paddingRight = "";
      if (De()) {
        var t = p || "box";
        var n = H(l && l.position);
        var a = Me();
        var r = "56px";
        "banner" !== t ? "left" === a ? "bottom-center" !== t && "popup" !== t && "bottom" !== n || (e.style.marginLeft = r) : "bottom-center" !== t && "popup" !== t && "bottom" !== n || (e.style.marginRight = r) : "left" === a ? e.style.paddingLeft = r : e.style.paddingRight = r
      }
    }
  }

  function Z(e) {
    if (!e) return !1;
    var t = p || "box";
    var n = H(l && l.position);
    e.style.left = "";
    e.style.right = "";
    e.style.top = "";
    e.style.bottom = "";
    e.style.transform = "";
    e.style.width = "";
    e.style.maxWidth = "";
    e.style.marginLeft = "";
    e.style.marginRight = "";
    e.style.paddingLeft = "";
    e.style.paddingRight = "";
    if ("banner" === t) {
      e.style.left = "0";
      e.style.right = "0";
      e.style.bottom = "0";
      e.style.transform = "none";
      e.style.width = "100%";
      e.style.maxWidth = "none";
      e.setAttribute("data-cb-initial-centered", "0");
      V(e);
      return !1
    }
    if (window.innerWidth <= 660) {
      e.style.setProperty("left", "0", "important");
      e.style.setProperty("right", "0", "important");
      e.style.setProperty("bottom", "0", "important");
      e.style.setProperty("transform", "none", "important");
      e.style.setProperty("width", "100vw", "important");
      e.style.setProperty("max-width", "100vw", "important");
      e.style.setProperty("min-width", "0", "important");
      e.style.setProperty("border-radius", "0", "important");
      e.style.setProperty("border-left", "none", "important");
      e.style.setProperty("border-right", "none", "important");
      e.style.setProperty("border-bottom", "none", "important");
      e.setAttribute("data-cb-initial-centered", "0");
      return !1
    }
    if ("bottom-center" === t || "popup" === t || "bottom" === n) {
      e.style.bottom = "32px";
      e.style.left = "50%";
      e.style.transform = "translateX(-50%)";
      e.setAttribute("data-cb-initial-centered", "1");
      V(e);
      return !0
    }
    e.style.bottom = "32px";
    "bottom-right" === n ? e.style.right = "32px" : e.style.left = "32px";
    e.style.transform = "none";
    e.setAttribute("data-cb-initial-centered", "0");
    V(e);
    return !1
  }

  function $(e) {
    var t = e;
    var n = t.indexOf("#");
    n >= 0 && (t = t.slice(0, n));
    (n = t.indexOf("?")) >= 0 && (t = t.slice(0, n));
    (n = t.indexOf("/")) >= 0 && (t = t.slice(0, n));
    return t.trim()
  }

  function G(e) {
    var t = e.lastIndexOf(".");
    if (t < 0) return !1;
    var n = e.slice(t).toLowerCase();
    return ".js" === n || ".mjs" === n || ".css" === n || ".png" === n || ".jpg" === n || ".jpeg" === n || ".gif" === n || ".svg" === n || ".webp" === n || ".pdf" === n || ".json" === n || ".xml" === n || ".ico" === n || ".woff" === n || ".woff2" === n
  }

  function K(e) {
    if (!e || "string" != typeof e) return "";
    var t = e.trim();
    if (!t) return "";
    var n = t.toLowerCase();
    if (0 === n.indexOf("mailto:") || 0 === n.indexOf("tel:")) return t;
    if (0 === n.indexOf("http://") || 0 === n.indexOf("https://")) return t;
    if (0 === t.indexOf("//")) return "https:" + t;
    if ("/" === t.charAt(0) || 0 === t.indexOf("./") || 0 === t.indexOf("../")) {
      try {
        if ("undefined" != typeof window && window.location) return new URL(t, window.location.href).href
      } catch (e) {}
      return t
    }
    var a = $(t);
    if (a.indexOf(".") > 0 && !G(a)) {
      for (; t.length > 0 && "/" === t.charAt(0);) t = t.slice(1);
      return "https://" + t
    }
    try {
      if ("undefined" != typeof window && window.location) return new URL(t, window.location.href).href
    } catch (e) {}
    return t
  }

  function Q(e, t) {
    var n = K(t);
    if (n) {
      e.href = n;
      e.target = "_blank";
      e.rel = "noopener noreferrer";
      e.addEventListener("click", function (e) {
        e.stopPropagation && e.stopPropagation();
        e.preventDefault && e.preventDefault();
        try {
          window.open(n, "_blank", "noopener,noreferrer")
        } catch (e) {}
      }, !0)
    }
  }

  function ee() {
    try {
      var e = localStorage.getItem(I);
      var t = e ? JSON.parse(e) : {
        accepted: !1,
        timestamp: null
      };
      if (!t || !t.accepted) return t || {
        accepted: !1,
        timestamp: null
      };
      var n = Date.now();
      var a = 24 * O * 60 * 60 * 1e3;
      var r = t.expiresAt ? new Date(t.expiresAt).getTime() : t.timestamp ? new Date(t.timestamp).getTime() + a : 0;
      return r > 0 && n > r ? {
        accepted: !1,
        timestamp: null
      } : t
    } catch (e) {
      return {
        accepted: !1,
        timestamp: null
      }
    }
  }

  function te(e) {
    try {
      var t = 24 * O * 60 * 60 * 1e3;
      e.expiresAt = e.expiresAt || new Date(Date.now() + t).toISOString();
      localStorage.setItem(I, JSON.stringify(e))
    } catch (e) {
    }
    A = e;
    try {
      ke()
    } catch (e) {
    }
  }

  function ne(e) {
    try {
      var t = {
        analytics: !!e.analytics,
        preferences: !!e.preferences,
        marketing: !!e.marketing
      };
      var n = btoa(JSON.stringify(t));
      localStorage.setItem(B, n)
    } catch (e) {
    }
  }

  function ae() {
    try {
      var e = localStorage.getItem(B);
      if (!e) return null;
      var t = JSON.parse(atob(e));
      return t && "object" == typeof t ? {
        analytics: !!t.analytics,
        preferences: !!t.preferences,
        marketing: !!t.marketing
      } : null
    } catch (e) {
      return null
    }
  }

  function re(e, t) {
    if (r && c) {
      t = t || {};
      var n = e && e.expiresAt || t.expiresAt || new Date(Date.now() + 24 * O * 60 * 60 * 1e3).toISOString();
      var a = {
        siteId: r,
        regulation: "gdpr" === i ? "gdpr" : "ccpa",
        bannerType: i,
        consentMethod: t.consentMethod || "banner",
        status: t.status || "given",
        expiresAt: n,
        consent: e
      };
      try {
        fetch(c + "/api/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(a)
        }).catch(function (e) {
        })
      } catch (e) {
      }
    }
  }

  function ie() {
    try {
      var e = localStorage.getItem(L);
      if (!e) return !1;
      var t = JSON.parse(e);
      var n = new Date;
      var a = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
      return t.yearMonth === a && !0 === t.overLimit
    } catch (e) {
      return !1
    }
  }

  function oe(e) {
    try {
      localStorage.setItem(L, JSON.stringify({
        overLimit: !0,
        yearMonth: e
      }))
    } catch (e) {}
  }

  function ce() {
    if (r && c && !ie()) try {
      var e = {
        siteId: r,
        pageUrl: "undefined" != typeof window && window.location ? window.location.href : null
      };
      fetch(c + "/api/pageview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(e),
        keepalive: !0
      }).then(function (e) {
        return e.json()
      }).then(function (e) {
        if (e && e.overLimit) {
          var t = new Date;
          var n;
          oe(e.yearMonth || t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"))
        }
      }).catch(function (e) {
      })
    } catch (e) {
    }
  }

  function se() {
    try {
      var e = "undefined" != typeof document && document.cookie ? document.cookie : "";
      return e ? e.split(";").map(function (e) {
        return e.trim()
      }).filter(Boolean) : []
    } catch (e) {
      return []
    }
  }

  function le() {
    try {
      var e = [];
      var t = document.getElementsByTagName("script");
      for (var n = 0; n < t.length; n++) {
        var a = t[n].src;
        a && -1 === a.indexOf("consentbit") && -1 === a.indexOf("client_data") && e.push(a)
      }
      return e
    } catch (e) {
      return []
    }
  }

  function de(e) {
    try {
      var t;
      var n = new URL(e).hostname;
      return -1 !== n.indexOf("google-analytics.com") || -1 !== e.indexOf("gtag/js") || -1 !== n.indexOf("googletagmanager.com") ? "analytics" : -1 !== n.indexOf("facebook.com") || -1 !== n.indexOf("fbcdn.net") || -1 !== n.indexOf("doubleclick.net") || 0 === n.indexOf("ads.") ? "marketing" : -1 !== n.indexOf("hotjar.com") || -1 !== n.indexOf("intercom.io") || -1 !== n.indexOf("fullstory.com") ? "behavioral" : "uncategorized"
    } catch (e) {
      return "uncategorized"
    }
  }

  function pe() {
    var e = {};
    var t = [];
    var n = document.scripts;
    for (var a = 0; a < n.length; a++) {
      var r = n[a];
      if (r.src && !e[r.src]) {
        e[r.src] = !0;
        t.push(r)
      }
    }
    return t
  }

  function be() {
    var e = document.scripts;
    for (var t = 0; t < e.length; t++) {
      var n = e[t];
      var a = n.src || n.getAttribute("data-cb-blocked-src") || "";
      if (-1 !== a.indexOf("googletagmanager.com/gtag/js") || -1 !== a.indexOf("googletagmanager.com/gtm.js") || -1 !== a.indexOf("google-analytics.com")) return !0
    }
    return !1
  }

  function fe(e) {
    return "analytics" === e || "marketing" === e || "behavioral" === e || "advertisement" === e || "functional" === e || "performance" === e
  }

  function me(e) {
    if (!e || "string" != typeof e) return !1;
    var t = e.toLowerCase();
    return -1 !== t.indexOf("googletagmanager.com/gtag/js") || -1 !== t.indexOf("googletagmanager.com/gtm.js") || -1 !== t.indexOf("google-analytics.com")
  }

  function ue(e) {
    var t = e;
    "behavioral" === t && (t = "analytics");
    if ("essential" === t) return !0;
    if ("ccpa" === i) {
      return !(A && A.accepted && A.ccpa && A.ccpa.doNotSell && fe(t));
      var n
    }
    if (!A || !A.accepted) return !1;
    var a = A.categories || {};
    return "analytics" === t ? !!a.analytics : "marketing" === t || "advertisement" === t ? !!a.marketing : "preferences" !== t && "functional" !== t && "performance" !== t || !!a.preferences
  }

  function ge(e) {
    if (!e) return null;
    var t = String(e).toLowerCase().trim();
    if ("analytics" === t || "marketing" === t || "behavioral" === t || "preferences" === t || "essential" === t) return ["essential" === t ? "essential" : t];
    var n = t;
    return n.indexOf("necessary") >= 0 || n.indexOf("essential") >= 0 ? ["essential"] : n.indexOf("functional") >= 0 || n.indexOf("preference") >= 0 ? ["preferences"] : n.indexOf("analytics") >= 0 || n.indexOf("performance") >= 0 || n.indexOf("statistics") >= 0 ? ["analytics"] : n.indexOf("advertisement") >= 0 || n.indexOf("marketing") >= 0 || n.indexOf("ads") >= 0 || n.indexOf("social") >= 0 ? ["marketing"] : n.indexOf("other") >= 0 ? ["analytics"] : null
  }

  function ve(e, t) {
    if (t && t.getAttribute) {
      var n = ge(t.getAttribute("data-consentbit"));
      if (n) return n;
      var a = t.getAttribute("data-consentbit-category");
      if (a) {
        var r = String(a).toLowerCase().trim();
        if ("analytics" === r || "marketing" === r || "behavioral" === r || "preferences" === r || "essential" === r) return [r]
      }
      var i = ge(t.getAttribute("data-cookieyes"));
      if (i) return i
    }
    if (e && j.length)
      for (var o = 0; o < j.length; o++) {
        var c = j[o];
        if (c && c.pattern) try {
          if (new RegExp(c.pattern, "i").test(e)) return c.categories && c.categories.length ? c.categories.slice() : ["analytics"]
        } catch (e) {}
      }
    if (e && P.length)
      for (var s = 0; s < P.length; s++) {
        var l = P[s];
        if (l && l.scriptUrlPattern) try {
          if (new RegExp(l.scriptUrlPattern, "i").test(e)) return [l.category || "uncategorized"]
        } catch (e) {}
      }
    return []
  }

  function ye(e, t) {
    if (z) return !1;
    if (!e || "string" != typeof e) return !1;
    var n = e.toLowerCase();
    if (-1 !== n.indexOf("consentbit") || -1 !== n.indexOf("client_data")) return !1;
    var a = ve(e, t);
    if (!a || 0 === a.length) return !1;
    if ("ccpa" === i) return !!(A && A.accepted && A.ccpa && A.ccpa.doNotSell);
    for (var r = 0; r < a.length; r++) {
      var o = a[r];
      if (fe(o) && !("analytics" === o && me(e) || ue(o))) return !0
    }
    return !1
  }

  function Di(content) {
    if (!content || typeof content !== "string") return null;
    if (content.indexOf("fbq(") >= 0 || content.indexOf("fbq (") >= 0 || content.indexOf("connect.facebook.net") >= 0) return "marketing";
    if (content.indexOf("ttq(") >= 0 || content.indexOf("ttq (") >= 0 || content.indexOf("analytics.tiktok.com") >= 0) return "marketing";
    if (content.indexOf("pintrk(") >= 0 || content.indexOf("pintrk (") >= 0 || content.indexOf("ct.pinterest.com") >= 0) return "marketing";
    if (content.indexOf("twq(") >= 0 || content.indexOf("twq (") >= 0 || content.indexOf("ads-twitter.com") >= 0) return "marketing";
    if (content.indexOf("_linkedin_partner_id") >= 0 || content.indexOf("lintrk(") >= 0 || content.indexOf("lintrk (") >= 0) return "marketing";
    if (content.indexOf("bat.bing.com") >= 0) return "marketing";
    if (content.indexOf("hotjar.com") >= 0) return "analytics";
    if (content.indexOf("window.clarity") >= 0) return "analytics";
    return null;
  }

  function he(e) {
    if (e && "SCRIPT" === e.nodeName && (!e.getAttribute || "javascript/blocked" !== e.getAttribute("type"))) {
      var t = e.getAttribute && e.getAttribute("src") || e.src || "";
      if (t) {
        var n = ve(t, e);
        var a = n.length > 0 ? n[0] : "uncategorized";
        if (ye(t, e)) try {
          e.setAttribute("data-cb-blocked-src", t);
          e.setAttribute("type", "javascript/blocked");
          e.removeAttribute("src")
        } catch (e) {}
      } else {
        var ic = (e.getAttribute && e.getAttribute("data-consentbit-category")) || Di(e.textContent || "");
        if (ic && !ue(ic)) try {
          e.__ci = e.textContent || "";
          var tc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
          tc && tc.set ? tc.set.call(e, "") : (e.textContent = "");
          e.setAttribute("type", "javascript/blocked");
          e.setAttribute("data-cb-inline", "1");
        } catch(ex) {}
      }
    }
  }

  function xe(e) {
    if (e && !e.__cp) {
      e.__cp = !0;
      try {
        Object.defineProperty(e, "src", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            return e.getAttribute("src") || ""
          },
          set: function (t) {
            var n = ve(t, e);
            var a = n.length > 0 ? n[0] : "uncategorized";
            if (ye(t, e)) {
              e.setAttribute("data-cb-blocked-src", t);
              e.setAttribute("type", "javascript/blocked");
              e.removeAttribute("src")
            } else e.setAttribute("src", t)
          }
        })
      } catch (e) {}
      try {
        Object.defineProperty(e, "type", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            return e.getAttribute("type") || ""
          },
          set: function (t) {
            var n = t;
            ye(e.getAttribute("src") || e.src || "", e) && (n = "javascript/blocked");
            e.setAttribute("type", n)
          }
        })
      } catch (e) {}
      try {
        var tc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
        if (tc && tc.set) {
          var ts = tc.set;
          Object.defineProperty(e, "textContent", {
            configurable: !0,
            get: function() { return tc.get ? tc.get.call(e) : ""; },
            set: function(val) {
              var cat = (e.getAttribute && e.getAttribute("data-consentbit-category")) || Di(val);
              if (cat && !ue(cat)) {
                e.__ci = val;
                e.setAttribute("type", "javascript/blocked");
                e.setAttribute("data-cb-inline", "1");
              } else {
                ts.call(e, val);
              }
            }
          });
        }
      } catch (_xe) {}
    }
  }

  function we(e) {
    if (e && 1 === e.nodeType)
      if ("SCRIPT" !== e.nodeName) {
        if (e.querySelectorAll) {
          var t = e.querySelectorAll("script[src]");
          for (var n = 0; n < t.length; n++) he(t[n])
        }
      } else he(e)
  }

  function ke(e) {
    if (window.__CB_WEBFLOW_MODE__) Ie(e || (A && A.categories) || {
      analytics: !0,
      marketing: !0,
      preferences: !0,
      essential: !0
    });
    else {
      var t = document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');
      var n = 0;
      var a = 0;
      var r = [];
      var i = [];
      for (var o = 0; o < t.length; o++) {
        var c = t[o];
        var s = c.getAttribute("data-cb-blocked-src");
        if (s)
          if (ye(s, c)) {
            a++;
            r.push(s)
          } else {
            z = !0;
            try {
              var l = document.createElement("script");
              l.async = c.hasAttribute("async");
              l.defer = c.hasAttribute("defer");
              l.crossOrigin = c.crossOrigin || "";
              l.integrity = c.integrity || "";
              l.referrerPolicy = c.referrerPolicy || "";
              c.id && (l.id = c.id);
              l.src = s;
              var d = c.attributes;
              for (var p = 0; p < d.length; p++) {
                var b = d[p].name;
                "src" !== b && "type" !== b && "data-cb-blocked-src" !== b && l.setAttribute(b, d[p].value)
              }
              c.parentNode ? c.parentNode.replaceChild(l, c) : document.head.appendChild(l);
              n++;
              i.push(s)
            } catch (e) {
            } finally {
              z = !1
            }
          }
      }
      var fq = document.querySelectorAll('script[type="text/plain"][data-consentbit-category]');
      for (var gi = 0; gi < fq.length; gi++) {
        var hs = fq[gi];
        var ja = hs.getAttribute("data-consentbit-category");
        if (ja && ue(ja)) {
          z = !0;
          try {
            var kq = document.createElement("script");
            kq.async = hs.hasAttribute("async");
            kq.defer = hs.hasAttribute("defer");
            var ma = hs.getAttribute("src") || "";
            if (ma) kq.src = ma;
            else kq.textContent = hs.textContent;
            var qa = hs.attributes;
            for (var ua = 0; ua < qa.length; ua++) {
              var va = qa[ua].name;
              if (va !== "type" && va !== "src" && va !== "data-consentbit-category") kq.setAttribute(va, qa[ua].value);
            }
            hs.parentNode ? hs.parentNode.replaceChild(kq, hs) : document.head.appendChild(kq);
          } catch(e) {
          } finally {
            z = !1;
          }
        }
      }
      var wq = document.querySelectorAll('script[type="javascript/blocked"][data-cb-inline="1"]');
      for (var xi = 0; xi < wq.length; xi++) {
        var ys = wq[xi];
        var zq = ys.__ci || "";
        var iq = (ys.getAttribute && ys.getAttribute("data-consentbit-category")) || Di(zq);
        if (iq && ue(iq)) {
          z = !0;
          try {
            var _il = document.createElement("script");
            if (zq) _il.textContent = zq;
            ys.parentNode ? ys.parentNode.replaceChild(_il, ys) : document.head.appendChild(_il);
          } catch(e) {
          } finally {
            z = !1;
          }
        }
      }
    }
  }

  function Dc(n) {
    var h = window.location.hostname;
    var b = h.indexOf("www.") === 0 ? h.slice(4) : h;
    var ds = [null, h, "." + h, b, "." + b, "www." + b, ".www." + b];
    var ps = ["/", window.location.pathname];
    var ex = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (var di = 0; di < ds.length; di++)
      for (var pi = 0; pi < ps.length; pi++) {
        var cv = n + "=; expires=" + ex + "; path=" + ps[pi];
        if (ds[di]) cv += "; domain=" + ds[di];
        try { document.cookie = cv; } catch(e) {}
      }
  }

  function Mc(pat) {
    var si = pat.indexOf("*");
    var pfx = si >= 0 ? pat.slice(0, si) : null;
    var all = document.cookie.split(";").map(function(c) { return c.trim().split("=")[0]; });
    return pfx ? all.filter(function(c) { return c.startsWith(pfx); }) : (all.indexOf(pat) >= 0 ? [pat] : []);
  }

  var Kc = {
    analytics: ["_ga", "_ga_*", "_gid", "_gat", "_gat_*", "_gac_*", "_hjid", "_hjSessionUser_*", "_hjSession_*", "_hjAbsoluteSessionInProgress", "_clck", "_clsk"],
    marketing: ["_fbp", "_fbc", "_gcl_au", "_gcl_ls", "_gcl_aw", "_ttp", "tt_webid_v2", "_pin_unauth", "_pinterest_ct_ua", "li_sugr", "bcookie", "bscookie", "lidc", "_uetsid", "_uetvid", "IDE", "test_cookie", "fr"],
    preferences: []
  };

  function Db(denied) {
    for (var cat in Kc) {
      if (denied.indexOf(cat) >= 0) {
        var pats = Kc[cat];
        for (var pi = 0; pi < pats.length; pi++) {
          var names = Mc(pats[pi]);
          for (var ni = 0; ni < names.length; ni++) Dc(names[ni]);
        }
      }
    }
    for (var ri = 0; ri < P.length; ri++) {
      var rule = P[ri];
      if (!rule || !rule.category || denied.indexOf(rule.category) < 0) continue;
      if (rule.name) Dc(rule.name);
    }
  }

  function Ce(e) {
    if (!e || "string" != typeof e) return null;
    var t = e.toLowerCase();
    if (0 !== t.indexOf("http")) return null;
    for (var n = 0; n < F.length; n++)
      if (-1 !== t.indexOf(F[n].domain)) return F[n].category;
    for (var a = 0; a < P.length; a++) {
      var r = P[a];
      if (r && r.scriptUrlPattern) try {
        if (new RegExp(r.scriptUrlPattern, "i").test(e)) return r.category || "marketing"
      } catch (e) {}
    }
    return null
  }

  function Ee(e) {
    if (!e || "string" != typeof e) return !1;
    var n = e.toLowerCase();
    if (-1 !== n.indexOf("consentbit") || -1 !== n.indexOf("client_data")) return !1;
    var t = Ce(e);
    return !(!t || !fe(t) || ("ccpa" === i ? !(A && A.accepted && A.ccpa && A.ccpa.doNotSell) : A && A.accepted && ue(t)))
  }

  function Se(e) {
    if (e && !e.__ip) {
      e.__ip = !0;
      try {
        Object.defineProperty(e, "src", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            return e.getAttribute("src") || ""
          },
          set: function (t) {
            if (Ee(t)) {
              e.setAttribute("data-cb-blocked-src", t);
              e.removeAttribute("src")
            } else e.setAttribute("src", t)
          }
        })
      } catch (e) {}
    }
  }

  function Ie(e) {
    if (window.__CB_WEBFLOW_MODE__) {
      var t = e || {};
      window.userConsent = t;
      try {
        document.dispatchEvent(new CustomEvent("consentUpdated", {
          detail: t,
          bubbles: !0
        }))
      } catch (e) {}
    }
  }

  function Oe() {
    if (!window.__CB_WEBFLOW_MODE__ && !window.__ce) {
      window.__ce = !0;
      try {
        N = document.createElement.bind(document)
      } catch (e) {
        N = document.createElement
      }
      document.createElement = function (e) {
        var t = N(e);
        var n = String(e || "").toLowerCase();
        "script" === n ? xe(t) : n === "iframe" && Se(t);
        return t
      };
      var t = new MutationObserver(function (e) {
        for (var t = 0; t < e.length; t++) {
          var n = e[t];
          if ("childList" === n.type) {
            var a = n.addedNodes;
            for (var r = 0; r < a.length; r++) we(a[r])
          } else "attributes" === n.type && "src" === n.attributeName && n.target && "SCRIPT" === n.target.nodeName && he(n.target)
        }
      });
      try {
        t.observe(document.documentElement, {
          childList: !0,
          subtree: !0,
          attributes: !0,
          attributeFilter: ["src"]
        })
      } catch (e) {
        t.observe(document.documentElement, {
          childList: !0,
          subtree: !0
        })
      }
      window.__cm = t
    }
  }

  function Ae() {
    if (window.__CB_WEBFLOW_MODE__) try {
      document.dispatchEvent(new CustomEvent("cbBlockScripts", {
        detail: {},
        bubbles: !0
      }))
    } catch (e) {} else {
      var e = pe();
      var t = 0;
      var n = 0;
      var a = 0;
      var r = [];
      var i = [];
      for (var o = 0; o < e.length; o++) {
        var c = e[o];
        var l = c.src;
        if ("javascript/blocked" !== c.getAttribute("type")) {
          var d = ve(l, c);
          var p = d.length > 0 ? d[0] : "uncategorized";
          if (fe(p))
            if ("analytics" === p && s && me(l)) {
              n++;
              i.push({
                src: l,
                category: p,
                reason: "ga-cookieless"
              })
            } else if (ue(p)) {
            n++;
            i.push({
              src: l,
              category: p,
              reason: "consent-granted"
            })
          } else try {
            c.setAttribute("data-cb-blocked-src", l);
            c.setAttribute("type", "javascript/blocked");
            c.removeAttribute("src");
            t++;
            r.push({
              src: l,
              category: p
            })
          } catch (e) {
          } else {
            n++;
            i.push({
              src: l,
              category: p,
              reason: "essential"
            })
          }
        } else a++
      }
    }
  }

  function Be() {
    if (T.length) {
      var e = [];
      z = !0;
      try {
        for (var t = 0; t < T.length; t++) {
          var n = T[t];
          var a = n.cats || (n.category ? [n.category] : []);
          var r;
          if (0 === a.length || a.every(function (e) {
              return !fe(e) || ue(e)
            })) {
            var i = document.createElement("script");
            i.src = n.src;
            var o = n.attrs;
            for (var c in o) Object.prototype.hasOwnProperty.call(o, c) && "src" !== c && i.setAttribute(c, o[c]);
            document.head.appendChild(i)
          } else e.push(n)
        }
      } finally {
        z = !1
      }
      T = e
    }
  }

  function Le() {
    if (s) {
      z = !0;
      try {
        var e = !1;
        var t = document.scripts;
        for (var n = 0; n < t.length; n++) {
          var a;
          var r = t[n].src || "";
          if (-1 !== r.indexOf("googletagmanager.com/gtag/js") || -1 !== r.indexOf("googletagmanager.com/gtm.js") || -1 !== r.indexOf("google-analytics.com")) {
            e = !0;
            break
          }
        }
        if (!e) {
          var i = document.createElement("script");
          i.async = !0;
          i.src = "https://www.googletagmanager.com/gtag/js?id=" + s;
          document.head.appendChild(i)
        }
        window.dataLayer = window.dataLayer || [];

        function gtag() {
          dataLayer.push(arguments)
        }
        window.gtag = gtag;
        gtag("consent", "default", {
          ad_storage: "denied",
          analytics_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied"
        });
        gtag("js", new Date);
        gtag("config", s, {
          anonymize_ip: !0,
          allow_google_signals: !1,
          allow_ad_personalization_signals: !1
        });
        gtag("event", "page_view", {
          page_path: window.location.pathname,
          page_title: document.title || ""
        })
      } finally {
        z = !1
      }
    }
  }

  function Te(e, t) {
    if (s || be()) {
      var n = {
        analytics_storage: e.analytics ? "granted" : "denied",
        ad_storage: e.marketing ? "granted" : "denied",
        ad_user_data: e.marketing ? "granted" : "denied",
        ad_personalization: e.preferences ? "granted" : "denied"
      };
      if (window.gtag) window.gtag("consent", "update", n);
      else {
        var a = 0;
        var r = setInterval(function () {
          a++;
          if (window.gtag) {
            clearInterval(r);
            window.gtag("consent", "update", n)
          } else if (a >= 20) {
            clearInterval(r);
            
          }
        }, 100)
      }
    }
  }

  function ze() {
    if (!document.getElementById("cb-styles")) {
      var e;
      var t;
      var n = "#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{background-color:" + (l && l.saveButtonBg ? String(l.saveButtonBg) : "#ffffff") + " !important;color:" + (l && l.saveButtonText ? String(l.saveButtonText) : "#334155") + " !important;border-color:#e2e8f0 !important;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{background-color:" + (l && l.acceptButtonBg ? String(l.acceptButtonBg) : "#ffffff") + " !important;color:" + (l && l.acceptButtonText ? String(l.acceptButtonText) : "#334155") + " !important;border-color:" + (l && l.acceptButtonBg ? String(l.acceptButtonBg) : "#e2e8f0") + " !important;}";
      var a = "";
      if (l && l.backgroundColor) {
        var r = String(l.backgroundColor);
        a = "#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{background-color:" + r + " !important;}.cb-gdpr-accordion{background-color:" + r + " !important;}"
      }
      var i = "";
      if (l && l.headingColor) {
        var o = String(l.headingColor);
        i = "#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{color:" + o + " !important;}.cb-gdpr-cat-label{color:" + o + " !important;}"
      }
      var c = "";
      if (l && l.textColor) {
        var s;
        c = "#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{color:" + String(l.textColor) + " !important;}"
      }
      var d = "";
      if (l && l.bannerFontWeight) {
        var p = String(l.bannerFontWeight);
        d = "#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-weight:" + p + " !important;}.cb-gdpr-cat-label{font-weight:" + p + " !important;}.cb-gdpr-cat-desc{font-weight:" + p + " !important;}.cb-banner p{font-weight:" + p + " !important;}"
      }
      var b = "#cb-preferences-banner.cb-banner h3{padding-right:36px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs h3{padding-right:0 !important;padding-top:16px !important;margin-bottom:14px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs .cb-banner-body>p{margin-bottom:16px !important;}";
      var f = "#cb-preferences-banner.cb-banner .cb-banner-body{padding-right:4px;}#cb-preferences-banner.cb-banner .cb-gdpr-accordion > div{margin-right:2px;}";
      if (!document.getElementById("cb-font-montserrat")) {
        var m = document.createElement("link");
        m.id = "cb-font-montserrat";
        m.rel = "stylesheet";
        m.href = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap";
        document.head.appendChild(m)
      }
      var ag = "";
      if (l && l.acceptButtonBg) {
        var ah = String(l.acceptButtonBg);
        var aj = l.acceptButtonText ? String(l.acceptButtonText) : "#ffffff";
        ag = ".cb-banner button#cb-accept-all-btn{background-color:" + ah + " !important;color:" + aj + " !important;}#cb-initial-banner.cb-banner #cb-accept-all-btn{background:" + ah + " !important;color:" + aj + " !important;}"
      }
      var rg = "";
      if (l && l.acceptButtonBg) {
        var rh = String(l.acceptButtonBg);
        var rj = l.acceptButtonText ? String(l.acceptButtonText) : "#ffffff";
        rg = ".cb-banner button#cb-reject-all-btn{background-color:" + rh + " !important;color:" + rj + " !important;}#cb-initial-banner.cb-banner #cb-reject-all-btn{background:" + rh + " !important;color:" + rj + " !important;}.cb-banner button#cb-prefs-reject-btn{background-color:" + rh + " !important;color:" + rj + " !important;}"
      }
      var u = document.createElement("style");
      u.id = "cb-styles";
      u.type = "text/css";
      var cg = "";
      if (l && l.backgroundColor) {
        var ch = String(l.backgroundColor).replace("#", "");
        if (3 === ch.length) ch = ch[0] + ch[0] + ch[1] + ch[1] + ch[2] + ch[2];
        var ri = parseInt(ch.substr(0, 2), 16) || 0;
        var gi = parseInt(ch.substr(2, 2), 16) || 0;
        var bi = parseInt(ch.substr(4, 2), 16) || 0;
        var cc = (0.299 * ri + 0.587 * gi + 0.114 * bi) > 128 ? "#0f172a" : "#ffffff";
        cg = "#cb-close-initial-btn,#cb-close-prefs-btn{color:" + cc + " !important;}"
      }
      u.appendChild(document.createTextNode(D + "\\n" + n + "\\n" + a + "\\n" + i + "\\n" + c + "\\n" + d + "\\n" + b + "\\n" + f + "\\n" + ag + "\\n" + rg + "\\n" + cg));
      document.head.appendChild(u)
    }
  }

  function Ne(e, t) {
    if (q()) {
      var n = document.createElement("button");
      n.type = "button";
      n.id = t;
      n.setAttribute("aria-label", "Close");
      n.textContent = "×";
      var nq = "#0f172a";
      if (l && l.backgroundColor) {
        var nh = String(l.backgroundColor).replace("#", "");
        if (3 === nh.length) nh = nh[0] + nh[0] + nh[1] + nh[1] + nh[2] + nh[2];
        var nr2 = parseInt(nh.substr(0, 2), 16) || 0;
        var ng2 = parseInt(nh.substr(2, 2), 16) || 0;
        var nb2 = parseInt(nh.substr(4, 2), 16) || 0;
        nq = (0.299 * nr2 + 0.587 * ng2 + 0.114 * nb2) > 128 ? "#0f172a" : "#ffffff";
      }
      n.style.cssText = "position:absolute;top:8px;right:24px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:" + nq + ";opacity:0.75;";
      e.appendChild(n)
    }
  }

  function je(e) {
    if (q()) {
      var t = document.createElement("button");
      t.type = "button";
      t.id = "cb-close-prefs-btn";
      t.setAttribute("aria-label", "Close");
      t.textContent = "×";
      var jq = "#0f172a";
      if (l && l.backgroundColor) {
        var jh = String(l.backgroundColor).replace("#", "");
        if (3 === jh.length) jh = jh[0] + jh[0] + jh[1] + jh[1] + jh[2] + jh[2];
        var jr2 = parseInt(jh.substr(0, 2), 16) || 0;
        var jg2 = parseInt(jh.substr(2, 2), 16) || 0;
        var jb2 = parseInt(jh.substr(4, 2), 16) || 0;
        jq = (0.299 * jr2 + 0.587 * jg2 + 0.114 * jb2) > 128 ? "#0f172a" : "#ffffff";
      }
      t.style.cssText = "position:absolute;top:8px;right:30px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:" + jq + ";opacity:0.75;";
      e.appendChild(t)
    }
  }

  function Pe() {
    console.log("[CB] Pe() called, banner already exists:", !!document.getElementById("cb-initial-banner"), "bannerType:", i);
    if (!document.getElementById("cb-initial-banner"))
      if (document.body) {
        var e = "ccpa" === i;
        var t = document.createElement("div");
        console.log("[CB] Building banner, ccpa:", e);
        if (e) {
          var n;
          (n = document.createElement("div")).className = "cb-banner";
          n.id = "cb-initial-banner";
          n.style.display = "none";
          var a;
          (a = document.createElement("div")).className = "cb-banner-body";
          var r;
          (r = document.createElement("h3")).textContent = Y("title", w);
          a.appendChild(r);
          var o = document.createElement("p");
          var c = J(U("description"), k);
          if (b && X()) {
            o.appendChild(document.createTextNode(c + " "));
            var s;
            (s = document.createElement("a")).textContent = Y("privacyPolicy", E);
            s.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(s, b);
            o.appendChild(s);
            o.appendChild(document.createTextNode("."))
          } else o.textContent = c;
          a.appendChild(o);
          var l = document.createElement("p");
          l.style.marginTop = "20px";
          l.style.marginBottom = "0";
          var d = document.createElement("button");
          d.id = "cb-ccpa-donotsell-link";
          d.type = "button";
          d.textContent = U("doNotSell");
          d.style.cssText = "background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;text-align:left;display:inline;";
          l.appendChild(d);
          a.appendChild(l);
          n.appendChild(a);
          Ne(n, "cb-close-initial-btn");
          t.appendChild(n);
          var p;
          (p = document.createElement("div")).className = "cb-banner cb-ccpa-prefs";
          p.id = "cb-preferences-banner";
          p.style.display = "none";
          "left" === g ? p.classList.add("prefs-left") : "right" === g ? p.classList.add("prefs-right") : p.classList.add("prefs-center");
          var v;
          (v = document.createElement("div")).className = "cb-banner-body";
          var y;
          (y = document.createElement("h3")).textContent = U("optOutPreference");
          v.appendChild(y);
          var h = document.createElement("p");
          var x = (U("ccpaOptOutPreferenceIntro") || U("ccpaOptOut") || "").replace(/\s*More info\.?\s*$/i, "").trim();
          if (b && X()) {
            h.appendChild(document.createTextNode(x + " "));
            var S = document.createElement("a");
            S.textContent = U("privacyPolicy");
            S.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(S, b);
            h.appendChild(S);
            h.appendChild(document.createTextNode("."))
          } else h.textContent = x;
          h.style.lineHeight = "1.45";
          v.appendChild(h);
          var _ = document.createElement("label");
          _.style.cssText = "display:flex;align-items:flex-start;gap:12px;margin-top:20px;cursor:pointer;";
          var I = document.createElement("span");
          I.style.cssText = "flex:1;line-height:1.45;";
          I.textContent = U("doNotSell");
          var O = document.createElement("input");
          O.type = "checkbox";
          O.id = "cb-ccpa-optout";
          O.style.cssText = "flex-shrink:0;margin-top:2px;";
          O.checked = !!(A && A.accepted && A.ccpa && A.ccpa.doNotSell);
          _.appendChild(O);
          _.appendChild(I);
          v.appendChild(_);
          p.appendChild(v);
          var B;
          (B = document.createElement("div")).className = "cb-banner-footer";
          var L = document.createElement("button");
          L.id = "cb-cancel-prefs-btn";
          L.textContent = W("cancel");
          B.appendChild(L);
          var T;
          (T = document.createElement("button")).id = "cb-save-prefs-btn";
          var z = U("saveMyPreferences") || U("save");
          T.textContent = z;
          B.appendChild(T);
          p.appendChild(B);
          je(p);
          t.appendChild(p)
        } else {
          console.log("[CB] GDPR banner path - building elements");
          var N = function (e) {
            var t = document.createElement("div");
            t.style.borderBottom = "1px solid #e5e7eb";
            var n = document.createElement("div");
            n.style.cssText = "display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";
            var a = document.createElement("button");
            a.type = "button";
            a.setAttribute("aria-expanded", "false");
            a.textContent = "+";
            a.style.cssText = "flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";
            var r = document.createElement("span");
            r.className = "cb-gdpr-cat-label";
            r.style.cssText = "flex:1;font-size:11px;font-weight:600;";
            r.textContent = e.labelText;
            n.appendChild(a);
            n.appendChild(r);
            var i = document.createElement("div");
            i.style.flexShrink = "0";
            if (e.alwaysActive) {
              var o = document.createElement("span");
              o.style.cssText = "font-size:11px;font-weight:600;color:#374151;";
              o.textContent = U("alwaysActive");
              i.appendChild(o)
            } else {
              var c = document.createElement("input");
              c.type = "checkbox";
              c.id = e.checkboxId;
              e.defaultChecked && (c.checked = !0);
              c.style.cssText = "position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";
              var s = document.createElement("button");
              s.type = "button";
              s.className = "cb-pref-toggle-track";
              s.setAttribute("role", "switch");
              s.setAttribute("aria-label", e.labelText);
              var l = function () {
                s.setAttribute("aria-checked", c.checked ? "true" : "false")
              };
              s.addEventListener("click", function () {
                c.checked = !c.checked;
                l()
              });
              l();
              i.appendChild(c);
              i.appendChild(s)
            }
            n.appendChild(i);
            var d = document.createElement("div");
            d.className = "cb-gdpr-cat-desc";
            d.style.cssText = "display:grid;grid-template-rows:0fr;opacity:0;font-size:13px;line-height:1.5;transition:grid-template-rows .3s ease,opacity .25s ease;";
            var dInner = document.createElement("div");
            dInner.style.cssText = "overflow:hidden;min-height:0;padding:0 12px 12px 44px;";
            dInner.textContent = e.descText;
            d.appendChild(dInner);
            var expand = function (el) {
              el.style.gridTemplateRows = "1fr";
              el.style.opacity = ""
            };
            var collapse = function (el) {
              el.style.gridTemplateRows = "0fr";
              el.style.opacity = "0"
            };
            a.addEventListener("click", function () {
              var io = "true" !== a.getAttribute("aria-expanded");
              var container = t.parentNode;
              if (container) {
                var items = container.children;
                for (var _i = 0; _i < items.length; _i++) {
                  var _desc = items[_i].querySelector(".cb-gdpr-cat-desc");
                  var _btn = items[_i].querySelector("button[aria-expanded]");
                  if (_desc && _desc !== d) {
                    collapse(_desc);
                    if (_btn) {
                      _btn.textContent = "+";
                      _btn.setAttribute("aria-expanded", "false")
                    }
                  }
                }
              }
              io ? expand(d) : collapse(d);
              a.textContent = io ? "−" : "+";
              a.setAttribute("aria-expanded", io ? "true" : "false")
            });
            t.appendChild(n);
            t.appendChild(d);
            return t
          };
          var n;
          (n = document.createElement("div")).className = "cb-banner";
          n.id = "cb-initial-banner";
          n.style.display = "none";
          var a;
          (a = document.createElement("div")).className = "cb-banner-body";
          var r;
          (r = document.createElement("h3")).textContent = U("title");
          a.appendChild(r);
          var o = document.createElement("p");
          var c = U("description");
          if (b && X()) {
            o.appendChild(document.createTextNode(c + " "));
            var s;
            (s = document.createElement("a")).textContent = U("privacyPolicy");
            s.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(s, b);
            o.appendChild(s);
            o.appendChild(document.createTextNode("."))
          } else o.textContent = c;
          a.appendChild(o);
          n.appendChild(a);
          var j = document.createElement("div");
          j.className = "cb-banner-footer";
          var P = document.createElement("button");
          P.id = "cb-preferences-btn";
          P.textContent = J(W("customise"), C);
          qC() && j.appendChild(P);
          var F = document.createElement("button");
          F.id = "cb-reject-all-btn";
          F.textContent = J(W("rejectAll"), C);
          qR() && j.appendChild(F);
          var D = document.createElement("button");
          D.id = "cb-accept-all-btn";
          D.textContent = J(W("acceptAll"), C);
          j.appendChild(D);
          n.appendChild(j);
          Ne(n, "cb-close-initial-btn");
          t.appendChild(n);
          var p;
          (p = document.createElement("div")).className = "cb-banner";
          p.id = "cb-preferences-banner";
          p.style.display = "none";
          "left" === g ? p.classList.add("prefs-left") : "right" === g ? p.classList.add("prefs-right") : p.classList.add("prefs-center");
          var v;
          (v = document.createElement("div")).className = "cb-banner-body";
          var y;
          (y = document.createElement("h3")).textContent = Y("cookiePreferences", w);
          v.appendChild(y);
          var h = document.createElement("p");
          var M = (J(U("managePreferences"), k) || "").replace(/\s*More info\.?\s*$/i, "").trim();
          if (b && X()) {
            h.appendChild(document.createTextNode(M + " "));
            var R = document.createElement("a");
            R.textContent = Y("privacyPolicy", E);
            R.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(R, b);
            h.appendChild(R);
            h.appendChild(document.createTextNode("."))
          } else h.textContent = M;
          v.appendChild(h);
          var q = document.createElement("div");
          q.className = "cb-gdpr-accordion";
          q.style.cssText = "border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";
          var H = U("strictlyNecessary") || U("essential");
          q.appendChild(N({
            labelText: H,
            alwaysActive: !0,
            descText: U("essentialDescription")
          }));
          var V;
          var $ = ae() || A && A.accepted && A.categories || {};
          q.appendChild(N({
            labelText: U("marketing"),
            checkboxId: "cb-pref-marketing",
            defaultChecked: !!$.marketing,
            descText: U("marketingDescription")
          }));
          q.appendChild(N({
            labelText: U("analytics"),
            checkboxId: "cb-pref-analytics",
            defaultChecked: !!$.analytics,
            descText: U("analyticsDescription")
          }));
          q.appendChild(N({
            labelText: U("preferences"),
            checkboxId: "cb-pref-preferences",
            defaultChecked: !!$.preferences,
            descText: U("preferencesDescription")
          }));
          q.lastChild && (q.lastChild.style.borderBottom = "none");
          v.appendChild(q);
          p.appendChild(v);
          var B;
          (B = document.createElement("div")).className = "cb-banner-footer";
          var G = document.createElement("button");
          G.id = "cb-prefs-reject-btn";
          G.textContent = J(W("rejectAll"), C);
          B.appendChild(G);
          var T;
          (T = document.createElement("button")).id = "cb-save-prefs-btn";
          T.textContent = J(W("saveMyPreferences") || W("save"), C);
          B.appendChild(T);
          p.appendChild(B);
          je(p);
          t.appendChild(p)
        }
        document.body.appendChild(t);
        console.log("[CB] Banner wrapper appended to body, searching for cb-initial-banner...");
        f && (document.body.style.overflow = "hidden");
        if (!window.__cbResizeInit) {
          window.__cbResizeInit = true;
          window.addEventListener("resize", function() {
            var rb = document.getElementById("cb-initial-banner");
            if (rb && rb.style.display !== "none" && rb.style.visibility !== "hidden") Z(rb);
          });
        }
        var K = document.getElementById("cb-initial-banner");
        console.log("[CB] cb-initial-banner element found:", K, "current display:", K ? K.style.display : "N/A");
        if (K) {
          var ee = Z(K);
          K.style.display = "flex";
          K.style.visibility = "visible";
          K.style.opacity = "1";
          console.log("[CB] Banner display set to flex, computedDisplay:", window.getComputedStyle(K).display, "computedVisibility:", window.getComputedStyle(K).visibility, "computedOpacity:", window.getComputedStyle(K).opacity);
          if (m) {
            var te = "";
            var ne = u;
            te = ee ? "slide-up" === u ? "cb-banner-animate-initial-center-bottom" : "slide-down" === u ? "cb-banner-animate-initial-center-top" : "zoom-in" === u ? "cb-banner-animate-initial-center-zoom" : "cb-banner-animate-fade" : "slide-up" === u ? "cb-banner-animate-bottom" : "slide-down" === u ? "cb-banner-animate-top" : "zoom-in" === u ? "cb-banner-animate-zoom-in" : "cb-banner-animate-fade";
            K.classList.add(te)
          }
        }
      } else {
        setTimeout(Pe, 100)
      }
  }

  function Fe() {
    f && (document.body.style.overflow = "")
  }

  function De() {
    try {
      if (l && !1 === l.showBannerLogo) return !1;
      if (l && 0 === l.showBannerLogo) return !1;
      var e = R();
      var cf = TRANSLATIONS.config || {};
      var n = cf.floatingButtonEnabled != null ? cf.floatingButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).floatingButtonEnabled;
      return !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function Me() {
    try {
      if (l && l.bannerLogoPosition) return "right" === l.bannerLogoPosition ? "right" : "left";
      var e = R();
      var cf = TRANSLATIONS.config || {};
      var fp = cf.floatingButtonPosition != null ? cf.floatingButtonPosition : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).floatingButtonPosition;
      return "right" === fp ? "right" : "left"
    } catch (e) {
      return "left"
    }
  }

  function Re() {
    var e = "http://www.w3.org/2000/svg";
    var t = document.createElementNS(e, "svg");
    t.setAttribute("xmlns", e);
    t.setAttribute("viewBox", "0 0 40 40");
    t.setAttribute("width", "44");
    t.setAttribute("height", "44");
    t.setAttribute("aria-hidden", "true");
    t.setAttribute("focusable", "false");
    t.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";
    var n = document.createElementNS(e, "circle");
    n.setAttribute("cx", "20");
    n.setAttribute("cy", "20");
    n.setAttribute("r", "18");
    n.setAttribute("fill", "#007aff");
    t.appendChild(n);
    var a = [{
      cx: "14",
      cy: "14",
      r: "2.2"
    }, {
      cx: "24",
      cy: "18",
      r: "2.5"
    }, {
      cx: "17",
      cy: "25",
      r: "2"
    }];
    for (var r = 0; r < a.length; r++) {
      var i = document.createElementNS(e, "circle");
      i.setAttribute("cx", a[r].cx);
      i.setAttribute("cy", a[r].cy);
      i.setAttribute("r", a[r].r);
      i.setAttribute("fill", "#ffffff");
      t.appendChild(i)
    }
    return t
  }

  function Ue() {
    try {
      var e = document.getElementsByTagName("script");
      for (var t = e.length - 1; t >= 0; t--) {
        var n = e[t].src || "";
        if (-1 !== n.indexOf("/consentbit/") || -1 !== n.indexOf("/client_data/")) return new URL(n).origin
      }
    } catch (e) {}
    return ""
  }

  function We() {
    if (!document.getElementById("cb-floating-trigger") && De()) {
      var e = Me();
      var t = n || "";
      var r = a || "";
      if (!t) {
        var i = Ue();
        if (i) {
          t = i + "/embed/floating-logo.svg";
          r || (r = t)
        }
      }
      var o = document.createElement("button");
      o.id = "cb-floating-trigger";
      o.type = "button";
      o.setAttribute("aria-label", U("cookiePreferences"));
      o.style.cssText = "position:fixed;bottom:28px;" + ("right" === e ? "right:16px;" : "left:16px;") + "z-index:2147483646;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;";
      if (t) {
        var c = document.createElement("img");
        c.alt = "";
        c.src = t;
        c.setAttribute("width", "44");
        c.setAttribute("height", "44");
        c.draggable = !1;
        c.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";
        var s = !1;
        c.addEventListener("error", function e() {
          if (s || !r || t === r) {
            c.removeEventListener("error", e);
            c.parentNode && c.parentNode.replaceChild(Re(), c)
          } else {
            s = !0;
            c.src = r
          }
        });
        o.appendChild(c)
      } else o.appendChild(Re());
      document.body.appendChild(o)
    }
  }

  function Je() {
    if (!m) return "";
    var e = u;
    return "left" === g ? "zoom-in" === u ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-prefs-left" : "right" === g ? "zoom-in" === u ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-prefs-right" : "slide-up" === u ? "cb-banner-animate-center-bottom" : "slide-down" === u ? "cb-banner-animate-center-top" : "zoom-in" === u ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-fade"
  }

  function Ye(e) {
    if (e) {
      var t = M.split(" ");
      for (var n = 0; n < t.length; n++) t[n] && e.classList.remove(t[n])
    }
  }

  function Xe() {
    ze();
    Pe();
    We();
    var e = document.getElementById("cb-initial-banner");
    var t = document.getElementById("cb-preferences-banner");
    var n = document.getElementById("cb-preferences-btn");
    var a = document.getElementById("cb-accept-all-btn");
    var r = document.getElementById("cb-reject-all-btn");
    var o = document.getElementById("cb-prefs-reject-btn");
    var c = document.getElementById("cb-cancel-prefs-btn");
    var s = document.getElementById("cb-save-prefs-btn");
    var l = document.getElementById("cb-ccpa-donotsell-link");
    var d = "ccpa" === i;

    function p() {
      if (e) {
        e.style.setProperty("display", "none", "important");
        e.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade")
      }
      if (t) {
        t.style.display = "none";
        Ye(t)
      }
      var n = document.getElementById("cb-floating-trigger");
      n && (n.style.display = "flex");
      Fe()
    }

    function b() {
      if (e) {
        if (t) {
          t.style.display = "none";
          Ye(t)
        }
        var n = Z(e);
        e.style.setProperty("display", "flex", "important");
        e.style.setProperty("visibility", "visible", "important");
        e.style.setProperty("opacity", "1", "important");
        e.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade", "cb-banner-animate-zoom-in");
        if (m) {
          var a = "";
          var r = u;
          a = n ? "slide-up" === u ? "cb-banner-animate-initial-center-bottom" : "slide-down" === u ? "cb-banner-animate-initial-center-top" : "zoom-in" === u ? "cb-banner-animate-initial-center-zoom" : "cb-banner-animate-fade" : "slide-up" === u ? "cb-banner-animate-bottom" : "slide-down" === u ? "cb-banner-animate-top" : "zoom-in" === u ? "cb-banner-animate-zoom-in" : "cb-banner-animate-fade";
          e.classList.add(a)
        }
        f && (document.body.style.overflow = "hidden")
      }
    }
    var g = document.getElementById("cb-floating-trigger");
    g && g.addEventListener("click", function (e) {
      e && e.preventDefault && e.preventDefault();
      e && e.stopPropagation && e.stopPropagation();
      b()
    });
    n && n.addEventListener("click", function () {
      if (e && t) {
        if (!d) {
          var n = ae() || A && A.categories || {};
          var a = function (e, t) {
            var n = document.getElementById(e);
            if (n) {
              n.checked = !!t;
              var a = n.parentNode && n.parentNode.querySelector("button.cb-pref-toggle-track");
              a && a.setAttribute("aria-checked", n.checked ? "true" : "false")
            }
          };
          a("cb-pref-analytics", n.analytics);
          a("cb-pref-preferences", n.preferences);
          a("cb-pref-marketing", n.marketing)
        }
        e.style.display = "none";
        e.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade");
        var ft1 = document.getElementById("cb-floating-trigger");
        ft1 && (ft1.style.display = "none");
        t.style.display = "flex";
        t.style.visibility = "visible";
        t.style.opacity = "1";
        Ye(t);
        var r = Je();
        r && t.classList.add(r)
      }
    });
    o && o.addEventListener("click", function () {
      var e = {
        accepted: !0,
        timestamp: (new Date).toISOString(),
        categories: {
          essential: !0,
          analytics: !1,
          preferences: !1,
          marketing: !1
        }
      };
      Db(["analytics", "marketing", "preferences"]);
      te(e);
      re(e, {
        status: "rejected"
      });
      ne(e.categories);
      Te(e.categories, "[PrefsReject]");
      Ie(e.categories);
      p()
    });
    var v = document.getElementById("cb-close-initial-btn");
    var y = document.getElementById("cb-close-prefs-btn");
    v && v.addEventListener("click", function () {
      p()
    });
    y && y.addEventListener("click", function () {
      p()
    });
    d && l && l.addEventListener("click", function () {
      if (e && t) {
        e.style.display = "none";
        var ft2 = document.getElementById("cb-floating-trigger");
        ft2 && (ft2.style.display = "none");
        t.style.display = "flex";
        t.style.visibility = "visible";
        t.style.opacity = "1";
        Ye(t);
        var n = Je();
        n && t.classList.add(n)
      }
    });
    c && c.addEventListener("click", function () {
      b()
    });
    r && r.addEventListener("click", function () {
      if (!d) {
        var e = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: !0,
            analytics: !1,
            preferences: !1,
            marketing: !1
          }
        };
        Db(["analytics", "marketing", "preferences"]);
        te(e);
        re(e, {
          status: "rejected"
        });
        ne(e.categories);
        Te(e.categories, "[Reject]");
        Ie(e.categories)
      }
      p()
    });
    a && a.addEventListener("click", function () {
      if (d) {
        var e = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: !1
          }
        };
        te(e);
        re(e, {
          status: "given"
        });
        ke({
          analytics: !0,
          marketing: !0,
          preferences: !0,
          essential: !0
        })
      } else {
        var t = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: !0,
            analytics: !0,
            preferences: !0,
            marketing: !0
          }
        };
        te(t);
        re(t, {
          status: "given"
        });
        ne(t.categories);
        ke(t.categories);
        Te(t.categories, "[Accept]")
      }
      p()
    });
    s && s.addEventListener("click", function () {
      if (d) {
        var e = document.getElementById("cb-ccpa-optout");
        var t = !(!e || !e.checked);
        var n = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: t
          }
        };
        te(n);
        re(n, {
          status: t ? "rejected" : "given"
        });
        t || ke({
          analytics: !0,
          marketing: !0,
          preferences: !0,
          essential: !0
        })
      } else {
        var a = document.getElementById("cb-pref-analytics");
        var r = document.getElementById("cb-pref-preferences");
        var i = document.getElementById("cb-pref-marketing");
        var o = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: !0,
            analytics: !(!a || !a.checked),
            preferences: !(!r || !r.checked),
            marketing: !(!i || !i.checked)
          }
        };
        var fd = [];
        if (!o.categories.analytics) fd.push("analytics");
        if (!o.categories.marketing) fd.push("marketing");
        if (!o.categories.preferences) fd.push("preferences");
        if (fd.length) Db(fd);
        te(o);
        re(o, {
          status: "partial"
        });
        ne(o.categories);
        ke(o.categories);
        Te(o.categories, "[Save]");
        Ie(o.categories)
      }
      p()
    })
  }

  function qe() {
    Xe();
    var e = document.getElementById("cb-initial-banner");
    if (e) {
      e.style.display = "flex";
      e.style.visibility = "visible";
      e.style.opacity = "1";
    }
    var ft = document.getElementById("cb-floating-trigger");
    if (ft) ft.style.display = "none";
  }

  function He() {
    var e = be();
    if ("gdpr" === i) {
      Ae();
      if (s || e) {
        window.gtag && window.gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          functionality_storage: "denied",
          personalization_storage: "denied",
          security_storage: "granted",
          wait_for_update: 500
        });
        A.accepted ? Te(A.categories || {}, "[Reload]") : s && Le()
      }
    }
    if (!window.__CB_WEBFLOW_MODE__) {
      if (o)
        if (A.accepted) {
          Xe();
          var t = document.getElementById("cb-floating-trigger");
          t && (t.style.display = "flex");
          var Ha = document.getElementById("cb-initial-banner");
          if (Ha) {
            Ha.style.setProperty("display", "none", "important");
            Ha.style.setProperty("visibility", "hidden", "important");
          }
        } else qe();
    } else {
      Xe();
      if (A.accepted) {
        var Hb = document.getElementById("cb-initial-banner");
        if (Hb) {
          Hb.style.setProperty("display", "none", "important");
          Hb.style.setProperty("visibility", "hidden", "important");
        }
        var Hc = document.getElementById("cb-preferences-banner");
        if (Hc) {
          Hc.style.setProperty("display", "none", "important");
        }
        var Hd = document.getElementById("cb-floating-trigger");
        if (Hd) Hd.style.display = "flex";
      } else if (o) {
        var Hf = document.getElementById("cb-initial-banner");
        if (Hf) {
          Hf.style.display = "flex";
          Hf.style.setProperty("visibility", "visible", "important");
          Hf.style.setProperty("opacity", "1", "important");
        }
        var Hft = document.getElementById("cb-floating-trigger");
        if (Hft) Hft.style.display = "none";
      } else {
        // bannerEnabled === false (region-suppressed, e.g. CCPA banner for non-US):
        // keep the initial banner hidden and surface only the floating trigger.
        var Hf2 = document.getElementById("cb-initial-banner");
        if (Hf2) {
          Hf2.style.setProperty("display", "none", "important");
          Hf2.style.setProperty("visibility", "hidden", "important");
        }
        var Hft2 = document.getElementById("cb-floating-trigger");
        if (Hft2) Hft2.style.display = "flex";
      }
    }
    try {
      ce()
    } catch (e) {
    }

    function n() {
      document.addEventListener("click", function (e) {
        var t = e.target;
        for (; t && t !== document.body;) {
          var isReset = t.hasAttribute && t.hasAttribute("data-consentbit-trigger");
          var isShowOnly = t.hasAttribute && t.hasAttribute("data-consentbit-banner");
          if (isReset || isShowOnly) {
            e.preventDefault();
            e.stopPropagation();
            if (isReset) {
              try {
                localStorage.removeItem(I);
                A = {
                  accepted: !1,
                  timestamp: null
                }
              } catch (e) {
              }
            }
            var n = document.getElementById("cb-initial-banner");
            if (n) {
              n.style.display = "flex";
              n.style.visibility = "visible";
              n.style.opacity = "1";
              f && (document.body.style.overflow = "hidden");
              var nft = document.getElementById("cb-floating-trigger");
              if (nft) nft.style.display = "none";
              n.scrollIntoView({
                behavior: "smooth",
                block: "start"
              })
            } else {
              qe();
              setTimeout(function () {
                var e = document.getElementById("cb-initial-banner");
                e && e.scrollIntoView({
                  behavior: "smooth",
                  block: "start"
                })
              }, 100)
            }
            return !1
          }
          t = t.parentElement
        }
      }, !0)
    }
    "loading" === document.readyState ? document.addEventListener("DOMContentLoaded", n) : n()
  }
}();
`;

  // ETag must change whenever banner customization/translation changes.
  // `Site.updatedAt` does not always update when only BannerCustomization changes, so include both.
  // Also include a script version so CDN logic changes propagate even when site/customization did not change.
  const SCRIPT_VERSION = '2026-06-11-webflow-bannerenabled-geo-fix';
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
const loaderIab=`
${inlineConfig}
${getLoaderIabScript(customization, { rawPos: customization?.position || 'bottom-left', bannerLayoutVisual: enTrans?.bannerLayoutVisual, textAlign: (typeof textAlign !== 'undefined' && (textAlign === 'center' || textAlign === 'right')) ? textAlign : 'left', bannerEntranceAnimation: siteConfigPayload?.customization?.bannerEntranceAnimation })}
`

  // Strip the inlineConfig prefix from loader so __CONSENT_SITE__ is only assigned once
  // in loaderWebflow (set here → read by getWebflowSetupScript → loader IIFE reads it).
  const loaderCore = loader.replace(inlineConfig, '');
  const loaderWebflow = `${inlineConfig}${getWebflowSetupScript()}
` + loaderCore;

  // loaderIab also starts with inlineConfig — strip it to avoid a second __CONSENT_SITE__ assignment.
  const loaderIabCore = loaderIab.replace(inlineConfig, '');
  // Execution order: inlineConfig → getWebflowSetupScript (sets __CB_WEBFLOW_MODE__, script blocking,
  // consentUpdated listener) → TCF bridge (fires consentUpdated on IAB consent) → IAB banner UI.
  const loaderIabWebflow = `${inlineConfig}${getWebflowSetupScript()}
(function(){function _cbInstallTcfBridge(){if(!window.__tcfapi){setTimeout(_cbInstallTcfBridge,150);return;}try{window.__tcfapi('addEventListener',2,function(a,b){if(!b)return;if(a.eventStatus==='useractioncomplete'||a.eventStatus==='tcloaded'){var c=!!(a.purpose&&a.purpose.consents&&a.purpose.consents[1]);var d={essential:true,analytics:c,marketing:c,preferences:c};window.userConsent=d;try{document.dispatchEvent(new CustomEvent('consentUpdated',{detail:d,bubbles:true}));}catch(e){}}});}catch(e){}}_cbInstallTcfBridge();})();
` + loaderIabCore;

  // IAB/TCF banner requires a paid tier that includes IAB (Essential or Growth).
  // If the site was downgraded to a lower plan, fall back to the standard GDPR banner
  // so the IAB UI is never served.
  const iabAllowed = effectivePlanId === 'growth' || effectivePlanId === 'essential';
  const wantsIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab';
  const isWebflow = String(resolvedSite.platform || '').toLowerCase() === 'webflow';
  const serveKind = (wantsIab && iabAllowed && isWebflow) ? 'iabwebflow'
    : (wantsIab && iabAllowed) ? 'iab'
    : isWebflow ? 'webflow'
    : 'standard';
  const why = {
    wantsIab,
    iabAllowed,
    isWebflow,
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
  const scriptToServe =
    (serveKind === 'iab' ? loaderIab : serveKind === 'iabwebflow' ? loaderIabWebflow : serveKind === 'webflow' ? loaderWebflow : loader);


  return new Response(scriptToServe, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'ETag': etag,
      // Debug headers (safe, non-sensitive): helps confirm which loader was served and why.
      'X-ConsentBit-Loader': serveKind,
      'X-ConsentBit-Plan': String(effectivePlanId || 'free'),
      'X-ConsentBit-IabAllowed': iabAllowed ? '1' : '0',
      'X-ConsentBit-OrgId': orgIdForDebug ? String(orgIdForDebug) : 'none',
      'X-ConsentBit-Webflow': isWebflow ? '1' : '0',
    },
  });
}