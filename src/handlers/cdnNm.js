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
      'SELECT id, organizationId, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id, pendingScan, updatedAt, platform, platformSiteId, version FROM Site WHERE cdnScriptId = ?1'
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
        'SELECT id, organizationId, name, domain, cdnScriptId, banner_type, region_mode, ga_measurement_id, pendingScan, updatedAt, platform, platformSiteId, version FROM Site WHERE id = ?1'
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
  // Idempotency guard: if this banner script ends up embedded/executed TWICE on a page
  // (e.g. a leftover legacy install + the current one), only the FIRST copy initialises.
  // Without this, both copies bind the banner's click handlers and a single Accept/Reject
  // fires the /api/consent POST twice → duplicate consent-log rows.
  if (window.__cbBannerInit) return;
  window.__cbBannerInit = true;
  var SITE = window.__CONSENT_SITE__ || {};
  var domainAllowed = true;

  // Client-side domain guard: this script only runs on the registered domain.
  // Webflow-hosted sites and *.webflow.io staging domains are exempt.
  ! function () {
    var expectedDomain = SITE.registeredDomain;
    if (expectedDomain) try {
      var currentHost = window.location.hostname.replace(/^www\./, "").toLowerCase();
      if (currentHost !== expectedDomain && SITE.platform !== 'webflow' && !currentHost.endsWith('.webflow.io')) {
        window.__CONSENT_SITE__ = null;
        domainAllowed = false
      }
    } catch (err) {}
  }();

  if (domainAllowed) {
    var floatingLogoUrl = SITE.floatingLogoUrl || "";
    var floatingLogoFallbackUrl = SITE.floatingLogoFallbackUrl || "";
    var siteId = SITE.id || null;
    var bannerType = SITE.bannerType || "gdpr";
    var bannerEnabled = false !== SITE.bannerEnabled;
    var apiBase = SITE.apiBase;
    var gaMeasurementId = SITE.gaId || null;
    var customization = SITE.customization || null;
    var pendingScan = true === SITE.pendingScan;
    var bannerLayoutVisual = customization && customization.bannerLayoutVisual || "box";
    var privacyPolicyUrl = customization ? customization.privacyPolicyUrl : null;
    var stopScroll = !!customization && customization.stopScroll;
    var animationEnabled = !customization || false !== customization.animationEnabled;
    var entranceAnimation = customization && customization.bannerEntranceAnimation || "fade-in";
    var preferencePosition = customization && customization.preferencePosition || "center";
    var centerAnimationDirection = customization && customization.centerAnimationDirection || "fade";
    var configuredLanguage = customization && customization.language || "en";
    var autoDetectLanguage = !!customization && true === customization.autoDetectLanguage;
    ${translationsVar}
    var BUTTON_TEXT_KEYS = ["customise", "rejectAll", "acceptAll", "save", "back", "doNotSell", "saveMyPreferences", "confirmChoice", "cancel", "optOutPreference"];

    // Character caps applied to translated copy so a long translation cannot break the layout.
    var MAX_TITLE_LEN = 30,
      MAX_DESCRIPTION_LEN = 320,
      MAX_BUTTON_LEN = 20,
      MAX_LINK_LEN = 30,
      MAX_LONG_TEXT_LEN = 200;
    var FLOATING_LOGO_SIZE_PX = 56;

    var STORAGE_KEY = "consentbit_" + siteId;
    var cookieExpirationDays = void 0 !== customization && customization && null != customization.cookieExpirationDays ? Math.max(1, Math.min(365, Number(customization.cookieExpirationDays) || 30)) : 30;
    var consentState = loadConsentState();
    // --- GPC (Global Privacy Control) gate -------------------------------------
    // Honor navigator.globalPrivacyControl as a CCPA "Do Not Sell/Share" opt-out.
    // MUST run here — before the script blocker (shouldBlockScript/isCategoryAllowed)
    // and boot() read consentState — so non-essential scripts are blocked from first
    // paint. Scoped to CCPA; first visit only: a stored choice always wins, so a user
    // who opted back in is never overridden. navigator.globalPrivacyControl is
    // browser-set and synchronous, so no async/geo wait is needed (the banner type is
    // already resolved server-side).
    try {
      if (navigator.globalPrivacyControl === true && "ccpa" === bannerType && (!consentState || !consentState.accepted)) {
        consentState = {
          accepted: true,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: true
          },
          gpc: true
        };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(consentState))
        } catch (err) {}
        postConsentToApi(consentState, {
          status: "rejected",
          consentMethod: "gpc"
        })
      }
    } catch (err) {}
    // ---------------------------------------------------------------------------

    var PREFS_STORAGE_KEY = "consentbit_prefs_" + (siteId || "");
    var PAGEVIEW_LIMIT_KEY = "cb_pv_over_limit_" + (siteId || "");

    /** Scripts deferred until consent allows them (see flushQueuedScripts). */
    var queuedScripts = [];
    /** Re-entrancy guard: true while we inject a script ourselves, so the blocker ignores it. */
    var isInjectingScript = false;
    /** Original document.createElement, captured before we patch it. */
    var nativeCreateElement = null;

    /** URL-pattern → category rules shipped by the worker. */
    var scriptBlockProviders = SITE.scriptBlockProviders || [];
    /** URL-pattern → category rules defined by the site owner in the dashboard. */
    var customCookieRules = SITE.customCookieRules || [];

    /** Fallback domain → category map, used for iframes and for scripts no rule matched. */
    var KNOWN_TRACKER_DOMAINS = [{
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
    /** Baseline stylesheet for both banners; the dashboard's custom CSS is appended below. */
    var BASE_CSS = ".cb-banner,.cb-banner *{box-sizing:border-box;}#cb-initial-banner.cb-banner{width:440px;min-width:280px;max-width:min(440px,92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;bottom:32px;left:32px;right:auto;padding:16px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:inline-flex;flex-direction:column;align-items:stretch;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-initial-banner.cb-banner .cb-banner-body{flex:0 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner{width:540px;max-width:92vw;max-height:min(85vh,580px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:flex;flex-direction:column;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-preferences-banner.cb-banner .cb-banner-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner.prefs-left{left:32px;right:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-right{right:32px;left:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-center{left:50%;top:50%;transform:translate(-50%,-50%);}.cb-banner-body{overflow-y:auto;overflow-x:hidden;margin-bottom:12px;}.cb-banner h3{margin:0 0 8px;font-size:16px!important;line-height:1.4!important;font-weight:600;color:#0f172a;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}#cb-initial-banner.cb-banner h3{font-size:16px!important;font-weight:600;color:rgba(0,0,0,0.8);padding-right:36px;}#cb-initial-banner.cb-banner .cb-banner-body > p{color:rgba(0,0,0,0.8);}.cb-gdpr-accordion{margin-top:4px;margin-bottom:4px;}.cb-gdpr-cat-label{color:#0f172a;}.cb-gdpr-cat-desc{color:#64748b;}.cb-banner p{margin:0 0 12px;font-size:14px!important;line-height:1.5!important;color:#334155;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}.cb-banner-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;align-items:center;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex:0 0 auto;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}" + (customization && "banner" === customization.bannerLayoutVisual ? "#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}" : "") + ".cb-banner button{padding:12px 32px;border-radius:0.375rem;cursor:pointer;font-size:14px;font-weight:600;border:1px solid #e2e8f0;transition:opacity 0.2s;white-space:normal;word-break:break-word;min-width:0;text-align:center;}@media (max-width:660px){#cb-initial-banner.cb-banner{width:100vw!important;max-width:100vw!important;left:0!important;right:0!important;bottom:0!important;transform:none!important;border-radius:0!important;border-left:none!important;border-right:none!important;border-bottom:none!important;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-initial-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}#cb-preferences-banner.cb-banner{width:calc(100vw - 32px)!important;max-width:calc(100vw - 32px)!important;padding:20px!important;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-preferences-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}}@media (max-width:350px){#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{font-size:12px!important;}#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-size:13px!important;}#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,.cb-gdpr-cat-desc{font-size:12px!important;}#cb-initial-banner.cb-banner .cb-banner-footer button,#cb-preferences-banner.cb-banner .cb-banner-footer button{font-size:12px!important;padding:10px 16px!important;}}.cb-banner button:hover:not(.cb-pref-toggle-track){opacity:0.8;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{display:block !important;width:40px !important;min-width:40px !important;height:22px !important;padding:0 !important;margin:0 !important;border:none !important;border-radius:11px !important;background:#d1d5db !important;box-shadow:none !important;flex-shrink:0 !important;position:relative !important;overflow:visible !important;box-sizing:border-box !important;cursor:pointer !important;appearance:none !important;-webkit-appearance:none !important;font-size:0 !important;line-height:0 !important;opacity:1 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{background:#22c55e !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{content:'' !important;position:absolute !important;top:2px !important;left:2px !important;width:18px !important;height:18px !important;border-radius:50% !important;background:#ffffff !important;box-shadow:0 1px 3px rgba(0,0,0,.2) !important;pointer-events:none !important;transition:left .15s ease !important;z-index:2 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{left:20px !important;}.cb-banner button#cb-accept-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-reject-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-preferences-btn,.cb-banner button#cb-ccpa-donotsell-link{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner button#cb-prefs-reject-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner label{display:block;margin-bottom:6px;font-size:11px;}.cb-banner input[type='checkbox']{margin-right:6px;}.cb-banner a{color:#007aff !important;text-decoration:underline !important;font-size:inherit !important;display:inline !important;font-weight:inherit !important;white-space:normal;}@keyframes slideInFromLeft{from{transform:translateX(-100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromRight{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromTop{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes slideInFromBottom{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}@keyframes prefsSlideInFromLeft{from{transform:translate(-120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideInFromRight{from{transform:translate(120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideCenterFromBottom{from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes prefsSlideCenterFromTop{from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes zoomIn{from{transform:scale(0.85);opacity:0;}to{transform:scale(1);opacity:1;}}@keyframes cbInitialCenterSlideFromBottom{from{transform:translate(-50%,100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterSlideFromTop{from{transform:translate(-50%,-100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterZoomIn{from{transform:translateX(-50%) scale(0.85);opacity:0;}to{transform:translateX(-50%) scale(1);opacity:1;}}.cb-banner-animate-initial-center-bottom{animation:cbInitialCenterSlideFromBottom 0.35s ease-out;}.cb-banner-animate-initial-center-top{animation:cbInitialCenterSlideFromTop 0.35s ease-out;}.cb-banner-animate-initial-center-zoom{animation:cbInitialCenterZoomIn 0.3s ease-out;}@keyframes prefsZoomIn{from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}to{transform:translate(-50%,-50%) scale(1);opacity:1;}}.cb-banner-animate-left{animation:slideInFromLeft 0.4s ease-out;}.cb-banner-animate-right{animation:slideInFromRight 0.4s ease-out;}.cb-banner-animate-top{animation:slideInFromTop 0.4s ease-out;}.cb-banner-animate-bottom{animation:slideInFromBottom 0.4s ease-out;}.cb-banner-animate-fade{animation:fadeIn 0.3s ease-out;}.cb-banner-animate-prefs-left{animation:prefsSlideInFromLeft 0.4s ease-out;}.cb-banner-animate-prefs-right{animation:prefsSlideInFromRight 0.4s ease-out;}.cb-banner-animate-center-top{animation:prefsSlideCenterFromTop 0.35s ease-out;}.cb-banner-animate-center-bottom{animation:prefsSlideCenterFromBottom 0.35s ease-out;}.cb-banner-animate-zoom-in{animation:zoomIn 0.3s ease-out;}.cb-banner-animate-prefs-zoom-in{animation:prefsZoomIn 0.3s ease-out;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}#cb-initial-banner.cb-banner .cb-banner-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex-shrink:0;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}#cb-initial-banner.cb-banner #cb-preferences-btn{background:#ffffff!important;color:#334155!important;border:1px solid #334155!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-initial-banner.cb-banner #cb-reject-all-btn,#cb-initial-banner.cb-banner #cb-accept-all-btn{background:#007aff!important;color:#ffffff!important;border-color:#007aff!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-floating-trigger{position:fixed;z-index:2147483646!important;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;}#cb-floating-trigger img,#cb-floating-trigger svg{display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;}";
    SITE.styles && (BASE_CSS = BASE_CSS + "\\n" + SITE.styles);

    /** Every entrance-animation class, so we can strip whichever one is currently applied. */
    var ANIMATION_CLASSES = "cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in";

    installScriptBlocker();
    "complete" === document.readyState || "interactive" === document.readyState ? boot() : window.addEventListener("DOMContentLoaded", boot)
  }

  /** Language to render in: the visitor's browser language when auto-detect is on, else the configured one. */
  function getActiveLanguage() {
    if (autoDetectLanguage) {
      var browserLang = (navigator.language || navigator.userLanguage || "en").split("-")[0].toLowerCase();
      return TRANSLATIONS[browserLang] ? browserLang : "en"
    }
    return configuredLanguage
  }

  /** Translate a key, falling back to English and then to a hard-coded default for title/description. */
  function translate(key) {
    var lang = getActiveLanguage();
    var bundle = TRANSLATIONS[lang] || TRANSLATIONS.en;
    var value = null != bundle[key] ? bundle[key] : null != TRANSLATIONS.en[key] ? TRANSLATIONS.en[key] : "";
    return "" === value && "title" === key ? "We value your privacy" : "" === value && "description" === key ? "We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you." : value
  }

  /** Translate a button label. Anything over 80 chars is not a real label — fall back to English. */
  function translateButton(key) {
    var lang = getActiveLanguage();
    var value = (TRANSLATIONS[lang] || TRANSLATIONS.en)[key];
    value && value.length > 80 && (value = TRANSLATIONS.en[key] || key);
    return value || TRANSLATIONS.en[key] || key
  }

  function truncate(value, maxLength) {
    var text = null == value ? "" : String(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text
  }

  function translateTruncated(key, maxLength) {
    return truncate(translate(key), maxLength)
  }

  /**
   * Feature flags live in TRANSLATIONS.config, with the per-language bundle as a
   * legacy fallback. All four default to enabled when unset or unparseable.
   */
  function isCookiePolicyLinkEnabled() {
    try {
      var lang = getActiveLanguage();
      var config = TRANSLATIONS.config || {};
      var value = config.cookiePolicyLinkEnabled != null ? config.cookiePolicyLinkEnabled : (TRANSLATIONS[lang] || TRANSLATIONS.en || {}).cookiePolicyLinkEnabled;
      return false !== value && "0" !== value && "false" !== String(value).toLowerCase()
    } catch (err) {
      return true
    }
  }

  function isCloseButtonEnabled() {
    try {
      var lang = getActiveLanguage();
      var config = TRANSLATIONS.config || {};
      var value = config.closeButtonEnabled != null ? config.closeButtonEnabled : (TRANSLATIONS[lang] || TRANSLATIONS.en || {}).closeButtonEnabled;
      return true === value || 1 === value || false !== value && "0" !== value && "false" !== String(value).toLowerCase()
    } catch (err) {
      return true
    }
  }

  function isRejectButtonEnabled() {
    try {
      var lang = getActiveLanguage();
      var config = TRANSLATIONS.config || {};
      var value = config.rejectButtonEnabled != null ? config.rejectButtonEnabled : (TRANSLATIONS[lang] || TRANSLATIONS.en || {}).rejectButtonEnabled;
      return true === value || 1 === value || false !== value && "0" !== value && "false" !== String(value).toLowerCase()
    } catch (err) {
      return true
    }
  }

  function isCustomizeButtonEnabled() {
    try {
      var lang = getActiveLanguage();
      var config = TRANSLATIONS.config || {};
      var value = config.customizeButtonEnabled != null ? config.customizeButtonEnabled : (TRANSLATIONS[lang] || TRANSLATIONS.en || {}).customizeButtonEnabled;
      return true === value || 1 === value || false !== value && "0" !== value && "false" !== String(value).toLowerCase()
    } catch (err) {
      return true
    }
  }

  /** Collapse the dashboard's position values (incl. legacy spellings) to one of three corners. */
  function normalizeBannerPosition(raw) {
    var position = String(raw || "bottom-left").trim().toLowerCase().replace(/_/g, "-");
    return "bottom-right" === position || "right" === position ? "bottom-right" : "bottom" === position || "bottom-center" === position ? "bottom" : "bottom-left"
  }

  /**
   * Reserve space for the floating logo so it never overlaps the banner.
   * A corner box gets a margin; a full-width bar gets padding on the logo's side.
   */
  function applyFloatingLogoOffset(bannerEl) {
    if (bannerEl) {
      bannerEl.style.marginLeft = "";
      bannerEl.style.marginRight = "";
      bannerEl.style.paddingLeft = "";
      bannerEl.style.paddingRight = "";
      if (isFloatingLogoEnabled()) {
        var layout = bannerLayoutVisual || "box";
        var position = normalizeBannerPosition(customization && customization.position);
        var logoSide = getFloatingLogoPosition();
        var offset = "56px";
        "banner" !== layout ? "left" === logoSide ? "bottom-center" !== layout && "popup" !== layout && "bottom" !== position || (bannerEl.style.marginLeft = offset) : "bottom-center" !== layout && "popup" !== layout && "bottom" !== position || (bannerEl.style.marginRight = offset) : "left" === logoSide ? bannerEl.style.paddingLeft = offset : bannerEl.style.paddingRight = offset
      }
    }
  }

  /**
   * Position the initial banner for the current layout, corner setting and viewport.
   * Returns true when the banner ended up horizontally centered — the caller uses that
   * to pick the matching entrance animation (centered banners animate differently).
   */
  function positionInitialBanner(bannerEl) {
    if (!bannerEl) return false;
    var layout = bannerLayoutVisual || "box";
    var position = normalizeBannerPosition(customization && customization.position);
    bannerEl.style.left = "";
    bannerEl.style.right = "";
    bannerEl.style.top = "";
    bannerEl.style.bottom = "";
    bannerEl.style.transform = "";
    bannerEl.style.width = "";
    bannerEl.style.maxWidth = "";
    bannerEl.style.marginLeft = "";
    bannerEl.style.marginRight = "";
    bannerEl.style.paddingLeft = "";
    bannerEl.style.paddingRight = "";

    // Full-width bar pinned to the bottom edge.
    if ("banner" === layout) {
      bannerEl.style.left = "0";
      bannerEl.style.right = "0";
      bannerEl.style.bottom = "0";
      bannerEl.style.transform = "none";
      bannerEl.style.width = "100%";
      bannerEl.style.maxWidth = "none";
      bannerEl.setAttribute("data-cb-initial-centered", "0");
      applyFloatingLogoOffset(bannerEl);
      return false
    }

    // Mobile: always edge-to-edge along the bottom, regardless of the configured corner.
    if (window.innerWidth <= 660) {
      bannerEl.style.setProperty("left", "0", "important");
      bannerEl.style.setProperty("right", "0", "important");
      bannerEl.style.setProperty("bottom", "0", "important");
      bannerEl.style.setProperty("transform", "none", "important");
      bannerEl.style.setProperty("width", "100vw", "important");
      bannerEl.style.setProperty("max-width", "100vw", "important");
      bannerEl.style.setProperty("min-width", "0", "important");
      bannerEl.style.setProperty("border-radius", "0", "important");
      bannerEl.style.setProperty("border-left", "none", "important");
      bannerEl.style.setProperty("border-right", "none", "important");
      bannerEl.style.setProperty("border-bottom", "none", "important");
      bannerEl.setAttribute("data-cb-initial-centered", "0");
      return false
    }

    // Centered card above the bottom edge.
    if ("bottom-center" === layout || "popup" === layout || "bottom" === position) {
      bannerEl.style.bottom = "32px";
      bannerEl.style.left = "50%";
      bannerEl.style.transform = "translateX(-50%)";
      bannerEl.setAttribute("data-cb-initial-centered", "1");
      applyFloatingLogoOffset(bannerEl);
      return true
    }

    // Corner card.
    bannerEl.style.bottom = "32px";
    "bottom-right" === position ? bannerEl.style.right = "32px" : bannerEl.style.left = "32px";
    bannerEl.style.transform = "none";
    bannerEl.setAttribute("data-cb-initial-centered", "0");
    applyFloatingLogoOffset(bannerEl);
    return false
  }

  /** Strip the fragment, query and path so only the host part of a bare URL remains. */
  function extractHostname(value) {
    var host = value;
    var cut = host.indexOf("#");
    cut >= 0 && (host = host.slice(0, cut));
    (cut = host.indexOf("?")) >= 0 && (host = host.slice(0, cut));
    (cut = host.indexOf("/")) >= 0 && (host = host.slice(0, cut));
    return host.trim()
  }

  /** True when the string ends in a known file extension — i.e. it is a filename, not a hostname. */
  function looksLikeFilename(value) {
    var dot = value.lastIndexOf(".");
    if (dot < 0) return false;
    var ext = value.slice(dot).toLowerCase();
    return ".js" === ext || ".mjs" === ext || ".css" === ext || ".png" === ext || ".jpg" === ext || ".jpeg" === ext || ".gif" === ext || ".svg" === ext || ".webp" === ext || ".pdf" === ext || ".json" === ext || ".xml" === ext || ".ico" === ext || ".woff" === ext || ".woff2" === ext
  }

  /**
   * Turn whatever the site owner typed into the privacy-policy field into a usable href:
   * absolute URLs and mailto:/tel: pass through, protocol-relative gets https:, relative
   * paths resolve against the page, and a bare "example.com/privacy" gets https:// prefixed.
   */
  function normalizeUrl(raw) {
    if (!raw || "string" != typeof raw) return "";
    var url = raw.trim();
    if (!url) return "";
    var lower = url.toLowerCase();
    if (0 === lower.indexOf("mailto:") || 0 === lower.indexOf("tel:")) return url;
    if (0 === lower.indexOf("http://") || 0 === lower.indexOf("https://")) return url;
    if (0 === url.indexOf("//")) return "https:" + url;
    if ("/" === url.charAt(0) || 0 === url.indexOf("./") || 0 === url.indexOf("../")) {
      try {
        if ("undefined" != typeof window && window.location) return new URL(url, window.location.href).href
      } catch (err) {}
      return url
    }
    var host = extractHostname(url);
    if (host.indexOf(".") > 0 && !looksLikeFilename(host)) {
      for (; url.length > 0 && "/" === url.charAt(0);) url = url.slice(1);
      return "https://" + url
    }
    try {
      if ("undefined" != typeof window && window.location) return new URL(url, window.location.href).href
    } catch (err) {}
    return url
  }

  /**
   * Point an anchor at an external URL. The capture-phase handler opens the link
   * itself so a host page that swallows clicks inside the banner cannot break it.
   */
  function bindExternalLink(anchorEl, rawUrl) {
    var href = normalizeUrl(rawUrl);
    if (href) {
      anchorEl.href = href;
      anchorEl.target = "_blank";
      anchorEl.rel = "noopener noreferrer";
      anchorEl.addEventListener("click", function (event) {
        event.stopPropagation && event.stopPropagation();
        event.preventDefault && event.preventDefault();
        try {
          window.open(href, "_blank", "noopener,noreferrer")
        } catch (err) {}
      }, true)
    }
  }

  /**
   * Read the stored consent decision. An expired decision (past expiresAt, or older
   * than cookieExpirationDays when no expiresAt was stored) counts as no decision,
   * so the banner comes back.
   */
  function loadConsentState() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      var state = stored ? JSON.parse(stored) : {
        accepted: false,
        timestamp: null
      };
      if (!state || !state.accepted) return state || {
        accepted: false,
        timestamp: null
      };
      var now = Date.now();
      var lifetimeMs = 24 * cookieExpirationDays * 60 * 60 * 1000;
      var expiresAt = state.expiresAt ? new Date(state.expiresAt).getTime() : state.timestamp ? new Date(state.timestamp).getTime() + lifetimeMs : 0;
      return expiresAt > 0 && now > expiresAt ? {
        accepted: false,
        timestamp: null
      } : state
    } catch (err) {
      return {
        accepted: false,
        timestamp: null
      }
    }
  }

  /** Persist a decision, clear the "dismissed" marker, and release any scripts it now allows. */
  function saveConsentState(state) {
    try {
      var lifetimeMs = 24 * cookieExpirationDays * 60 * 60 * 1000;
      state.expiresAt = state.expiresAt || new Date(Date.now() + lifetimeMs).toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.removeItem(STORAGE_KEY + "_closed")
    } catch (err) {
    }
    consentState = state;
    try {
      unblockAllowedScripts()
    } catch (err) {
    }
  }

  /** Remember the toggle states so the preferences panel reopens pre-filled. */
  function savePreferenceCategories(categories) {
    try {
      var toStore = {
        analytics: !!categories.analytics,
        preferences: !!categories.preferences,
        marketing: !!categories.marketing
      };
      var encoded = btoa(JSON.stringify(toStore));
      localStorage.setItem(PREFS_STORAGE_KEY, encoded)
    } catch (err) {
    }
  }

  function loadPreferenceCategories() {
    try {
      var encoded = localStorage.getItem(PREFS_STORAGE_KEY);
      if (!encoded) return null;
      var decoded = JSON.parse(atob(encoded));
      return decoded && "object" == typeof decoded ? {
        analytics: !!decoded.analytics,
        preferences: !!decoded.preferences,
        marketing: !!decoded.marketing
      } : null
    } catch (err) {
      return null
    }
  }

  /** Fire-and-forget the consent decision to the API for the audit log. */
  function postConsentToApi(state, options) {
    if (siteId && apiBase) {
      options = options || {};
      var expiresAt = state && state.expiresAt || options.expiresAt || new Date(Date.now() + 24 * cookieExpirationDays * 60 * 60 * 1000).toISOString();
      var payload = {
        siteId: siteId,
        regulation: "gdpr" === bannerType ? "gdpr" : "ccpa",
        bannerType: bannerType,
        consentMethod: options.consentMethod || "banner",
        status: options.status || "given",
        expiresAt: expiresAt,
        consent: state
      };
      try {
        fetch(apiBase + "/api/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        }).catch(function (err) {
        })
      } catch (err) {
      }
    }
  }

  /** True when this site already blew its monthly pageview quota (cached per calendar month). */
  function isPageviewOverLimit() {
    try {
      var stored = localStorage.getItem(PAGEVIEW_LIMIT_KEY);
      if (!stored) return false;
      var record = JSON.parse(stored);
      var now = new Date;
      var yearMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      return record.yearMonth === yearMonth && true === record.overLimit
    } catch (err) {
      return false
    }
  }

  function markPageviewOverLimit(yearMonth) {
    try {
      localStorage.setItem(PAGEVIEW_LIMIT_KEY, JSON.stringify({
        overLimit: true,
        yearMonth: yearMonth
      }))
    } catch (err) {}
  }

  /** Report a pageview, and cache an over-limit response so we stop reporting this month. */
  function recordPageview() {
    if (siteId && apiBase && !isPageviewOverLimit()) try {
      var payload = {
        siteId: siteId,
        pageUrl: "undefined" != typeof window && window.location ? window.location.href : null
      };
      fetch(apiBase + "/api/pageview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        keepalive: true
      }).then(function (response) {
        return response.json()
      }).then(function (result) {
        if (result && result.overLimit) {
          var now = new Date;
          markPageviewOverLimit(result.yearMonth || now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0"))
        }
      }).catch(function (err) {
      })
    } catch (err) {
    }
  }

  /** All cookies currently set on the page, as raw "name=value" strings. */
  function getCookieList() {
    try {
      var raw = "undefined" != typeof document && document.cookie ? document.cookie : "";
      return raw ? raw.split(";").map(function (cookie) {
        return cookie.trim()
      }).filter(Boolean) : []
    } catch (err) {
      return []
    }
  }

  /** Every third-party script src on the page (our own scripts excluded). */
  function getThirdPartyScriptSrcs() {
    try {
      var srcs = [];
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src;
        src && -1 === src.indexOf("consentbit") && -1 === src.indexOf("client_data") && srcs.push(src)
      }
      return srcs
    } catch (err) {
      return []
    }
  }

  /** Best-effort category for a script URL, by well-known vendor host. */
  function guessScriptCategory(src) {
    try {
      var host = new URL(src).hostname;
      return -1 !== host.indexOf("google-analytics.com") || -1 !== src.indexOf("gtag/js") || -1 !== host.indexOf("googletagmanager.com") ? "analytics" : -1 !== host.indexOf("facebook.com") || -1 !== host.indexOf("fbcdn.net") || -1 !== host.indexOf("doubleclick.net") || 0 === host.indexOf("ads.") ? "marketing" : -1 !== host.indexOf("hotjar.com") || -1 !== host.indexOf("intercom.io") || -1 !== host.indexOf("fullstory.com") ? "behavioral" : "uncategorized"
    } catch (err) {
      return "uncategorized"
    }
  }

  /** Script elements with a src, de-duplicated by URL. */
  function getUniqueScriptElements() {
    var seenSrcs = {};
    var unique = [];
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var script = scripts[i];
      if (script.src && !seenSrcs[script.src]) {
        seenSrcs[script.src] = true;
        unique.push(script)
      }
    }
    return unique
  }

  /** True when the page carries a GA/GTM tag — including one we have already blocked. */
  function hasGoogleTagScript() {
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var script = scripts[i];
      var src = script.src || script.getAttribute("data-cb-blocked-src") || "";
      if (-1 !== src.indexOf("googletagmanager.com/gtag/js") || -1 !== src.indexOf("googletagmanager.com/gtm.js") || -1 !== src.indexOf("google-analytics.com")) return true
    }
    return false
  }

  /** Categories that require consent. Anything else ("essential", "uncategorized") is never blocked. */
  function isBlockableCategory(category) {
    return "analytics" === category || "marketing" === category || "behavioral" === category || "advertisement" === category || "functional" === category || "performance" === category
  }

  function isGoogleAnalyticsUrl(src) {
    if (!src || "string" != typeof src) return false;
    var lower = src.toLowerCase();
    return -1 !== lower.indexOf("googletagmanager.com/gtag/js") || -1 !== lower.indexOf("googletagmanager.com/gtm.js") || -1 !== lower.indexOf("google-analytics.com")
  }

  /**
   * Has the visitor allowed this category?
   * Under CCPA (opt-out) everything is allowed until they choose "Do Not Sell".
   * Under GDPR (opt-in) nothing beyond "essential" is allowed until they consent.
   */
  function isCategoryAllowed(category) {
    var normalized = category;
    "behavioral" === normalized && (normalized = "analytics");
    if ("essential" === normalized) return true;
    if ("ccpa" === bannerType) {
      return !(consentState && consentState.accepted && consentState.ccpa && consentState.ccpa.doNotSell && isBlockableCategory(normalized))
    }
    if (!consentState || !consentState.accepted) return false;
    var categories = consentState.categories || {};
    return "analytics" === normalized ? !!categories.analytics : "marketing" === normalized || "advertisement" === normalized ? !!categories.marketing : "preferences" !== normalized && "functional" !== normalized && "performance" !== normalized || !!categories.preferences
  }

  /** True only when EVERY category in a comma-separated list is allowed. */
  function areCategoriesAllowed(categoryList) {
    if (!categoryList) return false;
    var parts = String(categoryList).split(",");
    for (var i = 0; i < parts.length; i++) {
      var category = String(parts[i] || "").toLowerCase().trim();
      if (!category) continue;
      if ("personalization" === category) category = "preferences";
      if (!isCategoryAllowed(category)) return false
    }
    return true
  }

  /**
   * Map a category name from any vendor's vocabulary (CookieYes, GTM, our own) onto
   * one of our four buckets. Returns null when nothing matches.
   */
  function mapToKnownCategories(raw) {
    if (!raw) return null;
    var category = String(raw).toLowerCase().trim();
    if ("analytics" === category || "marketing" === category || "behavioral" === category || "preferences" === category || "essential" === category) return ["essential" === category ? "essential" : category];
    return category.indexOf("necessary") >= 0 || category.indexOf("essential") >= 0 ? ["essential"] : category.indexOf("functional") >= 0 || category.indexOf("preference") >= 0 ? ["preferences"] : category.indexOf("analytics") >= 0 || category.indexOf("performance") >= 0 || category.indexOf("statistics") >= 0 ? ["analytics"] : category.indexOf("advertisement") >= 0 || category.indexOf("marketing") >= 0 || category.indexOf("ads") >= 0 || category.indexOf("social") >= 0 ? ["marketing"] : category.indexOf("other") >= 0 ? ["analytics"] : null
  }

  /**
   * Work out which consent categories a script belongs to. Explicit markup on the
   * element wins (our own data-consentbit* attributes, then CookieYes'); otherwise we
   * match the URL against the worker-supplied provider rules and then the site owner's
   * custom rules. An empty array means "unknown" — and unknown scripts are never blocked.
   */
  function resolveScriptCategories(src, scriptEl) {
    if (scriptEl && scriptEl.getAttribute) {
      var tagged = mapToKnownCategories(scriptEl.getAttribute("data-consentbit"));
      if (tagged) return tagged;

      // In Webflow mode the data-category attribute belongs to Webflow, so we only read our own.
      var categoryAttr = scriptEl.getAttribute("data-consentbit-category");
      if (!categoryAttr && !window.__CB_WEBFLOW_MODE__) categoryAttr = scriptEl.getAttribute("data-category");
      if (categoryAttr) {
        var resolved = [];
        var declared = String(categoryAttr).split(",");
        for (var i = 0; i < declared.length; i++) {
          var name = String(declared[i] || "").toLowerCase().trim();
          if (!name) continue;
          var mapped = mapToKnownCategories("personalization" === name ? "preferences" : name);
          if (mapped)
            for (var j = 0; j < mapped.length; j++)
              if (resolved.indexOf(mapped[j]) === -1) resolved.push(mapped[j]);
        }
        if (resolved.length) return resolved
      }

      var cookieYes = mapToKnownCategories(scriptEl.getAttribute("data-cookieyes"));
      if (cookieYes) return cookieYes
    }

    if (src && scriptBlockProviders.length)
      for (var p = 0; p < scriptBlockProviders.length; p++) {
        var provider = scriptBlockProviders[p];
        if (provider && provider.pattern) try {
          if (new RegExp(provider.pattern, "i").test(src)) return provider.categories && provider.categories.length ? provider.categories.slice() : ["analytics"]
        } catch (err) {}
      }

    if (src && customCookieRules.length)
      for (var c = 0; c < customCookieRules.length; c++) {
        var rule = customCookieRules[c];
        if (rule && rule.scriptUrlPattern) try {
          if (new RegExp(rule.scriptUrlPattern, "i").test(src)) return [rule.category || "uncategorized"]
        } catch (err) {}
      }

    return []
  }

  /**
   * Should this script be prevented from running right now?
   * Note the GA/GTM exemption: Google tags are allowed to load and are gated by
   * Google Consent Mode instead of being hard-blocked.
   */
  function shouldBlockScript(src, scriptEl) {
    if (isInjectingScript) return false;
    if (!src || "string" != typeof src) return false;
    var lower = src.toLowerCase();
    if (-1 !== lower.indexOf("consentbit") || -1 !== lower.indexOf("client_data")) return false;
    var categories = resolveScriptCategories(src, scriptEl);
    if (!categories || 0 === categories.length) return false;
    if ("ccpa" === bannerType) return !!(consentState && consentState.accepted && consentState.ccpa && consentState.ccpa.doNotSell);
    for (var i = 0; i < categories.length; i++) {
      var category = categories[i];
      if (isBlockableCategory(category) && !("analytics" === category && isGoogleAnalyticsUrl(src) || isCategoryAllowed(category))) return true
    }
    return false
  }

  /** Sniff an untagged inline script for a known tracking pixel's call signature. */
  function detectInlineScriptCategory(content) {
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

  /**
   * Neutralise a script element in place.
   * External: stash the src in data-cb-blocked-src and set an unknown type, so the
   * browser never fetches it. Inline: stash the source on the element and blank the
   * body. Both are restored later by unblockAllowedScripts().
   */
  function blockScriptElement(scriptEl) {
    if (scriptEl && "SCRIPT" === scriptEl.nodeName && (!scriptEl.getAttribute || "javascript/blocked" !== scriptEl.getAttribute("type"))) {
      var src = scriptEl.getAttribute && scriptEl.getAttribute("src") || scriptEl.src || "";
      if (src) {
        if (shouldBlockScript(src, scriptEl)) try {
          scriptEl.setAttribute("data-cb-blocked-src", src);
          scriptEl.setAttribute("type", "javascript/blocked");
          scriptEl.removeAttribute("src")
        } catch (err) {}
      } else {
        var inlineCategory = (scriptEl.getAttribute && (scriptEl.getAttribute("data-consentbit-category") || (!window.__CB_WEBFLOW_MODE__ && scriptEl.getAttribute("data-category")))) || detectInlineScriptCategory(scriptEl.textContent || "");
        if (inlineCategory && !isCategoryAllowed(inlineCategory)) try {
          scriptEl.__ci = scriptEl.textContent || "";
          // Go through the native setter: our own patched one would re-block instead of clearing.
          var textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
          textContentDescriptor && textContentDescriptor.set ? textContentDescriptor.set.call(scriptEl, "") : (scriptEl.textContent = "");
          scriptEl.setAttribute("type", "javascript/blocked");
          scriptEl.setAttribute("data-cb-inline", "1");
        } catch(err) {}
      }
    }
  }

  /**
   * Intercept a freshly created <script> before anything is assigned to it, so a
   * blocked src/textContent never reaches the DOM in the first place. Assigning
   * assigning type on a blocked script cannot un-block it either.
   */
  function patchScriptElement(scriptEl) {
    if (scriptEl && !scriptEl.__cp) {
      scriptEl.__cp = true;
      try {
        Object.defineProperty(scriptEl, "src", {
          configurable: true,
          enumerable: true,
          get: function () {
            return scriptEl.getAttribute("src") || ""
          },
          set: function (value) {
            if (shouldBlockScript(value, scriptEl)) {
              scriptEl.setAttribute("data-cb-blocked-src", value);
              scriptEl.setAttribute("type", "javascript/blocked");
              scriptEl.removeAttribute("src")
            } else scriptEl.setAttribute("src", value)
          }
        })
      } catch (err) {}
      try {
        Object.defineProperty(scriptEl, "type", {
          configurable: true,
          enumerable: true,
          get: function () {
            return scriptEl.getAttribute("type") || ""
          },
          set: function (value) {
            var type = value;
            shouldBlockScript(scriptEl.getAttribute("src") || scriptEl.src || "", scriptEl) && (type = "javascript/blocked");
            scriptEl.setAttribute("type", type)
          }
        })
      } catch (err) {}
      try {
        var textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
        if (textContentDescriptor && textContentDescriptor.set) {
          var nativeTextContentSetter = textContentDescriptor.set;
          Object.defineProperty(scriptEl, "textContent", {
            configurable: true,
            get: function() { return textContentDescriptor.get ? textContentDescriptor.get.call(scriptEl) : ""; },
            set: function(value) {
              var category = (scriptEl.getAttribute && (scriptEl.getAttribute("data-consentbit-category") || (!window.__CB_WEBFLOW_MODE__ && scriptEl.getAttribute("data-category")))) || detectInlineScriptCategory(value);
              if (category && !isCategoryAllowed(category)) {
                scriptEl.__ci = value;
                scriptEl.setAttribute("type", "javascript/blocked");
                scriptEl.setAttribute("data-cb-inline", "1");
              } else {
                nativeTextContentSetter.call(scriptEl, value);
              }
            }
          });
        }
      } catch (err) {}
    }
  }

  /** Block a newly inserted node — the script itself, or any scripts inside a subtree. */
  function scanNodeForScripts(node) {
    if (node && 1 === node.nodeType)
      if ("SCRIPT" !== node.nodeName) {
        if (node.querySelectorAll) {
          var scripts = node.querySelectorAll("script[src]");
          for (var i = 0; i < scripts.length; i++) blockScriptElement(scripts[i])
        }
      } else blockScriptElement(node)
  }

  /**
   * Re-run every blocked script that the current consent now allows.
   * Three kinds are restored: external scripts we neutralised (data-cb-blocked-src),
   * scripts the site author parked as type="text/plain" with a category attribute, and
   * inline scripts whose source we stashed on the element.
   *
   * A blocked script cannot simply be re-enabled in place — the browser will not
   * re-evaluate an existing element — so each one is rebuilt as a fresh <script> and
   * swapped in. isInjectingScript suppresses the blocker while we do that.
   *
   * In Webflow mode script blocking is owned by the Webflow setup script, so we just
   * broadcast the new consent and let it react.
   */
  function unblockAllowedScripts(categoriesOverride) {
    if (window.__CB_WEBFLOW_MODE__) dispatchWebflowConsent(categoriesOverride || (consentState && consentState.categories) || {
      analytics: true,
      marketing: true,
      preferences: true,
      essential: true
    });
    else {
      // 1. External scripts we blocked earlier.
      var blockedScripts = document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');
      for (var i = 0; i < blockedScripts.length; i++) {
        var blocked = blockedScripts[i];
        var blockedSrc = blocked.getAttribute("data-cb-blocked-src");
        if (blockedSrc)
          if (!shouldBlockScript(blockedSrc, blocked)) {
            isInjectingScript = true;
            try {
              var revived = document.createElement("script");
              revived.async = blocked.hasAttribute("async");
              revived.defer = blocked.hasAttribute("defer");
              revived.crossOrigin = blocked.crossOrigin || "";
              revived.integrity = blocked.integrity || "";
              revived.referrerPolicy = blocked.referrerPolicy || "";
              blocked.id && (revived.id = blocked.id);
              revived.src = blockedSrc;
              var attrs = blocked.attributes;
              for (var a = 0; a < attrs.length; a++) {
                var attrName = attrs[a].name;
                "src" !== attrName && "type" !== attrName && "data-cb-blocked-src" !== attrName && revived.setAttribute(attrName, attrs[a].value)
              }
              blocked.parentNode ? blocked.parentNode.replaceChild(revived, blocked) : document.head.appendChild(revived);
            } catch (err) {
            } finally {
              isInjectingScript = false
            }
          }
      }

      // 2. Scripts the site author parked as type="text/plain" with a category attribute.
      var parkedScripts = document.querySelectorAll('script[type="text/plain"][data-consentbit-category],script[type="text/plain"][data-category]');
      for (var p = 0; p < parkedScripts.length; p++) {
        var parked = parkedScripts[p];
        var parkedCategories = parked.getAttribute("data-consentbit-category") || parked.getAttribute("data-category");
        if (parkedCategories && areCategoriesAllowed(parkedCategories)) {
          isInjectingScript = true;
          try {
            var activated = document.createElement("script");
            activated.async = parked.hasAttribute("async");
            activated.defer = parked.hasAttribute("defer");
            var parkedSrc = parked.getAttribute("src") || "";
            if (parkedSrc) activated.src = parkedSrc;
            else activated.textContent = parked.textContent;
            var parkedAttrs = parked.attributes;
            for (var pa = 0; pa < parkedAttrs.length; pa++) {
              var parkedAttrName = parkedAttrs[pa].name;
              if (parkedAttrName !== "type" && parkedAttrName !== "src" && parkedAttrName !== "data-consentbit-category" && parkedAttrName !== "data-category") activated.setAttribute(parkedAttrName, parkedAttrs[pa].value);
            }
            parked.parentNode ? parked.parentNode.replaceChild(activated, parked) : document.head.appendChild(activated);
          } catch(err) {
          } finally {
            isInjectingScript = false;
          }
        }
      }

      // 3. Inline scripts we emptied — their source is stashed on the element as __ci.
      var blockedInline = document.querySelectorAll('script[type="javascript/blocked"][data-cb-inline="1"]');
      for (var b = 0; b < blockedInline.length; b++) {
        var inlineEl = blockedInline[b];
        var inlineSource = inlineEl.__ci || "";
        var inlineCategories = (inlineEl.getAttribute && (inlineEl.getAttribute("data-consentbit-category") || inlineEl.getAttribute("data-category"))) || detectInlineScriptCategory(inlineSource);
        if (inlineCategories && areCategoriesAllowed(inlineCategories)) {
          isInjectingScript = true;
          try {
            var revivedInline = document.createElement("script");
            if (inlineSource) revivedInline.textContent = inlineSource;
            inlineEl.parentNode ? inlineEl.parentNode.replaceChild(revivedInline, inlineEl) : document.head.appendChild(revivedInline);
          } catch(err) {
          } finally {
            isInjectingScript = false;
          }
        }
      }
    }
  }

  /**
   * Expire a cookie. We cannot know which domain/path it was set on, so we blanket-expire
   * it across every plausible combination (bare host, dot-prefixed, www, root path, current path).
   */
  function deleteCookie(name) {
    var host = window.location.hostname;
    var bareHost = host.indexOf("www.") === 0 ? host.slice(4) : host;
    var domains = [null, host, "." + host, bareHost, "." + bareHost, "www." + bareHost, ".www." + bareHost];
    var paths = ["/", window.location.pathname];
    var expiredDate = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (var d = 0; d < domains.length; d++)
      for (var p = 0; p < paths.length; p++) {
        var cookieValue = name + "=; expires=" + expiredDate + "; path=" + paths[p];
        if (domains[d]) cookieValue += "; domain=" + domains[d];
        try { document.cookie = cookieValue; } catch(err) {}
      }
  }

  /** Resolve a cookie-name pattern (exact, or a "_ga_*" prefix wildcard) against the cookies actually set. */
  function matchCookieNames(pattern) {
    var starIndex = pattern.indexOf("*");
    var prefix = starIndex >= 0 ? pattern.slice(0, starIndex) : null;
    var allNames = document.cookie.split(";").map(function(cookie) { return cookie.trim().split("=")[0]; });
    return prefix ? allNames.filter(function(cookieName) { return cookieName.startsWith(prefix); }) : (allNames.indexOf(pattern) >= 0 ? [pattern] : []);
  }

  /** Cookies known to be dropped by the trackers in each category. */
  var COOKIE_PATTERNS_BY_CATEGORY = {
    analytics: ["_ga", "_ga_*", "_gid", "_gat", "_gat_*", "_gac_*", "_hjid", "_hjSessionUser_*", "_hjSession_*", "_hjAbsoluteSessionInProgress", "_clck", "_clsk"],
    marketing: ["_fbp", "_fbc", "_gcl_au", "_gcl_ls", "_gcl_aw", "_ttp", "tt_webid_v2", "_pin_unauth", "_pinterest_ct_ua", "li_sugr", "bcookie", "bscookie", "lidc", "_uetsid", "_uetvid", "IDE", "test_cookie", "fr"],
    preferences: []
  };

  /**
   * Clear cookies already dropped by categories the visitor just declined — blocking the
   * script only stops future writes, so anything set before the decision must be removed.
   */
  function deleteCookiesForCategories(deniedCategories) {
    for (var category in COOKIE_PATTERNS_BY_CATEGORY) {
      if (deniedCategories.indexOf(category) >= 0) {
        var patterns = COOKIE_PATTERNS_BY_CATEGORY[category];
        for (var p = 0; p < patterns.length; p++) {
          var names = matchCookieNames(patterns[p]);
          for (var n = 0; n < names.length; n++) deleteCookie(names[n]);
        }
      }
    }
    // Plus any cookie the site owner declared in the dashboard.
    for (var r = 0; r < customCookieRules.length; r++) {
      var rule = customCookieRules[r];
      if (!rule || !rule.category || deniedCategories.indexOf(rule.category) < 0) continue;
      if (rule.name) deleteCookie(rule.name);
    }
  }

  /** Category for an iframe URL, by known tracker domain and then by the owner's custom rules. */
  function categoryForIframeUrl(src) {
    if (!src || "string" != typeof src) return null;
    var lower = src.toLowerCase();
    if (0 !== lower.indexOf("http")) return null;
    for (var i = 0; i < KNOWN_TRACKER_DOMAINS.length; i++)
      if (-1 !== lower.indexOf(KNOWN_TRACKER_DOMAINS[i].domain)) return KNOWN_TRACKER_DOMAINS[i].category;
    for (var r = 0; r < customCookieRules.length; r++) {
      var rule = customCookieRules[r];
      if (rule && rule.scriptUrlPattern) try {
        if (new RegExp(rule.scriptUrlPattern, "i").test(src)) return rule.category || "marketing"
      } catch (err) {}
    }
    return null
  }

  /** Unlike scripts, tracking iframes get no GA/GTM exemption — they are blocked outright. */
  function shouldBlockIframe(src) {
    if (!src || "string" != typeof src) return false;
    var lower = src.toLowerCase();
    if (-1 !== lower.indexOf("consentbit") || -1 !== lower.indexOf("client_data")) return false;
    var category = categoryForIframeUrl(src);
    return !(!category || !isBlockableCategory(category) || ("ccpa" === bannerType ? !(consentState && consentState.accepted && consentState.ccpa && consentState.ccpa.doNotSell) : consentState && consentState.accepted && isCategoryAllowed(category)))
  }

  /** Intercept src assignment on a freshly created iframe, same idea as patchScriptElement. */
  function patchIframeElement(iframeEl) {
    if (iframeEl && !iframeEl.__ip) {
      iframeEl.__ip = true;
      try {
        Object.defineProperty(iframeEl, "src", {
          configurable: true,
          enumerable: true,
          get: function () {
            return iframeEl.getAttribute("src") || ""
          },
          set: function (value) {
            if (shouldBlockIframe(value)) {
              iframeEl.setAttribute("data-cb-blocked-src", value);
              iframeEl.removeAttribute("src")
            } else iframeEl.setAttribute("src", value)
          }
        })
      } catch (err) {}
    }
  }

  /** Publish consent to the Webflow setup script, which owns script gating in Webflow mode. */
  function dispatchWebflowConsent(categories) {
    if (window.__CB_WEBFLOW_MODE__) {
      var detail = categories || {};
      window.userConsent = detail;
      try {
        document.dispatchEvent(new CustomEvent("consentUpdated", {
          detail: detail,
          bubbles: true
        }))
      } catch (err) {}
    }
  }

  /**
   * Install the script blocker: patch document.createElement so new script/iframe
   * elements are intercepted at birth, and watch the DOM for scripts inserted by
   * other means (parsed markup, innerHTML, a late src assignment).
   * Skipped in Webflow mode, where the Webflow setup script does this instead.
   */
  function installScriptBlocker() {
    if (!window.__CB_WEBFLOW_MODE__ && !window.__ce) {
      window.__ce = true;
      try {
        nativeCreateElement = document.createElement.bind(document)
      } catch (err) {
        nativeCreateElement = document.createElement
      }
      document.createElement = function (tagName) {
        var element = nativeCreateElement(tagName);
        var tag = String(tagName || "").toLowerCase();
        "script" === tag ? patchScriptElement(element) : tag === "iframe" && patchIframeElement(element);
        return element
      };

      var observer = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var mutation = mutations[m];
          if ("childList" === mutation.type) {
            var added = mutation.addedNodes;
            for (var n = 0; n < added.length; n++) scanNodeForScripts(added[n])
          } else "attributes" === mutation.type && "src" === mutation.attributeName && mutation.target && "SCRIPT" === mutation.target.nodeName && blockScriptElement(mutation.target)
        }
      });
      try {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["src"]
        })
      } catch (err) {
        // Older browsers reject attributeFilter without attributes — fall back to childList only.
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        })
      }
      window.__cm = observer
    }
  }

  /**
   * One-off sweep over the scripts already in the document at boot, blocking any that
   * consent does not currently allow. Google tags are left alone (Consent Mode gates
   * them instead), as is anything already blocked or in a non-blockable category.
   */
  function blockExistingScripts() {
    if (window.__CB_WEBFLOW_MODE__) try {
      document.dispatchEvent(new CustomEvent("cbBlockScripts", {
        detail: {},
        bubbles: true
      }))
    } catch (err) {} else {
      var scripts = getUniqueScriptElements();
      for (var i = 0; i < scripts.length; i++) {
        var script = scripts[i];
        var src = script.src;
        if ("javascript/blocked" !== script.getAttribute("type")) {
          var categories = resolveScriptCategories(src, script);
          var category = categories.length > 0 ? categories[0] : "uncategorized";
          if (isBlockableCategory(category))
            if ("analytics" === category && gaMeasurementId && isGoogleAnalyticsUrl(src)) {
              // We manage this GA tag through Consent Mode — leave it loading.
            } else if (isCategoryAllowed(category)) {
              // Consent already granted for this category.
            } else try {
              script.setAttribute("data-cb-blocked-src", src);
              script.setAttribute("type", "javascript/blocked");
              script.removeAttribute("src");
            } catch (err) {
            }
        }
      }
    }
  }

  /** Replay scripts held in the queue whose categories are now allowed; keep the rest queued. */
  function flushQueuedScripts() {
    if (queuedScripts.length) {
      var stillBlocked = [];
      isInjectingScript = true;
      try {
        for (var i = 0; i < queuedScripts.length; i++) {
          var queued = queuedScripts[i];
          var categories = queued.cats || (queued.category ? [queued.category] : []);
          if (0 === categories.length || categories.every(function (category) {
              return !isBlockableCategory(category) || isCategoryAllowed(category)
            })) {
            var script = document.createElement("script");
            script.src = queued.src;
            var attrs = queued.attrs;
            for (var attrName in attrs) Object.prototype.hasOwnProperty.call(attrs, attrName) && "src" !== attrName && script.setAttribute(attrName, attrs[attrName]);
            document.head.appendChild(script)
          } else stillBlocked.push(queued)
        }
      } finally {
        isInjectingScript = false
      }
      queuedScripts = stillBlocked
    }
  }

  /**
   * Load the site's GA tag ourselves (when the dashboard supplied a measurement ID and
   * the page does not already carry one) and push an all-denied Consent Mode default.
   * The actual consent state is applied right after, by updateGoogleConsentMode().
   */
  function bootstrapGoogleAnalytics() {
    if (gaMeasurementId) {
      isInjectingScript = true;
      try {
        var alreadyPresent = false;
        var scripts = document.scripts;
        for (var i = 0; i < scripts.length; i++) {
          var src = scripts[i].src || "";
          if (-1 !== src.indexOf("googletagmanager.com/gtag/js") || -1 !== src.indexOf("googletagmanager.com/gtm.js") || -1 !== src.indexOf("google-analytics.com")) {
            alreadyPresent = true;
            break
          }
        }
        if (!alreadyPresent) {
          var gaScript = document.createElement("script");
          gaScript.async = true;
          gaScript.src = "https://www.googletagmanager.com/gtag/js?id=" + gaMeasurementId;
          document.head.appendChild(gaScript)
        }
        window.dataLayer = window.dataLayer || [];

        function gtag() {
          dataLayer.push(arguments)
        }
        window.gtag = gtag;
        gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          functionality_storage: "denied",
          personalization_storage: "denied",
          security_storage: "granted",
          wait_for_update: 500
        });
        gtag("js", new Date);
        gtag("config", gaMeasurementId, {
          anonymize_ip: true
        });
        gtag("event", "page_view", {
          page_path: window.location.pathname,
          page_title: document.title || ""
        })
      } finally {
        isInjectingScript = false
      }
    }
  }

  /**
   * Push the visitor's category choices to Google Consent Mode.
   * gtag may not exist yet (the tag is still loading), so poll for up to 2s.
   */
  function updateGoogleConsentMode(categories, source) {
    if (gaMeasurementId || hasGoogleTagScript()) {
      var consentUpdate = {
        analytics_storage: categories.analytics ? "granted" : "denied",
        ad_storage: categories.marketing ? "granted" : "denied",
        ad_user_data: categories.marketing ? "granted" : "denied",
        ad_personalization: categories.marketing ? "granted" : "denied",
        functionality_storage: categories.preferences ? "granted" : "denied",
        personalization_storage: categories.preferences ? "granted" : "denied"
      };
      if (window.gtag) window.gtag("consent", "update", consentUpdate);
      else {
        var attempts = 0;
        var timer = setInterval(function () {
          attempts++;
          if (window.gtag) {
            clearInterval(timer);
            window.gtag("consent", "update", consentUpdate)
          } else if (attempts >= 20) {
            clearInterval(timer);
          }
        }, 100)
      }
    }
  }

  // CCPA consent mode: opt-out model — storage is granted unless the user opted out
  // ("Do Not Sell/Share"). Mirrors updateGoogleConsentMode() but keyed off a single
  // doNotSell flag rather than per-category toggles.
  function updateGoogleConsentModeCcpa(doNotSell) {
    if (gaMeasurementId || hasGoogleTagScript()) {
      var consentUpdate = {
        analytics_storage: doNotSell ? "denied" : "granted",
        ad_storage: doNotSell ? "denied" : "granted",
        ad_user_data: doNotSell ? "denied" : "granted",
        ad_personalization: doNotSell ? "denied" : "granted"
      };
      if (window.gtag) window.gtag("consent", "update", consentUpdate);
      else {
        var attempts = 0;
        var timer = setInterval(function () {
          attempts++;
          if (window.gtag) {
            clearInterval(timer);
            window.gtag("consent", "update", consentUpdate)
          } else if (attempts >= 20) {
            clearInterval(timer);
          }
        }, 100)
      }
    }
  }

  /**
   * Pick a legible foreground (near-black or white) for the given background colour,
   * using the ITU-R BT.601 luma formula. Accepts 3- or 6-digit hex.
   */
  function contrastingTextColor(backgroundColor) {
    var hex = String(backgroundColor).replace("#", "");
    if (3 === hex.length) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var red = parseInt(hex.substr(0, 2), 16) || 0;
    var green = parseInt(hex.substr(2, 2), 16) || 0;
    var blue = parseInt(hex.substr(4, 2), 16) || 0;
    return (0.299 * red + 0.587 * green + 0.114 * blue) > 128 ? "#0f172a" : "#ffffff";
  }

  /**
   * Build the stylesheet: BASE_CSS first, then the dashboard's colour/typography
   * overrides layered on top. Runs once — a #cb-styles element means we already did.
   */
  function injectStyles() {
    if (!document.getElementById("cb-styles")) {
      var saveAndCancelButtonCss = "#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{background-color:" + (customization && customization.saveButtonBg ? String(customization.saveButtonBg) : "#ffffff") + " !important;color:" + (customization && customization.saveButtonText ? String(customization.saveButtonText) : "#334155") + " !important;border-color:#e2e8f0 !important;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{background-color:" + (customization && customization.acceptButtonBg ? String(customization.acceptButtonBg) : "#ffffff") + " !important;color:" + (customization && customization.acceptButtonText ? String(customization.acceptButtonText) : "#334155") + " !important;border-color:" + (customization && customization.acceptButtonBg ? String(customization.acceptButtonBg) : "#e2e8f0") + " !important;}";

      var backgroundCss = "";
      if (customization && customization.backgroundColor) {
        var backgroundColor = String(customization.backgroundColor);
        backgroundCss = "#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{background-color:" + backgroundColor + " !important;}.cb-gdpr-accordion{background-color:" + backgroundColor + " !important;}"
      }

      var headingCss = "";
      if (customization && customization.headingColor) {
        var headingColor = String(customization.headingColor);
        headingCss = "#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{color:" + headingColor + " !important;}.cb-gdpr-cat-label{color:" + headingColor + " !important;}"
      }

      var textCss = "";
      if (customization && customization.textColor) {
        textCss = "#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{color:" + String(customization.textColor) + " !important;}"
      }

      var fontWeightCss = "";
      if (customization && customization.bannerFontWeight) {
        var fontWeight = String(customization.bannerFontWeight);
        fontWeightCss = "#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-weight:" + fontWeight + " !important;}.cb-gdpr-cat-label{font-weight:" + fontWeight + " !important;}.cb-gdpr-cat-desc{font-weight:" + fontWeight + " !important;}.cb-banner p{font-weight:" + fontWeight + " !important;}"
      }

      // Leave room for the close button in the preferences heading (CCPA has no such offset).
      var prefsHeadingCss = "#cb-preferences-banner.cb-banner h3{padding-right:36px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs h3{padding-right:0 !important;padding-top:16px !important;margin-bottom:14px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs .cb-banner-body>p{margin-bottom:16px !important;}";
      var prefsScrollbarCss = "#cb-preferences-banner.cb-banner .cb-banner-body{padding-right:4px;}#cb-preferences-banner.cb-banner .cb-gdpr-accordion > div{margin-right:2px;}";

      if (!document.getElementById("cb-font-montserrat")) {
        var fontLink = document.createElement("link");
        fontLink.id = "cb-font-montserrat";
        fontLink.rel = "stylesheet";
        fontLink.href = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap";
        document.head.appendChild(fontLink)
      }

      var acceptButtonCss = "";
      if (customization && customization.acceptButtonBg) {
        var acceptBg = String(customization.acceptButtonBg);
        var acceptText = customization.acceptButtonText ? String(customization.acceptButtonText) : "#ffffff";
        acceptButtonCss = ".cb-banner button#cb-accept-all-btn{background-color:" + acceptBg + " !important;color:" + acceptText + " !important;}#cb-initial-banner.cb-banner #cb-accept-all-btn{background:" + acceptBg + " !important;color:" + acceptText + " !important;}"
      }

      // Reject deliberately reuses the accept colours — the two buttons are styled identically.
      var rejectButtonCss = "";
      if (customization && customization.acceptButtonBg) {
        var rejectBg = String(customization.acceptButtonBg);
        var rejectText = customization.acceptButtonText ? String(customization.acceptButtonText) : "#ffffff";
        rejectButtonCss = ".cb-banner button#cb-reject-all-btn{background-color:" + rejectBg + " !important;color:" + rejectText + " !important;}#cb-initial-banner.cb-banner #cb-reject-all-btn{background:" + rejectBg + " !important;color:" + rejectText + " !important;}.cb-banner button#cb-prefs-reject-btn{background-color:" + rejectBg + " !important;color:" + rejectText + " !important;}"
      }

      var styleEl = document.createElement("style");
      styleEl.id = "cb-styles";
      styleEl.type = "text/css";

      var closeButtonCss = "";
      if (customization && customization.backgroundColor) {
        closeButtonCss = "#cb-close-initial-btn,#cb-close-prefs-btn{color:" + contrastingTextColor(customization.backgroundColor) + " !important;}"
      }

      styleEl.appendChild(document.createTextNode(BASE_CSS + "\\n" + saveAndCancelButtonCss + "\\n" + backgroundCss + "\\n" + headingCss + "\\n" + textCss + "\\n" + fontWeightCss + "\\n" + prefsHeadingCss + "\\n" + prefsScrollbarCss + "\\n" + acceptButtonCss + "\\n" + rejectButtonCss + "\\n" + closeButtonCss));
      document.head.appendChild(styleEl)
    }
  }

  /** Close (×) button for the initial banner. */
  function appendCloseButton(container, buttonId) {
    if (isCloseButtonEnabled()) {
      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.id = buttonId;
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.textContent = "×";
      var color = "#0f172a";
      if (customization && customization.backgroundColor) {
        color = contrastingTextColor(customization.backgroundColor);
      }
      closeBtn.style.cssText = "position:absolute;top:8px;right:24px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:" + color + ";opacity:0.75;";
      container.appendChild(closeBtn)
    }
  }

  /** Close (×) button for the preferences panel — same as above, nudged 6px further in. */
  function appendPrefsCloseButton(container) {
    if (isCloseButtonEnabled()) {
      var closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.id = "cb-close-prefs-btn";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.textContent = "×";
      var color = "#0f172a";
      if (customization && customization.backgroundColor) {
        color = contrastingTextColor(customization.backgroundColor);
      }
      closeBtn.style.cssText = "position:absolute;top:8px;right:30px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:" + color + ";opacity:0.75;";
      container.appendChild(closeBtn)
    }
  }

  /** Entrance-animation class for the initial banner, given whether it sits centered. */
  function getInitialBannerAnimationClass(isCentered) {
    return isCentered
      ? "slide-up" === entranceAnimation ? "cb-banner-animate-initial-center-bottom" : "slide-down" === entranceAnimation ? "cb-banner-animate-initial-center-top" : "zoom-in" === entranceAnimation ? "cb-banner-animate-initial-center-zoom" : "cb-banner-animate-fade"
      : "slide-up" === entranceAnimation ? "cb-banner-animate-bottom" : "slide-down" === entranceAnimation ? "cb-banner-animate-top" : "zoom-in" === entranceAnimation ? "cb-banner-animate-zoom-in" : "cb-banner-animate-fade";
  }

  /**
   * Build both banners (initial + preferences) and attach them to the page.
   * The CCPA variant is a single "Do Not Sell" opt-out; the GDPR variant is the
   * accept/reject/customise flow with a per-category accordion. Handlers are wired
   * up separately, in initBannerUi().
   */
  function buildBanners() {
    if (!document.getElementById("cb-initial-banner"))
      if (document.body) {
        var isCcpa = "ccpa" === bannerType;
        var wrapper = document.createElement("div");

        if (isCcpa) {
          // ---- CCPA initial banner ------------------------------------------------
          var initialBanner = document.createElement("div");
          initialBanner.className = "cb-banner";
          initialBanner.id = "cb-initial-banner";
          initialBanner.style.display = "none";

          var initialBody = document.createElement("div");
          initialBody.className = "cb-banner-body";

          var initialHeading = document.createElement("h3");
          initialHeading.textContent = translateTruncated("title", MAX_TITLE_LEN);
          initialBody.appendChild(initialHeading);

          var initialText = document.createElement("p");
          var descriptionText = truncate(translate("description"), MAX_DESCRIPTION_LEN);
          if (privacyPolicyUrl && isCookiePolicyLinkEnabled()) {
            initialText.appendChild(document.createTextNode(descriptionText + " "));
            var policyLink = document.createElement("a");
            policyLink.textContent = translateTruncated("privacyPolicy", MAX_LINK_LEN);
            policyLink.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            bindExternalLink(policyLink, privacyPolicyUrl);
            initialText.appendChild(policyLink);
            initialText.appendChild(document.createTextNode("."))
          } else initialText.textContent = descriptionText;
          initialBody.appendChild(initialText);

          // "Do Not Sell My Personal Information" — opens the preferences panel.
          var doNotSellRow = document.createElement("p");
          doNotSellRow.style.marginTop = "20px";
          doNotSellRow.style.marginBottom = "0";
          var doNotSellLink = document.createElement("button");
          doNotSellLink.id = "cb-ccpa-donotsell-link";
          doNotSellLink.type = "button";
          doNotSellLink.textContent = translate("doNotSell");
          doNotSellLink.style.cssText = "background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;text-align:left;display:inline;";
          doNotSellRow.appendChild(doNotSellLink);
          initialBody.appendChild(doNotSellRow);

          initialBanner.appendChild(initialBody);
          appendCloseButton(initialBanner, "cb-close-initial-btn");
          wrapper.appendChild(initialBanner);

          // ---- CCPA preferences panel ---------------------------------------------
          var prefsBanner = document.createElement("div");
          prefsBanner.className = "cb-banner cb-ccpa-prefs";
          prefsBanner.id = "cb-preferences-banner";
          prefsBanner.style.display = "none";
          "left" === preferencePosition ? prefsBanner.classList.add("prefs-left") : "right" === preferencePosition ? prefsBanner.classList.add("prefs-right") : prefsBanner.classList.add("prefs-center");

          var prefsBody = document.createElement("div");
          prefsBody.className = "cb-banner-body";

          var prefsHeading = document.createElement("h3");
          prefsHeading.textContent = translate("optOutPreference");
          prefsBody.appendChild(prefsHeading);

          var prefsText = document.createElement("p");
          // Strip any trailing "More info." — we render our own policy link instead.
          var optOutIntro = (translate("ccpaOptOutPreferenceIntro") || translate("ccpaOptOut") || "").replace(/\s*More info\.?\s*$/i, "").trim();
          if (privacyPolicyUrl && isCookiePolicyLinkEnabled()) {
            prefsText.appendChild(document.createTextNode(optOutIntro + " "));
            var prefsPolicyLink = document.createElement("a");
            prefsPolicyLink.textContent = translate("privacyPolicy");
            prefsPolicyLink.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            bindExternalLink(prefsPolicyLink, privacyPolicyUrl);
            prefsText.appendChild(prefsPolicyLink);
            prefsText.appendChild(document.createTextNode("."))
          } else prefsText.textContent = optOutIntro;
          prefsText.style.lineHeight = "1.45";
          prefsBody.appendChild(prefsText);

          var optOutLabel = document.createElement("label");
          optOutLabel.style.cssText = "display:flex;align-items:flex-start;gap:12px;margin-top:20px;cursor:pointer;";
          var optOutText = document.createElement("span");
          optOutText.style.cssText = "flex:1;line-height:1.45;";
          optOutText.textContent = translate("doNotSell");
          var optOutCheckbox = document.createElement("input");
          optOutCheckbox.type = "checkbox";
          optOutCheckbox.id = "cb-ccpa-optout";
          optOutCheckbox.style.cssText = "flex-shrink:0;margin-top:2px;";
          optOutCheckbox.checked = !!(consentState && consentState.accepted && consentState.ccpa && consentState.ccpa.doNotSell);
          optOutLabel.appendChild(optOutCheckbox);
          optOutLabel.appendChild(optOutText);
          prefsBody.appendChild(optOutLabel);
          prefsBanner.appendChild(prefsBody);

          var prefsFooter = document.createElement("div");
          prefsFooter.className = "cb-banner-footer";
          var cancelBtn = document.createElement("button");
          cancelBtn.id = "cb-cancel-prefs-btn";
          cancelBtn.textContent = translateButton("cancel");
          prefsFooter.appendChild(cancelBtn);
          var saveBtn = document.createElement("button");
          saveBtn.id = "cb-save-prefs-btn";
          saveBtn.textContent = translate("saveMyPreferences") || translate("save");
          prefsFooter.appendChild(saveBtn);
          prefsBanner.appendChild(prefsFooter);

          appendPrefsCloseButton(prefsBanner);
          wrapper.appendChild(prefsBanner)
        } else {
          /**
           * One collapsible category row: expand/collapse chevron, label, on/off toggle
           * (or an "Always Active" badge for essential) and a description. Expanding a row
           * collapses its siblings, so only one is ever open.
           *
           * The visible toggle is a <button role="switch"> mirroring a hidden checkbox —
           * the checkbox is what the save handler reads, the button is what gets styled.
           */
          var buildCategoryRow = function (options) {
            var row = document.createElement("div");
            row.style.borderBottom = "1px solid #e5e7eb";

            var header = document.createElement("div");
            header.style.cssText = "display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";

            var expandBtn = document.createElement("button");
            expandBtn.type = "button";
            expandBtn.setAttribute("aria-expanded", "false");
            expandBtn.textContent = "+";
            expandBtn.style.cssText = "flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";

            var label = document.createElement("span");
            label.className = "cb-gdpr-cat-label";
            label.style.cssText = "flex:1;font-size:11px;font-weight:600;";
            label.textContent = options.labelText;

            header.appendChild(expandBtn);
            header.appendChild(label);

            var control = document.createElement("div");
            control.style.flexShrink = "0";
            if (options.alwaysActive) {
              var alwaysActiveBadge = document.createElement("span");
              alwaysActiveBadge.style.cssText = "font-size:11px;font-weight:600;color:#374151;";
              alwaysActiveBadge.textContent = translateTruncated("alwaysActive", 20);
              control.appendChild(alwaysActiveBadge)
            } else {
              var checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.id = options.checkboxId;
              options.defaultChecked && (checkbox.checked = true);
              checkbox.style.cssText = "position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";

              var toggle = document.createElement("button");
              toggle.type = "button";
              toggle.className = "cb-pref-toggle-track";
              toggle.setAttribute("role", "switch");
              toggle.setAttribute("aria-label", options.labelText);
              var syncToggleState = function () {
                toggle.setAttribute("aria-checked", checkbox.checked ? "true" : "false")
              };
              toggle.addEventListener("click", function () {
                checkbox.checked = !checkbox.checked;
                syncToggleState()
              });
              syncToggleState();

              control.appendChild(checkbox);
              control.appendChild(toggle)
            }
            header.appendChild(control);

            // Description: animated open/closed via a 0fr → 1fr grid row.
            var description = document.createElement("div");
            description.className = "cb-gdpr-cat-desc";
            description.style.cssText = "display:grid;grid-template-rows:0fr;opacity:0;font-size:13px;line-height:1.5;transition:grid-template-rows .3s ease,opacity .25s ease;";
            var descriptionInner = document.createElement("div");
            descriptionInner.style.cssText = "overflow:hidden;min-height:0;padding:0 12px 12px 44px;";
            descriptionInner.textContent = options.descText;
            description.appendChild(descriptionInner);

            var expand = function (el) {
              el.style.gridTemplateRows = "1fr";
              el.style.opacity = ""
            };
            var collapse = function (el) {
              el.style.gridTemplateRows = "0fr";
              el.style.opacity = "0"
            };

            expandBtn.addEventListener("click", function () {
              var shouldExpand = "true" !== expandBtn.getAttribute("aria-expanded");

              // Accordion behaviour: close every other row first.
              var accordion = row.parentNode;
              if (accordion) {
                var rows = accordion.children;
                for (var i = 0; i < rows.length; i++) {
                  var otherDescription = rows[i].querySelector(".cb-gdpr-cat-desc");
                  var otherButton = rows[i].querySelector("button[aria-expanded]");
                  if (otherDescription && otherDescription !== description) {
                    collapse(otherDescription);
                    if (otherButton) {
                      otherButton.textContent = "+";
                      otherButton.setAttribute("aria-expanded", "false")
                    }
                  }
                }
              }

              shouldExpand ? expand(description) : collapse(description);
              expandBtn.textContent = shouldExpand ? "−" : "+";
              expandBtn.setAttribute("aria-expanded", shouldExpand ? "true" : "false")
            });

            row.appendChild(header);
            row.appendChild(description);
            return row
          };

          // ---- GDPR initial banner ------------------------------------------------
          var gdprInitialBanner = document.createElement("div");
          gdprInitialBanner.className = "cb-banner";
          gdprInitialBanner.id = "cb-initial-banner";
          gdprInitialBanner.style.display = "none";

          var gdprInitialBody = document.createElement("div");
          gdprInitialBody.className = "cb-banner-body";

          var gdprHeading = document.createElement("h3");
          gdprHeading.textContent = translate("title");
          gdprInitialBody.appendChild(gdprHeading);

          var gdprText = document.createElement("p");
          var gdprDescription = translate("description");
          if (privacyPolicyUrl && isCookiePolicyLinkEnabled()) {
            gdprText.appendChild(document.createTextNode(gdprDescription + " "));
            var gdprPolicyLink = document.createElement("a");
            gdprPolicyLink.textContent = translate("privacyPolicy");
            gdprPolicyLink.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            bindExternalLink(gdprPolicyLink, privacyPolicyUrl);
            gdprText.appendChild(gdprPolicyLink);
            gdprText.appendChild(document.createTextNode("."))
          } else gdprText.textContent = gdprDescription;
          gdprInitialBody.appendChild(gdprText);
          gdprInitialBanner.appendChild(gdprInitialBody);

          // Reject and Customise are individually switchable from the dashboard; Accept always shows.
          var initialFooter = document.createElement("div");
          initialFooter.className = "cb-banner-footer";

          var customiseBtn = document.createElement("button");
          customiseBtn.id = "cb-preferences-btn";
          customiseBtn.textContent = truncate(translateButton("customise"), MAX_BUTTON_LEN);
          isCustomizeButtonEnabled() && initialFooter.appendChild(customiseBtn);

          var rejectAllBtn = document.createElement("button");
          rejectAllBtn.id = "cb-reject-all-btn";
          rejectAllBtn.textContent = truncate(translateButton("rejectAll"), MAX_BUTTON_LEN);
          isRejectButtonEnabled() && initialFooter.appendChild(rejectAllBtn);

          var acceptAllBtn = document.createElement("button");
          acceptAllBtn.id = "cb-accept-all-btn";
          acceptAllBtn.textContent = truncate(translateButton("acceptAll"), MAX_BUTTON_LEN);
          initialFooter.appendChild(acceptAllBtn);

          gdprInitialBanner.appendChild(initialFooter);
          appendCloseButton(gdprInitialBanner, "cb-close-initial-btn");
          wrapper.appendChild(gdprInitialBanner);

          // ---- GDPR preferences panel ---------------------------------------------
          var gdprPrefsBanner = document.createElement("div");
          gdprPrefsBanner.className = "cb-banner";
          gdprPrefsBanner.id = "cb-preferences-banner";
          gdprPrefsBanner.style.display = "none";
          "left" === preferencePosition ? gdprPrefsBanner.classList.add("prefs-left") : "right" === preferencePosition ? gdprPrefsBanner.classList.add("prefs-right") : gdprPrefsBanner.classList.add("prefs-center");

          var gdprPrefsBody = document.createElement("div");
          gdprPrefsBody.className = "cb-banner-body";

          var gdprPrefsHeading = document.createElement("h3");
          gdprPrefsHeading.textContent = translateTruncated("cookiePreferences", MAX_TITLE_LEN);
          gdprPrefsBody.appendChild(gdprPrefsHeading);

          var gdprPrefsText = document.createElement("p");
          var managePreferencesText = (truncate(translate("managePreferences"), MAX_DESCRIPTION_LEN) || "").replace(/\s*More info\.?\s*$/i, "").trim();
          if (privacyPolicyUrl && isCookiePolicyLinkEnabled()) {
            gdprPrefsText.appendChild(document.createTextNode(managePreferencesText + " "));
            var gdprPrefsPolicyLink = document.createElement("a");
            gdprPrefsPolicyLink.textContent = translateTruncated("privacyPolicy", MAX_LINK_LEN);
            gdprPrefsPolicyLink.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            bindExternalLink(gdprPrefsPolicyLink, privacyPolicyUrl);
            gdprPrefsText.appendChild(gdprPrefsPolicyLink);
            gdprPrefsText.appendChild(document.createTextNode("."))
          } else gdprPrefsText.textContent = managePreferencesText;
          gdprPrefsBody.appendChild(gdprPrefsText);

          var accordion = document.createElement("div");
          accordion.className = "cb-gdpr-accordion";
          accordion.style.cssText = "border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";

          var essentialLabel = translateTruncated("strictlyNecessary", 20) || translateTruncated("essential", 20);
          accordion.appendChild(buildCategoryRow({
            labelText: essentialLabel,
            alwaysActive: true,
            descText: translateTruncated("essentialDescription", 300)
          }));

          // Pre-fill the toggles from the last saved choice.
          var savedCategories = loadPreferenceCategories() || consentState && consentState.accepted && consentState.categories || {};
          accordion.appendChild(buildCategoryRow({
            labelText: translateTruncated("marketing", 20),
            checkboxId: "cb-pref-marketing",
            defaultChecked: !!savedCategories.marketing,
            descText: translateTruncated("marketingDescription", 300)
          }));
          accordion.appendChild(buildCategoryRow({
            labelText: translateTruncated("analytics", 20),
            checkboxId: "cb-pref-analytics",
            defaultChecked: !!savedCategories.analytics,
            descText: translateTruncated("analyticsDescription", 300)
          }));
          accordion.appendChild(buildCategoryRow({
            labelText: translateTruncated("preferences", 20),
            checkboxId: "cb-pref-preferences",
            defaultChecked: !!savedCategories.preferences,
            descText: translateTruncated("preferencesDescription", 300)
          }));
          accordion.lastChild && (accordion.lastChild.style.borderBottom = "none");

          gdprPrefsBody.appendChild(accordion);
          gdprPrefsBanner.appendChild(gdprPrefsBody);

          var gdprPrefsFooter = document.createElement("div");
          gdprPrefsFooter.className = "cb-banner-footer";
          var prefsRejectBtn = document.createElement("button");
          prefsRejectBtn.id = "cb-prefs-reject-btn";
          prefsRejectBtn.textContent = truncate(translateButton("rejectAll"), MAX_BUTTON_LEN);
          gdprPrefsFooter.appendChild(prefsRejectBtn);
          var prefsSaveBtn = document.createElement("button");
          prefsSaveBtn.id = "cb-save-prefs-btn";
          prefsSaveBtn.textContent = truncate(translateButton("saveMyPreferences") || translateButton("save"), MAX_BUTTON_LEN);
          gdprPrefsFooter.appendChild(prefsSaveBtn);
          gdprPrefsBanner.appendChild(gdprPrefsFooter);

          appendPrefsCloseButton(gdprPrefsBanner);
          wrapper.appendChild(gdprPrefsBanner)
        }

        document.body.appendChild(wrapper);
        stopScroll && (document.body.style.overflow = "hidden");

        // Re-position the banner on resize (desktop corner ↔ mobile full-width).
        if (!window.__cbResizeInit) {
          window.__cbResizeInit = true;
          window.addEventListener("resize", function() {
            var visibleBanner = document.getElementById("cb-initial-banner");
            if (visibleBanner && visibleBanner.style.display !== "none" && visibleBanner.style.visibility !== "hidden") positionInitialBanner(visibleBanner);
          });
        }

        var builtBanner = document.getElementById("cb-initial-banner");
        if (builtBanner) {
          var isCentered = positionInitialBanner(builtBanner);
          builtBanner.style.display = "flex";
          builtBanner.style.visibility = "visible";
          builtBanner.style.opacity = "1";
          if (animationEnabled) {
            builtBanner.classList.add(getInitialBannerAnimationClass(isCentered))
          }
        }
      } else {
        // document.body does not exist yet — try again shortly.
        setTimeout(buildBanners, 100)
      }
  }

  /** Undo the scroll lock applied while the banner was open. */
  function restoreBodyScroll() {
    stopScroll && (document.body.style.overflow = "")
  }

  /** The floating logo is off when the dashboard hides it, and on by default otherwise. */
  function isFloatingLogoEnabled() {
    try {
      if (customization && false === customization.showBannerLogo) return false;
      if (customization && 0 === customization.showBannerLogo) return false;
      var lang = getActiveLanguage();
      var config = TRANSLATIONS.config || {};
      var value = config.floatingButtonEnabled != null ? config.floatingButtonEnabled : (TRANSLATIONS[lang] || TRANSLATIONS.en || {}).floatingButtonEnabled;
      return false !== value && "0" !== value && "false" !== String(value).toLowerCase()
    } catch (err) {
      return true
    }
  }

  // Should the banner stay closed (suppressed) on this page load? The user dismissed it
  // via the close (X) button WITHOUT consenting (consentState.accepted stays false, so
  // non-essential scripts remain blocked the whole time).
  //   - Floating logo ENABLED: stay closed indefinitely — the logo is the reopen path,
  //     so the banner never auto-returns.
  //   - Floating logo DISABLED: stay closed for 24h, then re-show so the visitor still
  //     has a way to consent (no dead-end when there's no logo to reopen with).
  function wasBannerDismissed() {
    try {
      var dismissedAt = parseInt(localStorage.getItem(STORAGE_KEY + "_closed") || "0", 10);
      if (!dismissedAt) return false;
      if (isFloatingLogoEnabled()) return true;
      if (Date.now() - dismissedAt < 86400000) return true;
      localStorage.removeItem(STORAGE_KEY + "_closed");
      return false
    } catch (err) {
      return false
    }
  }

  /** Which side the floating logo sits on. Defaults to left. */
  function getFloatingLogoPosition() {
    try {
      if (customization && customization.bannerLogoPosition) return "right" === customization.bannerLogoPosition ? "right" : "left";
      var lang = getActiveLanguage();
      var config = TRANSLATIONS.config || {};
      var value = config.floatingButtonPosition != null ? config.floatingButtonPosition : (TRANSLATIONS[lang] || TRANSLATIONS.en || {}).floatingButtonPosition;
      return "right" === value ? "right" : "left"
    } catch (err) {
      return "left"
    }
  }

  /** Inline SVG cookie icon — used when the hosted logo image cannot be loaded. */
  function createFallbackLogoSvg() {
    var SVG_NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("xmlns", SVG_NS);
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("width", "44");
    svg.setAttribute("height", "44");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";

    var background = document.createElementNS(SVG_NS, "circle");
    background.setAttribute("cx", "20");
    background.setAttribute("cy", "20");
    background.setAttribute("r", "18");
    background.setAttribute("fill", "#007aff");
    svg.appendChild(background);

    // The three "chocolate chips".
    var chips = [{
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
    for (var i = 0; i < chips.length; i++) {
      var chip = document.createElementNS(SVG_NS, "circle");
      chip.setAttribute("cx", chips[i].cx);
      chip.setAttribute("cy", chips[i].cy);
      chip.setAttribute("r", chips[i].r);
      chip.setAttribute("fill", "#ffffff");
      svg.appendChild(chip)
    }
    return svg
  }

  /** Recover our own origin from this script's own <script src>, when the config omitted it. */
  function detectScriptOrigin() {
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].src || "";
        if (-1 !== src.indexOf("/consentbit/") || -1 !== src.indexOf("/client_data/")) return new URL(src).origin
      }
    } catch (err) {}
    return ""
  }

  /**
   * The persistent floating button that reopens the banner.
   * Image loading degrades in two steps: primary URL → fallback URL → inline SVG.
   */
  function createFloatingTrigger() {
    if (!document.getElementById("cb-floating-trigger") && isFloatingLogoEnabled()) {
      var side = getFloatingLogoPosition();
      var primaryUrl = floatingLogoUrl || "";
      var fallbackUrl = floatingLogoFallbackUrl || "";
      if (!primaryUrl) {
        var origin = detectScriptOrigin();
        if (origin) {
          primaryUrl = origin + "/embed/floating-logo.svg";
          fallbackUrl || (fallbackUrl = primaryUrl)
        }
      }

      var trigger = document.createElement("button");
      trigger.id = "cb-floating-trigger";
      trigger.type = "button";
      trigger.setAttribute("aria-label", translate("cookiePreferences"));
      trigger.style.cssText = "position:fixed;bottom:28px;" + ("right" === side ? "right:16px;" : "left:16px;") + "z-index:2147483646;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;";

      if (primaryUrl) {
        var logoImg = document.createElement("img");
        logoImg.alt = "";
        logoImg.src = primaryUrl;
        logoImg.setAttribute("width", "44");
        logoImg.setAttribute("height", "44");
        logoImg.draggable = false;
        logoImg.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";

        var triedFallback = false;
        logoImg.addEventListener("error", function onLogoError() {
          if (triedFallback || !fallbackUrl || primaryUrl === fallbackUrl) {
            logoImg.removeEventListener("error", onLogoError);
            logoImg.parentNode && logoImg.parentNode.replaceChild(createFallbackLogoSvg(), logoImg)
          } else {
            triedFallback = true;
            logoImg.src = fallbackUrl
          }
        });
        trigger.appendChild(logoImg)
      } else trigger.appendChild(createFallbackLogoSvg());

      document.body.appendChild(trigger)
    }
  }

  /** Entrance-animation class for the preferences panel, given where it is anchored. */
  function getPreferencesAnimationClass() {
    if (!animationEnabled) return "";
    return "left" === preferencePosition ? "zoom-in" === entranceAnimation ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-prefs-left" : "right" === preferencePosition ? "zoom-in" === entranceAnimation ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-prefs-right" : "slide-up" === entranceAnimation ? "cb-banner-animate-center-bottom" : "slide-down" === entranceAnimation ? "cb-banner-animate-center-top" : "zoom-in" === entranceAnimation ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-fade"
  }

  /** Strip every entrance-animation class, so the next show can re-trigger one. */
  function removeAnimationClasses(el) {
    if (el) {
      var classes = ANIMATION_CLASSES.split(" ");
      for (var i = 0; i < classes.length; i++) classes[i] && el.classList.remove(classes[i])
    }
  }

  /**
   * Render the banners and wire up every control.
   * Once a choice is made the flow is always the same: record it, delete cookies for
   * the declined categories, unblock the scripts now allowed, push the state to Google
   * Consent Mode, broadcast to Webflow, then dismiss the UI.
   */
  function initBannerUi() {
    injectStyles();
    buildBanners();
    createFloatingTrigger();

    var initialBanner = document.getElementById("cb-initial-banner");
    var prefsBanner = document.getElementById("cb-preferences-banner");
    var customiseBtn = document.getElementById("cb-preferences-btn");
    var acceptAllBtn = document.getElementById("cb-accept-all-btn");
    var rejectAllBtn = document.getElementById("cb-reject-all-btn");
    var prefsRejectBtn = document.getElementById("cb-prefs-reject-btn");
    var cancelPrefsBtn = document.getElementById("cb-cancel-prefs-btn");
    var savePrefsBtn = document.getElementById("cb-save-prefs-btn");
    var doNotSellLink = document.getElementById("cb-ccpa-donotsell-link");
    var isCcpa = "ccpa" === bannerType;

    /** Hide both banners and bring the floating trigger back. */
    function dismissBanners() {
      if (initialBanner) {
        initialBanner.style.setProperty("display", "none", "important");
        initialBanner.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade")
      }
      if (prefsBanner) {
        prefsBanner.style.display = "none";
        removeAnimationClasses(prefsBanner)
      }
      var trigger = document.getElementById("cb-floating-trigger");
      trigger && (trigger.style.display = "flex");
      restoreBodyScroll()
    }

    /** Show the initial banner (from the floating trigger, or from Cancel in the CCPA panel). */
    function showInitialBanner() {
      if (initialBanner) {
        if (prefsBanner) {
          prefsBanner.style.display = "none";
          removeAnimationClasses(prefsBanner)
        }
        var isCentered = positionInitialBanner(initialBanner);
        initialBanner.style.setProperty("display", "flex", "important");
        initialBanner.style.setProperty("visibility", "visible", "important");
        initialBanner.style.setProperty("opacity", "1", "important");
        initialBanner.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade", "cb-banner-animate-zoom-in");
        if (animationEnabled) {
          initialBanner.classList.add(getInitialBannerAnimationClass(isCentered))
        }
        stopScroll && (document.body.style.overflow = "hidden")
      }
    }

    /** Open the preferences panel and hide the initial banner + trigger. */
    function showPreferencesBanner() {
      initialBanner.style.display = "none";
      var trigger = document.getElementById("cb-floating-trigger");
      trigger && (trigger.style.display = "none");
      prefsBanner.style.display = "flex";
      prefsBanner.style.visibility = "visible";
      prefsBanner.style.opacity = "1";
      removeAnimationClasses(prefsBanner);
      var animationClass = getPreferencesAnimationClass();
      animationClass && prefsBanner.classList.add(animationClass)
    }

    var floatingTrigger = document.getElementById("cb-floating-trigger");
    floatingTrigger && floatingTrigger.addEventListener("click", function (event) {
      event && event.preventDefault && event.preventDefault();
      event && event.stopPropagation && event.stopPropagation();
      showInitialBanner()
    });

    // Customise → open the preferences panel, toggles pre-filled from the saved choice.
    customiseBtn && customiseBtn.addEventListener("click", function () {
      if (initialBanner && prefsBanner) {
        if (!isCcpa) {
          var savedCategories = loadPreferenceCategories() || consentState && consentState.categories || {};
          var setToggle = function (checkboxId, checked) {
            var checkbox = document.getElementById(checkboxId);
            if (checkbox) {
              checkbox.checked = !!checked;
              var toggle = checkbox.parentNode && checkbox.parentNode.querySelector("button.cb-pref-toggle-track");
              toggle && toggle.setAttribute("aria-checked", checkbox.checked ? "true" : "false")
            }
          };
          setToggle("cb-pref-analytics", savedCategories.analytics);
          setToggle("cb-pref-preferences", savedCategories.preferences);
          setToggle("cb-pref-marketing", savedCategories.marketing)
        }
        initialBanner.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade");
        showPreferencesBanner()
      }
    });

    // Reject All, from inside the preferences panel.
    prefsRejectBtn && prefsRejectBtn.addEventListener("click", function () {
      var state = {
        accepted: true,
        timestamp: (new Date).toISOString(),
        categories: {
          essential: true,
          analytics: false,
          preferences: false,
          marketing: false
        }
      };
      deleteCookiesForCategories(["analytics", "marketing", "preferences"]);
      saveConsentState(state);
      postConsentToApi(state, {
        status: "rejected"
      });
      savePreferenceCategories(state.categories);
      updateGoogleConsentMode(state.categories, "[PrefsReject]");
      dispatchWebflowConsent(state.categories);
      dismissBanners()
    });

    // Close (×) on either banner: dismiss WITHOUT consenting. Scripts stay blocked and
    // the timestamp lets wasBannerDismissed() keep it closed on the next page load.
    var closeInitialBtn = document.getElementById("cb-close-initial-btn");
    var closePrefsBtn = document.getElementById("cb-close-prefs-btn");
    closeInitialBtn && closeInitialBtn.addEventListener("click", function () {
      try { localStorage.setItem(STORAGE_KEY + "_closed", String(Date.now())) } catch (err) {}
      dismissBanners()
    });
    closePrefsBtn && closePrefsBtn.addEventListener("click", function () {
      try { localStorage.setItem(STORAGE_KEY + "_closed", String(Date.now())) } catch (err) {}
      dismissBanners()
    });

    // CCPA: the "Do Not Sell" link opens the opt-out panel.
    isCcpa && doNotSellLink && doNotSellLink.addEventListener("click", function () {
      if (initialBanner && prefsBanner) {
        showPreferencesBanner()
      }
    });

    // CCPA: Cancel returns to the initial banner.
    cancelPrefsBtn && cancelPrefsBtn.addEventListener("click", function () {
      showInitialBanner()
    });

    // Reject All, from the initial banner. Under CCPA this button is not a consent
    // action (that regime is opt-out), so it only dismisses.
    rejectAllBtn && rejectAllBtn.addEventListener("click", function () {
      if (!isCcpa) {
        var state = {
          accepted: true,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: true,
            analytics: false,
            preferences: false,
            marketing: false
          }
        };
        deleteCookiesForCategories(["analytics", "marketing", "preferences"]);
        saveConsentState(state);
        postConsentToApi(state, {
          status: "rejected"
        });
        savePreferenceCategories(state.categories);
        updateGoogleConsentMode(state.categories, "[Reject]");
        dispatchWebflowConsent(state.categories)
      }
      dismissBanners()
    });

    // Accept All. Under CCPA that means "do not opt out"; under GDPR it grants every category.
    acceptAllBtn && acceptAllBtn.addEventListener("click", function () {
      if (isCcpa) {
        var ccpaState = {
          accepted: true,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: false
          }
        };
        saveConsentState(ccpaState);
        postConsentToApi(ccpaState, {
          status: "given"
        });
        unblockAllowedScripts({
          analytics: true,
          marketing: true,
          preferences: true,
          essential: true
        });
        updateGoogleConsentModeCcpa(false)
      } else {
        var gdprState = {
          accepted: true,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: true,
            analytics: true,
            preferences: true,
            marketing: true
          }
        };
        saveConsentState(gdprState);
        postConsentToApi(gdprState, {
          status: "given"
        });
        savePreferenceCategories(gdprState.categories);
        unblockAllowedScripts(gdprState.categories);
        updateGoogleConsentMode(gdprState.categories, "[Accept]")
      }
      dismissBanners()
    });

    // Save: CCPA reads the single opt-out checkbox; GDPR reads the three category toggles.
    savePrefsBtn && savePrefsBtn.addEventListener("click", function () {
      if (isCcpa) {
        var optOutCheckbox = document.getElementById("cb-ccpa-optout");
        var doNotSell = !(!optOutCheckbox || !optOutCheckbox.checked);
        var ccpaState = {
          accepted: true,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: doNotSell
          }
        };
        saveConsentState(ccpaState);
        postConsentToApi(ccpaState, {
          status: doNotSell ? "rejected" : "given"
        });
        doNotSell || unblockAllowedScripts({
          analytics: true,
          marketing: true,
          preferences: true,
          essential: true
        });
        updateGoogleConsentModeCcpa(doNotSell)
      } else {
        var analyticsCheckbox = document.getElementById("cb-pref-analytics");
        var preferencesCheckbox = document.getElementById("cb-pref-preferences");
        var marketingCheckbox = document.getElementById("cb-pref-marketing");
        var gdprState = {
          accepted: true,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: true,
            analytics: !(!analyticsCheckbox || !analyticsCheckbox.checked),
            preferences: !(!preferencesCheckbox || !preferencesCheckbox.checked),
            marketing: !(!marketingCheckbox || !marketingCheckbox.checked)
          }
        };

        var deniedCategories = [];
        if (!gdprState.categories.analytics) deniedCategories.push("analytics");
        if (!gdprState.categories.marketing) deniedCategories.push("marketing");
        if (!gdprState.categories.preferences) deniedCategories.push("preferences");
        if (deniedCategories.length) deleteCookiesForCategories(deniedCategories);

        saveConsentState(gdprState);
        postConsentToApi(gdprState, {
          status: "partial"
        });
        savePreferenceCategories(gdprState.categories);
        unblockAllowedScripts(gdprState.categories);
        updateGoogleConsentMode(gdprState.categories, "[Save]");
        dispatchWebflowConsent(gdprState.categories)
      }
      dismissBanners()
    })
  }

  /** Render the UI and show the initial banner straight away (no floating trigger). */
  function showBannerNow() {
    initBannerUi();
    var initialBanner = document.getElementById("cb-initial-banner");
    if (initialBanner) {
      initialBanner.style.display = "flex";
      initialBanner.style.visibility = "visible";
      initialBanner.style.opacity = "1";
    }
    var trigger = document.getElementById("cb-floating-trigger");
    if (trigger) trigger.style.display = "none";
  }

  /**
   * Entry point, once the DOM is ready.
   * 1. Apply the stored consent to Google Consent Mode (and block scripts under GDPR).
   * 2. Decide what UI to show: nothing, the floating trigger only, or the banner.
   * 3. Report the pageview and start listening for the site's own "open banner" triggers.
   */
  function boot() {
    var pageHasGoogleTag = hasGoogleTagScript();

    if ("gdpr" === bannerType) {
      blockExistingScripts();
      if (gaMeasurementId || pageHasGoogleTag) {
        // consentModeBootstrap (served ahead of this script on the standard path) may
        // already have pushed the default — do not overwrite it with a stale one.
        !window.__cbConsentDefaultSet && window.gtag && window.gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          functionality_storage: "denied",
          personalization_storage: "denied",
          security_storage: "granted",
          wait_for_update: 500
        });
        consentState.accepted ? updateGoogleConsentMode(consentState.categories || {}, "[Reload]") : gaMeasurementId && bootstrapGoogleAnalytics()
      }
    } else if ("ccpa" === bannerType) {
      // CCPA is an opt-out regime: storage defaults to granted unless the user opted
      // out. We still push an all-denied default first (consent-mode best practice),
      // load GA when we manage it, then immediately update to the actual opt-out state.
      if (gaMeasurementId || pageHasGoogleTag) {
        !window.__cbConsentDefaultSet && window.gtag && window.gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          functionality_storage: "denied",
          personalization_storage: "denied",
          security_storage: "granted",
          wait_for_update: 500
        });
        gaMeasurementId && bootstrapGoogleAnalytics();
        updateGoogleConsentModeCcpa(!!(consentState && consentState.accepted && consentState.ccpa && consentState.ccpa.doNotSell))
      }
    }

    if (!window.__CB_WEBFLOW_MODE__) {
      if (bannerEnabled)
        if (consentState.accepted || wasBannerDismissed()) {
          // Already decided (or dismissed): build the UI but keep it hidden behind the trigger.
          initBannerUi();
          var trigger = document.getElementById("cb-floating-trigger");
          trigger && (trigger.style.display = "flex");
          var hiddenBanner = document.getElementById("cb-initial-banner");
          if (hiddenBanner) {
            hiddenBanner.style.setProperty("display", "none", "important");
            hiddenBanner.style.setProperty("visibility", "hidden", "important");
          }
        } else showBannerNow();
    } else {
      // Webflow mode: the UI is always built, then shown or hidden explicitly.
      initBannerUi();
      if (consentState.accepted || wasBannerDismissed()) {
        var wfInitialBanner = document.getElementById("cb-initial-banner");
        if (wfInitialBanner) {
          wfInitialBanner.style.setProperty("display", "none", "important");
          wfInitialBanner.style.setProperty("visibility", "hidden", "important");
        }
        var wfPrefsBanner = document.getElementById("cb-preferences-banner");
        if (wfPrefsBanner) {
          wfPrefsBanner.style.setProperty("display", "none", "important");
        }
        var wfTrigger = document.getElementById("cb-floating-trigger");
        if (wfTrigger) wfTrigger.style.display = "flex";
      } else if (bannerEnabled) {
        var wfBannerToShow = document.getElementById("cb-initial-banner");
        if (wfBannerToShow) {
          wfBannerToShow.style.display = "flex";
          wfBannerToShow.style.setProperty("visibility", "visible", "important");
          wfBannerToShow.style.setProperty("opacity", "1", "important");
        }
        var wfTriggerToHide = document.getElementById("cb-floating-trigger");
        if (wfTriggerToHide) wfTriggerToHide.style.display = "none";
      } else {
        // bannerEnabled === false (region-suppressed, e.g. CCPA banner for a non-US
        // visitor): show NO consent UI at all — hide both the banner AND the floating
        // trigger. CCPA does not apply outside the US, so no surface is presented.
        var wfSuppressedBanner = document.getElementById("cb-initial-banner");
        if (wfSuppressedBanner) {
          wfSuppressedBanner.style.setProperty("display", "none", "important");
          wfSuppressedBanner.style.setProperty("visibility", "hidden", "important");
        }
        var wfSuppressedTrigger = document.getElementById("cb-floating-trigger");
        if (wfSuppressedTrigger) wfSuppressedTrigger.style.setProperty("display", "none", "important");
      }
    }

    try {
      recordPageview()
    } catch (err) {
    }

    /**
     * Let the site re-open the banner from its own markup, via a capture-phase click
     * listener so it works no matter what the host page does with the event:
     *   data-consentbit-trigger — clear the stored consent, then show the banner
     *   data-consentbit-banner  — just show the banner, keeping the stored consent
     */
    function bindConsentTriggers() {
      document.addEventListener("click", function (event) {
        var element = event.target;
        for (; element && element !== document.body;) {
          var isReset = element.hasAttribute && element.hasAttribute("data-consentbit-trigger");
          var isShowOnly = element.hasAttribute && element.hasAttribute("data-consentbit-banner");
          if (isReset || isShowOnly) {
            event.preventDefault();
            event.stopPropagation();
            if (isReset) {
              try {
                localStorage.removeItem(STORAGE_KEY);
                localStorage.removeItem(STORAGE_KEY + "_closed");
                consentState = {
                  accepted: false,
                  timestamp: null
                }
              } catch (err) {
              }
            }
            var banner = document.getElementById("cb-initial-banner");
            if (banner) {
              banner.style.display = "flex";
              banner.style.visibility = "visible";
              banner.style.opacity = "1";
              stopScroll && (document.body.style.overflow = "hidden");
              var trigger = document.getElementById("cb-floating-trigger");
              if (trigger) trigger.style.display = "none";
              banner.scrollIntoView({
                behavior: "smooth",
                block: "start"
              })
            } else {
              // Banner was never built (e.g. bannerEnabled false) — build it now.
              showBannerNow();
              setTimeout(function () {
                var builtBanner = document.getElementById("cb-initial-banner");
                builtBanner && builtBanner.scrollIntoView({
                  behavior: "smooth",
                  block: "start"
                })
              }, 100)
            }
            return false
          }
          element = element.parentElement
        }
      }, true)
    }
    "loading" === document.readyState ? document.addEventListener("DOMContentLoaded", bindConsentTriggers) : bindConsentTriggers()
  }
}();
`;

  // ETag must change whenever banner customization/translation changes.
  // `Site.updatedAt` does not always update when only BannerCustomization changes, so include both.
  // Also include a script version so CDN logic changes propagate even when site/customization did not change.
  const SCRIPT_VERSION = '2026-07-01-close-persist-floatinglogo-24h';
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
${getLoaderIabScript(customization, { rawPos: customization?.position || 'bottom-left', bannerLayoutVisual: enTrans?.bannerLayoutVisual, textAlign: (typeof textAlign !== 'undefined' && (textAlign === 'center' || textAlign === 'right')) ? textAlign : 'left', bannerEntranceAnimation: siteConfigPayload?.customization?.bannerEntranceAnimation }, isGoogleAc)}
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
  const rawIsWebflow = String(resolvedSite.platform || '').toLowerCase() === 'webflow';
  // Webflow v2 sites use the standard loader (with Consent Mode bootstrap) instead of
  // the Webflow-specific loader. Treat a v2 Webflow site as non-Webflow for loader
  // selection so it falls through to the 'standard' path.
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
  // ─── Standard/general (non-Webflow) Consent Mode bootstrap ───────────────────
  // Framer and other "standard" sites bring their OWN GTM/GA. In standard mode
  // shouldBlockScript() intentionally does NOT hard-block GTM/GA URLs (the
  // isGoogleAnalyticsUrl() exemption) — it relies on Google Consent Mode. But the
  // standard loader only pushed `consent default denied` inside boot() at
  // DOMContentLoaded, i.e. AFTER the page's GTM snippet already loaded
  // gtm.js → GA fired before consent. Webflow mode avoids this by pushing the default
  // synchronously at the very top (getWebflowSetupScript). We mirror that here for the
  // standard path ONLY, baking the resolved banner type server-side. Sets
  // window.__cbConsentDefaultSet so boot() does not re-push a (possibly stale) default.
  // NOTE: deliberately NOT added to webflow/iab paths — those are unchanged.
  const bannerIsCcpa = String(effectiveBannerType || '').toLowerCase() === 'ccpa';
  const consentModeBootstrap = `(function(){try{var c=${bannerIsCcpa ? 'true' : 'false'};var d=null,e=false,hasStored=false;try{for(var i=0;i<localStorage.length;i++){var w=localStorage.key(i);if(w&&w.indexOf('consentbit_prefs_')===0){try{var x=localStorage.getItem(w);if(x){d=JSON.parse(atob(x));break;}}catch(_){}}}}catch(_){}try{for(var i=0;i<localStorage.length;i++){var w=localStorage.key(i);if(w&&w.indexOf('consentbit_')===0&&w.indexOf('consentbit_prefs_')!==0){try{var v=JSON.parse(localStorage.getItem(w));if(v&&v.accepted){hasStored=true;if(!d&&v.categories)d=v.categories;if(v.ccpa&&v.ccpa.doNotSell)e=true;break;}}catch(_){}}}}catch(_){}try{if(navigator.globalPrivacyControl===true&&c&&!hasStored){e=true;}}catch(_){}window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};if(!c){window.gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',functionality_storage:'denied',personalization_storage:'denied',security_storage:'granted',wait_for_update:500});if(d){window.gtag('consent','update',{analytics_storage:d.analytics?'granted':'denied',ad_storage:d.marketing?'granted':'denied',ad_user_data:d.marketing?'granted':'denied',ad_personalization:d.marketing?'granted':'denied',functionality_storage:d.preferences?'granted':'denied',personalization_storage:d.preferences?'granted':'denied'});}}else{window.gtag('consent','default',{ad_storage:e?'denied':'granted',analytics_storage:e?'denied':'granted',ad_user_data:e?'denied':'granted',ad_personalization:e?'denied':'granted',security_storage:'granted'});}window.__cbConsentDefaultSet=true;}catch(_){}})();\n`;

  const scriptToServe =
    (serveKind === 'iab' ? loaderIab : serveKind === 'iabwebflow' ? loaderIabWebflow : serveKind === 'webflow' ? loaderWebflow : (consentModeBootstrap + loader));


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