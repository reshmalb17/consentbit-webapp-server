// @ts-nocheck
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

          if (stagingHost && sourceHost === stagingHost) {
            // Staging domain allowed — site has a custom domain with Webflow staging
          } else {
            console.warn(`[CDN] Domain mismatch: script for "${siteHost}" requested from "${sourceHost}" — blocking`);
            return new Response('// Script not authorized for this domain', {
              status: 403,
              headers: { 'Content-Type': 'application/javascript' },
            });
          }
        }
      } catch (domainErr) {
        // Malformed Origin/Referer — fail safe and block
        console.warn('[CDN] Could not parse Origin/Referer for domain check:', domainErr?.message);
        return new Response('// Script not authorized for this domain', {
          status: 403,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    }
    // Neither Origin nor Referer present: could be a direct/server-side fetch.
    // Allow through — the client-side domain guard in the embedded script will
    // enforce the domain restriction in the browser.
  }

  // Check subscription status — block banner if subscription is canceled/expired
  // Also capture planId so we can gate IAB features below.
  let effectivePlanId = 'free';
  let orgIdForDebug = null;
  let subStatusForDebug = null;
  try {
    const orgId = resolvedSite.organizationId ?? resolvedSite.organizationid ?? null;
    orgIdForDebug = orgId ? String(orgId) : null;
    if (orgId) {
      const { planId: resolvedPlanId, subscription } = await getEffectivePlanForOrganization(db, orgId, env);
      effectivePlanId = resolvedPlanId || 'free';
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
    // Normalize DB/API values (case, legacy "Right", underscores) so corner CSS matches dashboard.
    const rawPos = customization.position || 'bottom-left';
    const normPos = String(rawPos).trim().toLowerCase().replace(/_/g, '-');
    let position = 'bottom-left';
    if (normPos === 'bottom-right' || normPos === 'right') position = 'bottom-right';
    else if (normPos === 'bottom') position = 'bottom';
    else if (normPos === 'bottom-left' || normPos === 'left') position = 'bottom-left';
    const bgColor = customization.backgroundColor || '#ffffff';
    const textColor = customization.textColor || '#334155';
    const headingColor = customization.headingColor || '#0f172a';
    var _rawRadius = customization.bannerBorderRadius || '0.375rem';
    // Cap border radius at 50px (3.125rem) to prevent over-rounding.
    var _radiusPx = _rawRadius.endsWith('rem') ? Math.round(parseFloat(_rawRadius) * 16) : Math.round(parseFloat(_rawRadius) || 6);
    if (_radiusPx > 30) { _rawRadius = '1.875rem'; }
    const bannerRadius = _rawRadius;
    const buttonRadius = customization.buttonBorderRadius || '0.375rem';
    var acceptBg = customization.acceptButtonBg || '#007aff';
    var acceptTx = customization.acceptButtonText || '#ffffff';
    var rejectBg = customization.rejectButtonBg || acceptBg;
    var rejectTx = customization.rejectButtonText || acceptTx;
    var custBg = customization.customiseButtonBg || '#ffffff';
    var custTx = customization.customiseButtonText || '#334155';
    var saveBg = customization.saveButtonBg || custBg;
    var saveTx = customization.saveButtonText || custTx;

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
    var isLongContent = descLen > 200 || maxBtnLen > 12;
    var baseWidth = (isBoldHeavy && isLongContent) ? '680px' : (isLongContent ? '500px' : '440px');
    var maxWidth = (isBoldHeavy && isLongContent) ? '680px' : (isLongContent ? '500px' : '440px');
    var initialSize =
      'width:' + baseWidth + ';min-width:280px;max-width:min(' + maxWidth + ',92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;';
    var initialRadius = 'border-radius:' + bannerRadius + ';';
    if (layoutVisual === 'banner') {
      initialSize = 'width:100%;max-width:none;';
      positionStyles = 'bottom:0;left:0;right:0;transform:none;';
      initialRadius = 'border-radius:' + bannerRadius + ';';
    } else if (layoutVisual === 'bottom-center') {
      initialSize =
        'width:' + baseWidth + ';min-width:280px;max-width:min(' + maxWidth + ',92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;';
      positionStyles = 'bottom:32px;left:50%;transform:translateX(-50%);';
      initialRadius = 'border-radius:' + bannerRadius + ';';
    } else {
      if (position === 'bottom-left') {
        positionStyles = 'bottom:32px;left:32px;right:auto;transform:none;';
      } else if (position === 'bottom-right') {
        positionStyles = 'bottom:32px;right:32px;left:auto;transform:none;';
      } else if (position === 'bottom') {
        positionStyles = 'bottom:32px;left:50%;right:auto;transform:translateX(-50%);';
      } else {
        positionStyles = 'bottom:32px;left:32px;right:auto;transform:none;';
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
        "display:inline-flex;" +
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
        "font-weight:" + fontWeightStr + "!important;" +
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
        "background-color:" + rejectBg + ";" +
        "color:" + rejectTx + ";" +
        "border-color:" + rejectBg + ";" +
      "}" +
      ".cb-banner button#cb-preferences-btn," +
      ".cb-banner button#cb-ccpa-donotsell-link{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      ".cb-banner button#cb-prefs-reject-btn{" +
        "background-color:" + rejectBg + ";" +
        "color:" + rejectTx + ";" +
        "border-color:" + rejectBg + ";" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + saveBg + ";" +
        "color:" + saveTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + saveBg + ";" +
        "color:" + saveTx + ";" +
        "border-color:#e2e8f0;" +
      "}" +
      /* Initial banner actions — right-aligned; nowrap lets width grow with button row (wrap on small screens via base @media) */
      "#cb-initial-banner.cb-banner .cb-banner-footer{" +
        "display:flex;" +
        "flex-wrap:wrap;" +
        "gap:8px;" +
        "justify-content:flex-end;" +
        "flex-shrink:0;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
        "flex:1 1 auto;" +
        "min-width:80px;" +
      "}" +
      (layoutVisual === 'banner'
        ? "#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}" +
          "#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}"
        : "") +
      "#cb-initial-banner.cb-banner #cb-preferences-btn{" +
        "background:" + custBg + "!important;" +
        "color:" + custTx + "!important;" +
        "border:1px solid " + custTx + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-reject-all-btn{" +
        "background:" + rejectBg + "!important;" +
        "color:" + rejectTx + "!important;" +
        "border-color:" + rejectBg + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
        "background:" + acceptBg + "!important;" +
        "color:" + acceptTx + "!important;" +
        "border-color:" + acceptBg + "!important;" +
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
          position: (function () {
            var r = customization.position || 'bottom-left';
            var n = String(r).trim().toLowerCase().replace(/_/g, '-');
            if (n === 'bottom-right' || n === 'right') return 'bottom-right';
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
          bannerEntranceAnimation: (() => { const v = (enTrans && enTrans.bannerEntranceAnimation) ? String(enTrans.bannerEntranceAnimation) : 'fade-in'; return v === 'zoom' ? 'zoom-in' : v; })(),
          bannerFontWeight: (enTrans && enTrans.bannerFontWeight) ? String(enTrans.bannerFontWeight) : '600',
          bannerBorderRadius: customization.bannerBorderRadius || '0.375rem',
          textAlign: enTrans.bannerTextAlign || 'left',
          showBannerLogo: customization.showBannerLogo != null ? customization.showBannerLogo !== 0 && customization.showBannerLogo !== false : true,
          bannerLogoPosition: customization.bannerLogoPosition || 'left',
          rejectButtonBg: customization.rejectButtonBg || '#ffffff',
          rejectButtonText: customization.rejectButtonText || '#334155',
          saveButtonBg: customization.saveButtonBg || '#ffffff',
          saveButtonText: customization.saveButtonText || '#334155',
          buttonBorderRadius: customization.buttonBorderRadius || '0.375rem',
          font: (enTrans && enTrans.bannerFontFamily) ? String(enTrans.bannerFontFamily) : (customization.font || 'Manrope'),
          fontWeight: (enTrans && enTrans.bannerFontWeight) ? String(enTrans.bannerFontWeight) : (customization.fontWeight || 'Regular'),
          fontSize: (enTrans && enTrans.bannerFontSize) ? Number(enTrans.bannerFontSize) : (customization.fontSize || 16),
          textAlignment: (enTrans && enTrans.bannerTextAlign) ? String(enTrans.bannerTextAlign) : (customization.textAlignment || 'left'),
          bannerBg2: (enTrans && enTrans.bannerBg2) ? String(enTrans.bannerBg2) : (customization.bannerBg2 || '#798EFF'),
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
!function(){var e=window.__CONSENT_SITE__||{};var t=!0;!function(){var n=e.registeredDomain;if(n)try{var a=window.location.hostname.replace(/^www\./,"").toLowerCase();if(a!==n){console.warn("[ConsentBit] Script is not authorized for this domain ("+a+"). Expected: "+n);window.__CONSENT_SITE__=null;t=!1}}catch(e){}}();if(t){var n=e.floatingLogoUrl||"";var a=e.floatingLogoFallbackUrl||"";var r=e.id||null;var i=e.bannerType||"gdpr";var o=!1!==e.bannerEnabled;var c=e.apiBase;var s=e.gaId||null;var l=e.customization||null;var d=!0===e.pendingScan;var p=l&&l.bannerLayoutVisual||"box";var b=l?l.privacyPolicyUrl:null;var f=!!l&&l.stopScroll;var m=!l||!1!==l.animationEnabled;var u=l&&l.bannerEntranceAnimation||"fade-in";var g=l&&l.preferencePosition||"center";var v=l&&l.centerAnimationDirection||"fade";var y=l&&l.language||"en";var h=!!l&&!0===l.autoDetectLanguage;${translationsVar}console.log("[CB] TRANSLATIONS.en.saveMyPreferences =",TRANSLATIONS&&TRANSLATIONS.en&&TRANSLATIONS.en.saveMyPreferences);var x=["customise","rejectAll","acceptAll","save","back","doNotSell","saveMyPreferences","confirmChoice","cancel","optOutPreference"];var w=30,k=320,C=20,E=30,S=200;var _=56;var I="consentbit_"+r;var O=void 0!==l&&l&&null!=l.cookieExpirationDays?Math.max(1,Math.min(365,Number(l.cookieExpirationDays)||30)):30;var A=ee();var B="consentbit_prefs_"+(r||"");var L="cb_pv_over_limit_"+(r||"");var T=[];var z=!1;var N=null;var j=e.scriptBlockProviders||[];var P=e.customCookieRules||[];var F=[{domain:"facebook.com",category:"marketing"},{domain:"facebook.net",category:"marketing"},{domain:"adroll.com",category:"marketing"},{domain:"doubleclick.net",category:"marketing"},{domain:"googleadservices.com",category:"marketing"},{domain:"bing.com",category:"marketing"},{domain:"bat.bing.com",category:"marketing"},{domain:"twitter.com",category:"marketing"},{domain:"analytics.twitter.com",category:"marketing"},{domain:"t.co",category:"marketing"},{domain:"linkedin.com",category:"marketing"},{domain:"ads.linkedin.com",category:"marketing"},{domain:"pinterest.com",category:"marketing"},{domain:"ct.pinterest.com",category:"marketing"},{domain:"tiktok.com",category:"marketing"},{domain:"analytics.tiktok.com",category:"marketing"},{domain:"hotjar.com",category:"analytics"},{domain:"clarity.ms",category:"analytics"},{domain:"scorecardresearch.com",category:"analytics"},{domain:"outbrain.com",category:"marketing"},{domain:"taboola.com",category:"marketing"},{domain:"criteo.com",category:"marketing"},{domain:"criteo.net",category:"marketing"},{domain:"quantserve.com",category:"analytics"},{domain:"zemanta.com",category:"marketing"}];var D=".cb-banner,.cb-banner *{box-sizing:border-box;}#cb-initial-banner.cb-banner{width:440px;min-width:280px;max-width:min(440px,92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;bottom:32px;left:32px;right:auto;padding:16px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:inline-flex;flex-direction:column;align-items:stretch;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-initial-banner.cb-banner .cb-banner-body{flex:0 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner{width:540px;max-width:92vw;max-height:440px;min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:flex;flex-direction:column;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-preferences-banner.cb-banner .cb-banner-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner.prefs-left{left:32px;right:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-right{right:32px;left:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-center{left:50%;top:50%;transform:translate(-50%,-50%);}.cb-banner-body{overflow-y:auto;overflow-x:hidden;margin-bottom:12px;}.cb-banner h3{margin:0 0 8px;font-size:16px!important;line-height:1.4!important;font-weight:600;color:#0f172a;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}#cb-initial-banner.cb-banner h3{font-size:16px!important;font-weight:600;color:rgba(0,0,0,0.8);padding-right:36px;}#cb-initial-banner.cb-banner .cb-banner-body > p{color:rgba(0,0,0,0.8);}.cb-gdpr-accordion{margin-top:4px;margin-bottom:4px;}.cb-gdpr-cat-label{color:#0f172a;}.cb-gdpr-cat-desc{color:#64748b;}.cb-banner p{margin:0 0 12px;font-size:14px!important;line-height:1.5!important;color:#334155;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}.cb-banner-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;align-items:center;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}"+(l&&"banner"===l.bannerLayoutVisual?"#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}":"")+".cb-banner button{padding:12px 32px;border-radius:0.375rem;cursor:pointer;font-size:14px;font-weight:600;border:1px solid #e2e8f0;transition:opacity 0.2s;white-space:normal;word-break:break-word;min-width:0;text-align:center;}@media (max-width:660px){#cb-initial-banner.cb-banner{width:100vw!important;max-width:100vw!important;left:0!important;right:0!important;bottom:0!important;transform:none!important;border-radius:0!important;border-left:none!important;border-right:none!important;border-bottom:none!important;padding-bottom:calc(56px + 8px)!important;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;justify-content:stretch;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 100%;min-width:0;width:100%;box-sizing:border-box;}.cb-banner-footer{justify-content:stretch;}.cb-banner-footer button{flex:1 1 auto;max-width:100%;}}@media (max-width:420px){.cb-banner-footer button{flex:1 1 100%;}}@media (max-width:350px){#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{font-size:12px!important;}#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-size:13px!important;}#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,.cb-gdpr-cat-desc{font-size:12px!important;}#cb-initial-banner.cb-banner .cb-banner-footer button,#cb-preferences-banner.cb-banner .cb-banner-footer button{font-size:12px!important;padding:10px 16px!important;}}.cb-banner button:hover:not(.cb-pref-toggle-track){opacity:0.8;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{display:block !important;width:40px !important;min-width:40px !important;height:22px !important;padding:0 !important;margin:0 !important;border:none !important;border-radius:11px !important;background:#d1d5db !important;box-shadow:none !important;flex-shrink:0 !important;position:relative !important;overflow:visible !important;box-sizing:border-box !important;cursor:pointer !important;appearance:none !important;-webkit-appearance:none !important;font-size:0 !important;line-height:0 !important;opacity:1 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{background:#22c55e !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{content:'' !important;position:absolute !important;top:2px !important;left:2px !important;width:18px !important;height:18px !important;border-radius:50% !important;background:#ffffff !important;box-shadow:0 1px 3px rgba(0,0,0,.2) !important;pointer-events:none !important;transition:left .15s ease !important;z-index:2 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{left:20px !important;}.cb-banner button#cb-accept-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-reject-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-preferences-btn,.cb-banner button#cb-ccpa-donotsell-link{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner button#cb-prefs-reject-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner label{display:block;margin-bottom:6px;font-size:11px;color:#334155;}.cb-banner input[type='checkbox']{margin-right:6px;}.cb-banner a{color:#007aff;text-decoration:underline;font-size:11px;}@keyframes slideInFromLeft{from{transform:translateX(-100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromRight{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromTop{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes slideInFromBottom{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}@keyframes prefsSlideInFromLeft{from{transform:translate(-120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideInFromRight{from{transform:translate(120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideCenterFromBottom{from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes prefsSlideCenterFromTop{from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes zoomIn{from{transform:scale(0.85);opacity:0;}to{transform:scale(1);opacity:1;}}@keyframes cbInitialCenterSlideFromBottom{from{transform:translate(-50%,100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterSlideFromTop{from{transform:translate(-50%,-100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterZoomIn{from{transform:translateX(-50%) scale(0.85);opacity:0;}to{transform:translateX(-50%) scale(1);opacity:1;}}.cb-banner-animate-initial-center-bottom{animation:cbInitialCenterSlideFromBottom 0.35s ease-out;}.cb-banner-animate-initial-center-top{animation:cbInitialCenterSlideFromTop 0.35s ease-out;}.cb-banner-animate-initial-center-zoom{animation:cbInitialCenterZoomIn 0.3s ease-out;}@keyframes prefsZoomIn{from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}to{transform:translate(-50%,-50%) scale(1);opacity:1;}}.cb-banner-animate-left{animation:slideInFromLeft 0.4s ease-out;}.cb-banner-animate-right{animation:slideInFromRight 0.4s ease-out;}.cb-banner-animate-top{animation:slideInFromTop 0.4s ease-out;}.cb-banner-animate-bottom{animation:slideInFromBottom 0.4s ease-out;}.cb-banner-animate-fade{animation:fadeIn 0.3s ease-out;}.cb-banner-animate-prefs-left{animation:prefsSlideInFromLeft 0.4s ease-out;}.cb-banner-animate-prefs-right{animation:prefsSlideInFromRight 0.4s ease-out;}.cb-banner-animate-center-top{animation:prefsSlideCenterFromTop 0.35s ease-out;}.cb-banner-animate-center-bottom{animation:prefsSlideCenterFromBottom 0.35s ease-out;}.cb-banner-animate-zoom-in{animation:zoomIn 0.3s ease-out;}.cb-banner-animate-prefs-zoom-in{animation:prefsZoomIn 0.3s ease-out;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}#cb-initial-banner.cb-banner .cb-banner-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex-shrink:0;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}#cb-initial-banner.cb-banner #cb-preferences-btn{background:#ffffff!important;color:#334155!important;border:1px solid #334155!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-initial-banner.cb-banner #cb-reject-all-btn,#cb-initial-banner.cb-banner #cb-accept-all-btn{background:#007aff!important;color:#ffffff!important;border-color:#007aff!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-floating-trigger{position:fixed;z-index:2147483648;width:40px;height:40px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;}#cb-floating-trigger img,#cb-floating-trigger svg{display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none;}";e.styles&&(D=D+"\\n"+e.styles);var M="cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in";Oe();"complete"===document.readyState||"interactive"===document.readyState?He():window.addEventListener("DOMContentLoaded",He)}function R(){if(h){var e=(navigator.language||navigator.userLanguage||"en").split("-")[0].toLowerCase();return TRANSLATIONS[e]?e:"en"}return y}function U(e){var t=R();var n=TRANSLATIONS[t]||TRANSLATIONS.en;var a=null!=n[e]?n[e]:null!=TRANSLATIONS.en[e]?TRANSLATIONS.en[e]:"";return""===a&&"title"===e?"We value your privacy":""===a&&"description"===e?"We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.":a}function W(e){var t=R();var n;var a=(TRANSLATIONS[t]||TRANSLATIONS.en)[e];a&&a.length>80&&(a=TRANSLATIONS.en[e]||e);return a||TRANSLATIONS.en[e]||e}function J(e,t){var n=null==e?"":String(e);return n.length>t?n.slice(0,t):n}function Y(e,t){return J(U(e),t)}function X(){try{var e=R();var t;var n=(TRANSLATIONS[e]||TRANSLATIONS.en||{}).cookiePolicyLinkEnabled;return!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function q(){try{var e=R();var t;var n=(TRANSLATIONS[e]||TRANSLATIONS.en||{}).closeButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function H(e){var t=String(e||"bottom-left").trim().toLowerCase().replace(/_/g,"-");return"bottom-right"===t||"right"===t?"bottom-right":"bottom"===t?"bottom":"bottom-left"}function V(e){if(e){e.style.marginLeft="";e.style.marginRight="";e.style.paddingLeft="";e.style.paddingRight="";if(De()){var t=p||"box";var n=H(l&&l.position);var a=Me();var r="56px";"banner"!==t?"left"===a?"bottom-center"!==t&&"popup"!==t&&"bottom"!==n&&"bottom-left"!==n||(e.style.marginLeft=r):"bottom-center"!==t&&"popup"!==t&&"bottom"!==n&&"bottom-right"!==n||(e.style.marginRight=r):"left"===a?e.style.paddingLeft=r:e.style.paddingRight=r}}}function Z(e){if(!e)return!1;var t=p||"box";var n=H(l&&l.position);e.style.left="";e.style.right="";e.style.top="";e.style.bottom="";e.style.transform="";e.style.width="";e.style.maxWidth="";e.style.marginLeft="";e.style.marginRight="";e.style.paddingLeft="";e.style.paddingRight="";if("banner"===t){e.style.left="0";e.style.right="0";e.style.bottom="0";e.style.transform="none";e.style.width="100%";e.style.maxWidth="none";e.setAttribute("data-cb-initial-centered","0");V(e);return!1}if("bottom-center"===t||"popup"===t||"bottom"===n){e.style.bottom="32px";e.style.left="50%";e.style.transform="translateX(-50%)";e.setAttribute("data-cb-initial-centered","1");V(e);return!0}e.style.bottom="32px";"bottom-right"===n?e.style.right="32px":e.style.left="32px";e.style.transform="none";e.setAttribute("data-cb-initial-centered","0");V(e);return!1}function $(e){var t=e;var n=t.indexOf("#");n>=0&&(t=t.slice(0,n));(n=t.indexOf("?"))>=0&&(t=t.slice(0,n));(n=t.indexOf("/"))>=0&&(t=t.slice(0,n));return t.trim()}function G(e){var t=e.lastIndexOf(".");if(t<0)return!1;var n=e.slice(t).toLowerCase();return".js"===n||".mjs"===n||".css"===n||".png"===n||".jpg"===n||".jpeg"===n||".gif"===n||".svg"===n||".webp"===n||".pdf"===n||".json"===n||".xml"===n||".ico"===n||".woff"===n||".woff2"===n}function K(e){if(!e||"string"!=typeof e)return"";var t=e.trim();if(!t)return"";var n=t.toLowerCase();if(0===n.indexOf("mailto:")||0===n.indexOf("tel:"))return t;if(0===n.indexOf("http://")||0===n.indexOf("https://"))return t;if(0===t.indexOf("//"))return"https:"+t;if("/"===t.charAt(0)||0===t.indexOf("./")||0===t.indexOf("../")){try{if("undefined"!=typeof window&&window.location)return new URL(t,window.location.href).href}catch(e){}return t}var a=$(t);if(a.indexOf(".")>0&&!G(a)){for(;t.length>0&&"/"===t.charAt(0);)t=t.slice(1);return"https://"+t}try{if("undefined"!=typeof window&&window.location)return new URL(t,window.location.href).href}catch(e){}return t}function Q(e,t){var n=K(t);if(n){e.href=n;e.target="_blank";e.rel="noopener noreferrer";e.addEventListener("click",function(e){e.stopPropagation&&e.stopPropagation();e.preventDefault&&e.preventDefault();try{window.open(n,"_blank","noopener,noreferrer")}catch(e){}},!0)}}function ee(){try{var e=localStorage.getItem(I);var t=e?JSON.parse(e):{accepted:!1,timestamp:null};if(!t||!t.accepted)return t||{accepted:!1,timestamp:null};var n=Date.now();var a=24*O*60*60*1e3;var r=t.expiresAt?new Date(t.expiresAt).getTime():t.timestamp?new Date(t.timestamp).getTime()+a:0;return r>0&&n>r?{accepted:!1,timestamp:null}:t}catch(e){console.warn("[ConsentBit] Failed to read consent from localStorage",e);return{accepted:!1,timestamp:null}}}function te(e){try{var t=24*O*60*60*1e3;e.expiresAt=e.expiresAt||new Date(Date.now()+t).toISOString();localStorage.setItem(I,JSON.stringify(e))}catch(e){console.warn("[ConsentBit] Failed to save consent state",e)}A=e;try{ke()}catch(e){console.warn("[ConsentBit] releaseBlockedScripts failed",e)}try{_e()}catch(e){console.warn("[ConsentBit] releaseBlockedPixels failed",e)}}function ne(e){try{var t={analytics:!!e.analytics,preferences:!!e.preferences,marketing:!!e.marketing};var n=btoa(JSON.stringify(t));localStorage.setItem(B,n)}catch(e){console.warn("[ConsentBit] Failed to save preference toggles",e)}}function ae(){try{var e=localStorage.getItem(B);if(!e)return null;var t=JSON.parse(atob(e));return t&&"object"==typeof t?{analytics:!!t.analytics,preferences:!!t.preferences,marketing:!!t.marketing}:null}catch(e){console.warn("[ConsentBit] Failed to load preference toggles",e);return null}}function re(e,t){if(r&&c){t=t||{};var n=e&&e.expiresAt||t.expiresAt||new Date(Date.now()+24*O*60*60*1e3).toISOString();var a={siteId:r,regulation:"gdpr"===i?"gdpr":"ccpa",bannerType:i,consentMethod:t.consentMethod||"banner",status:t.status||"given",expiresAt:n,consent:e};try{fetch(c+"/api/consent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(a)}).catch(function(e){console.warn("[ConsentBit] /api/consent failed",e)})}catch(e){console.warn("[ConsentBit] /api/consent threw",e)}}}function ie(){try{var e=localStorage.getItem(L);if(!e)return!1;var t=JSON.parse(e);var n=new Date;var a=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0");return t.yearMonth===a&&!0===t.overLimit}catch(e){return!1}}function oe(e){try{localStorage.setItem(L,JSON.stringify({overLimit:!0,yearMonth:e}))}catch(e){}}function ce(){if(r&&c&&!ie())try{var e={siteId:r,pageUrl:"undefined"!=typeof window&&window.location?window.location.href:null};fetch(c+"/api/pageview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e),keepalive:!0}).then(function(e){return e.json()}).then(function(e){if(e&&e.overLimit){var t=new Date;var n;oe(e.yearMonth||t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0"))}}).catch(function(e){console.warn("[ConsentBit] /api/pageview failed",e)})}catch(e){console.warn("[ConsentBit] /api/pageview threw",e)}}function se(){try{var e="undefined"!=typeof document&&document.cookie?document.cookie:"";return e?e.split(";").map(function(e){return e.trim()}).filter(Boolean):[]}catch(e){return[]}}function le(){try{var e=[];var t=document.getElementsByTagName("script");for(var n=0;n<t.length;n++){var a=t[n].src;a&&-1===a.indexOf("consentbit")&&-1===a.indexOf("client_data")&&e.push(a)}return e}catch(e){return[]}}function de(e){try{var t;var n=new URL(e).hostname;return-1!==n.indexOf("google-analytics.com")||-1!==e.indexOf("gtag/js")||-1!==n.indexOf("googletagmanager.com")?"analytics":-1!==n.indexOf("facebook.com")||-1!==n.indexOf("fbcdn.net")||-1!==n.indexOf("doubleclick.net")||0===n.indexOf("ads.")?"marketing":-1!==n.indexOf("hotjar.com")||-1!==n.indexOf("intercom.io")||-1!==n.indexOf("fullstory.com")?"behavioral":"uncategorized"}catch(e){return"uncategorized"}}function pe(){var e={};var t=[];var n=document.scripts;for(var a=0;a<n.length;a++){var r=n[a];if(r.src&&!e[r.src]){e[r.src]=!0;t.push(r)}}return t}function be(){var e=document.scripts;for(var t=0;t<e.length;t++){var n=e[t];var a=n.src||n.getAttribute("data-cb-blocked-src")||"";if(-1!==a.indexOf("googletagmanager.com/gtag/js")||-1!==a.indexOf("googletagmanager.com/gtm.js")||-1!==a.indexOf("google-analytics.com"))return!0}return!1}function fe(e){return"analytics"===e||"marketing"===e||"behavioral"===e||"advertisement"===e||"functional"===e||"performance"===e}function me(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("googletagmanager.com/gtag/js")||-1!==t.indexOf("googletagmanager.com/gtm.js")||-1!==t.indexOf("google-analytics.com")}function ue(e){var t=e;"behavioral"===t&&(t="analytics");if("essential"===t)return!0;if("ccpa"===i){return!(A&&A.accepted&&A.ccpa&&A.ccpa.doNotSell&&fe(t));var n}if(!A||!A.accepted)return!1;var a=A.categories||{};return"analytics"===t?!!a.analytics:"marketing"===t||"advertisement"===t?!!a.marketing:"preferences"!==t&&"functional"!==t&&"performance"!==t||!!a.preferences}function ge(e){if(!e)return null;var t=String(e).toLowerCase().trim();if("analytics"===t||"marketing"===t||"behavioral"===t||"preferences"===t||"essential"===t)return["essential"===t?"essential":t];var n=t;return n.indexOf("necessary")>=0||n.indexOf("essential")>=0?["essential"]:n.indexOf("functional")>=0||n.indexOf("preference")>=0?["preferences"]:n.indexOf("analytics")>=0||n.indexOf("performance")>=0||n.indexOf("statistics")>=0?["analytics"]:n.indexOf("advertisement")>=0||n.indexOf("marketing")>=0||n.indexOf("ads")>=0||n.indexOf("social")>=0?["marketing"]:n.indexOf("other")>=0?["analytics"]:null}function ve(e,t){if(t&&t.getAttribute){var n=ge(t.getAttribute("data-consentbit"));if(n)return n;var a=t.getAttribute("data-consentbit-category");if(a){var r=String(a).toLowerCase().trim();if("analytics"===r||"marketing"===r||"behavioral"===r||"preferences"===r||"essential"===r)return[r]}var i=ge(t.getAttribute("data-cookieyes"));if(i)return i}if(e&&j.length)for(var o=0;o<j.length;o++){var c=j[o];if(c&&c.pattern)try{if(new RegExp(c.pattern,"i").test(e))return c.categories&&c.categories.length?c.categories.slice():["analytics"]}catch(e){}}if(e&&P.length)for(var s=0;s<P.length;s++){var l=P[s];if(l&&l.scriptUrlPattern)try{if(new RegExp(l.scriptUrlPattern,"i").test(e))return[l.category||"uncategorized"]}catch(e){}}return[]}function ye(e,t){if(z)return!1;if(!e||"string"!=typeof e)return!1;var n=e.toLowerCase();if(-1!==n.indexOf("consentbit")||-1!==n.indexOf("client_data"))return!1;var a=ve(e,t);if(!a||0===a.length)return!1;if("ccpa"===i)return!!(A&&A.accepted&&A.ccpa&&A.ccpa.doNotSell);for(var r=0;r<a.length;r++){var o=a[r];if(fe(o)&&!("analytics"===o&&me(e)||ue(o)))return!0}return!1}function he(e){if(e&&"SCRIPT"===e.nodeName&&(!e.getAttribute||"javascript/blocked"!==e.getAttribute("type"))){var t=e.getAttribute&&e.getAttribute("src")||e.src||"";if(t){var n=ve(t,e);var a=n.length>0?n[0]:"uncategorized";if(ye(t,e))try{e.setAttribute("data-cb-blocked-src",t);e.setAttribute("type","javascript/blocked");e.removeAttribute("src")}catch(e){}}}}function xe(e){if(e&&!e.__cbPatched){e.__cbPatched=!0;try{Object.defineProperty(e,"src",{configurable:!0,enumerable:!0,get:function(){return e.getAttribute("src")||""},set:function(t){var n=ve(t,e);var a=n.length>0?n[0]:"uncategorized";if(ye(t,e)){e.setAttribute("data-cb-blocked-src",t);e.setAttribute("type","javascript/blocked");e.removeAttribute("src")}else e.setAttribute("src",t)}})}catch(e){}try{Object.defineProperty(e,"type",{configurable:!0,enumerable:!0,get:function(){return e.getAttribute("type")||""},set:function(t){var n=t;ye(e.getAttribute("src")||e.src||"",e)&&(n="javascript/blocked");e.setAttribute("type",n)}})}catch(e){}}}function we(e){if(e&&1===e.nodeType)if("SCRIPT"!==e.nodeName){if(e.querySelectorAll){var t=e.querySelectorAll("script[src]");for(var n=0;n<t.length;n++)he(t[n])}}else he(e)}function ke(e){if(window.__CB_WEBFLOW_MODE__)Ie(e||{analytics:!0,marketing:!0,preferences:!0,essential:!0});else{var t=document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');var n=0;var a=0;var r=[];var i=[];for(var o=0;o<t.length;o++){var c=t[o];var s=c.getAttribute("data-cb-blocked-src");if(s)if(ye(s,c)){a++;r.push(s)}else{z=!0;try{var l=document.createElement("script");l.async=c.hasAttribute("async");l.defer=c.hasAttribute("defer");l.crossOrigin=c.crossOrigin||"";l.integrity=c.integrity||"";l.referrerPolicy=c.referrerPolicy||"";c.id&&(l.id=c.id);l.src=s;var d=c.attributes;for(var p=0;p<d.length;p++){var b=d[p].name;"src"!==b&&"type"!==b&&"data-cb-blocked-src"!==b&&l.setAttribute(b,d[p].value)}c.parentNode?c.parentNode.replaceChild(l,c):document.head.appendChild(l);n++;i.push(s)}catch(e){console.warn("[ConsentBit][Release] Failed to release script:",s,e)}finally{z=!1}}}i.length&&console.log("[ConsentBit][Release] Released:",i);r.length&&console.log("[ConsentBit][Release] Still blocked:",r)}}function Ce(e){if(!e||"string"!=typeof e)return null;var t=e.toLowerCase();if(0!==t.indexOf("http"))return null;for(var n=0;n<F.length;n++)if(-1!==t.indexOf(F[n].domain))return F[n].category;for(var a=0;a<P.length;a++){var r=P[a];if(r&&r.scriptUrlPattern)try{if(new RegExp(r.scriptUrlPattern,"i").test(e))return r.category||"marketing"}catch(e){}}return null}function Ee(e){var t=Ce(e);return!(!t||!fe(t)||("ccpa"===i?!(A&&A.accepted&&A.ccpa&&A.ccpa.doNotSell):A&&A.accepted&&ue(t)))}function Se(e){if(e&&!e.__cbImgPatched){e.__cbImgPatched=!0;try{Object.defineProperty(e,"src",{configurable:!0,enumerable:!0,get:function(){return e.getAttribute("src")||""},set:function(t){if(Ee(t)){e.setAttribute("data-cb-blocked-src",t);e.removeAttribute("src")}else e.setAttribute("src",t)}})}catch(e){}}}function _e(){var e=document.querySelectorAll("img[data-cb-blocked-src]");for(var t=0;t<e.length;t++){var n=e[t];var a=n.getAttribute("data-cb-blocked-src");if(a&&!Ee(a)){n.removeAttribute("data-cb-blocked-src");n.src=a}}}function Ie(e){if(window.__CB_WEBFLOW_MODE__){var t=e||{};window.userConsent=t;try{document.dispatchEvent(new CustomEvent("consentUpdated",{detail:t,bubbles:!0}))}catch(e){}}}function Oe(){if(!window.__CB_WEBFLOW_MODE__&&!window.__cbCreateElementHookInstalled){window.__cbCreateElementHookInstalled=!0;try{N=document.createElement.bind(document)}catch(e){N=document.createElement}try{var e=window.Image;window.Image=function(t,n){var a=new e(t,n);Se(a);return a};window.Image.prototype=e.prototype}catch(e){}document.createElement=function(e){var t=N(e);var n=String(e||"").toLowerCase();"script"===n?xe(t):"img"!==n&&"iframe"!==n||Se(t);return t};var t=new MutationObserver(function(e){for(var t=0;t<e.length;t++){var n=e[t];if("childList"===n.type){var a=n.addedNodes;for(var r=0;r<a.length;r++)we(a[r])}else"attributes"===n.type&&"src"===n.attributeName&&n.target&&"SCRIPT"===n.target.nodeName&&he(n.target)}});try{t.observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["src"]})}catch(e){t.observe(document.documentElement,{childList:!0,subtree:!0})}window.__cbMutationObserver=t}}function Ae(){if(window.__CB_WEBFLOW_MODE__)try{document.dispatchEvent(new CustomEvent("cbBlockScripts",{detail:{},bubbles:!0}))}catch(e){}else{var e=pe();var t=0;var n=0;var a=0;var r=[];var i=[];for(var o=0;o<e.length;o++){var c=e[o];var l=c.src;if("javascript/blocked"!==c.getAttribute("type")){var d=ve(l,c);var p=d.length>0?d[0]:"uncategorized";if(fe(p))if("analytics"===p&&s&&me(l)){n++;i.push({src:l,category:p,reason:"ga-cookieless"})}else if(ue(p)){n++;i.push({src:l,category:p,reason:"consent-granted"})}else try{c.setAttribute("data-cb-blocked-src",l);c.setAttribute("type","javascript/blocked");c.removeAttribute("src");t++;r.push({src:l,category:p})}catch(e){console.warn("[ConsentBit][Block] Failed to block script:",l,e)}else{n++;i.push({src:l,category:p,reason:"essential"})}}else a++}}}function Be(){if(T.length){var e=[];z=!0;try{for(var t=0;t<T.length;t++){var n=T[t];var a=n.cats||(n.category?[n.category]:[]);var r;if(0===a.length||a.every(function(e){return!fe(e)||ue(e)})){var i=document.createElement("script");i.src=n.src;var o=n.attrs;for(var c in o)Object.prototype.hasOwnProperty.call(o,c)&&"src"!==c&&i.setAttribute(c,o[c]);document.head.appendChild(i)}else e.push(n)}}finally{z=!1}T=e}}function Le(){if(s){z=!0;try{var e=!1;var t=document.scripts;for(var n=0;n<t.length;n++){var a;var r=t[n].src||"";if(-1!==r.indexOf("googletagmanager.com/gtag/js")||-1!==r.indexOf("googletagmanager.com/gtm.js")||-1!==r.indexOf("google-analytics.com")){e=!0;break}}if(!e){var i=document.createElement("script");i.async=!0;i.src="https://www.googletagmanager.com/gtag/js?id="+s;document.head.appendChild(i)}window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}window.gtag=gtag;gtag("consent","default",{ad_storage:"denied",analytics_storage:"denied",ad_user_data:"denied",ad_personalization:"denied"});gtag("js",new Date);gtag("config",s,{anonymize_ip:!0,allow_google_signals:!1,allow_ad_personalization_signals:!1});gtag("event","page_view",{page_path:window.location.pathname,page_title:document.title||""})}finally{z=!1}}}function Te(e,t){if(s||be()){var n={analytics_storage:e.analytics?"granted":"denied",ad_storage:e.marketing?"granted":"denied",ad_user_data:e.marketing?"granted":"denied",ad_personalization:e.preferences?"granted":"denied"};if(window.gtag)window.gtag("consent","update",n);else{var a=0;var r=setInterval(function(){a++;if(window.gtag){clearInterval(r);window.gtag("consent","update",n)}else if(a>=20){clearInterval(r);console.warn("[ConsentBit]"+(t||"")+" window.gtag unavailable after 2s — consent NOT updated")}},100)}}else console.warn("[ConsentBit]"+(t||"")+" No Google tracking detected — gtag update skipped")}function ze(){if(!document.getElementById("cb-styles")){var e;var t;var n="#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{background-color:"+(l&&l.customiseButtonBg?String(l.customiseButtonBg):"#ffffff")+" !important;color:"+(l&&l.customiseButtonText?String(l.customiseButtonText):"#334155")+" !important;border-color:#e2e8f0 !important;}";var a="";if(l&&l.backgroundColor){var r=String(l.backgroundColor);a="#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{background-color:"+r+" !important;}.cb-gdpr-accordion{background-color:"+r+" !important;}"}var i="";if(l&&l.headingColor){var o=String(l.headingColor);i="#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{color:"+o+" !important;}.cb-gdpr-cat-label{color:"+o+" !important;}"}var c="";if(l&&l.textColor){var s;c="#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{color:"+String(l.textColor)+" !important;}"}var d="";if(l&&l.bannerFontWeight){var p=String(l.bannerFontWeight);d="#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-weight:"+p+" !important;}.cb-gdpr-cat-label{font-weight:"+p+" !important;}.cb-gdpr-cat-desc{font-weight:"+p+" !important;}.cb-banner p{font-weight:"+p+" !important;}"}var b="#cb-preferences-banner.cb-banner h3{padding-right:36px !important;}";var f="#cb-preferences-banner.cb-banner .cb-banner-body{padding-right:4px;}#cb-preferences-banner.cb-banner .cb-gdpr-accordion > div{margin-right:2px;}";if(!document.getElementById("cb-font-montserrat")){var m=document.createElement("link");m.id="cb-font-montserrat";m.rel="stylesheet";m.href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap";document.head.appendChild(m)}var u=document.createElement("style");u.id="cb-styles";u.type="text/css";u.appendChild(document.createTextNode(D+"\\n"+n+"\\n"+a+"\\n"+i+"\\n"+c+"\\n"+d+"\\n"+b+"\\n"+f));document.head.appendChild(u)}}function Ne(e,t){if(q()){var n=document.createElement("button");n.type="button";n.id=t;n.setAttribute("aria-label","Close");n.textContent="×";n.style.cssText="position:absolute;top:8px;right:24px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:#0f172a;opacity:0.75;";e.appendChild(n)}}function je(e){if(q()){var t=document.createElement("button");t.type="button";t.id="cb-close-prefs-btn";t.setAttribute("aria-label","Close");t.textContent="×";t.style.cssText="position:absolute;top:8px;right:30px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:#0f172a;opacity:0.75;";e.appendChild(t)}}function Pe(){if(!document.getElementById("cb-initial-banner"))if(document.body){var e="ccpa"===i;var t=document.createElement("div");if(e){var n;(n=document.createElement("div")).className="cb-banner";n.id="cb-initial-banner";n.style.display="none";var a;(a=document.createElement("div")).className="cb-banner-body";var r;(r=document.createElement("h3")).textContent=Y("title",w);a.appendChild(r);var o=document.createElement("p");var c=J(U("description"),k);if(b&&X()){o.appendChild(document.createTextNode(c+" "));var s;(s=document.createElement("a")).textContent=Y("privacyPolicy",E);s.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";Q(s,b);o.appendChild(s);o.appendChild(document.createTextNode("."))}else o.textContent=c;a.appendChild(o);var l=document.createElement("p");l.style.marginTop="8px";l.style.marginBottom="0";var d=document.createElement("button");d.id="cb-ccpa-donotsell-link";d.type="button";d.textContent=U("doNotSell");d.style.cssText="background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;font-size:11px;text-align:left;display:inline;";l.appendChild(d);a.appendChild(l);n.appendChild(a);Ne(n,"cb-close-initial-btn");t.appendChild(n);var p;(p=document.createElement("div")).className="cb-banner cb-ccpa-prefs";p.id="cb-preferences-banner";p.style.display="none";"left"===g?p.classList.add("prefs-left"):"right"===g?p.classList.add("prefs-right"):p.classList.add("prefs-center");var v;(v=document.createElement("div")).className="cb-banner-body";var y;(y=document.createElement("h3")).textContent=U("optOutPreference");v.appendChild(y);var h=document.createElement("p");var x=(U("ccpaOptOutPreferenceIntro")||U("ccpaOptOut")||"").replace(/\s*More info\.?\s*$/i,"").trim();if(b&&X()){h.appendChild(document.createTextNode(x+" "));var S=document.createElement("a");S.textContent=U("privacyPolicy");S.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";Q(S,b);h.appendChild(S);h.appendChild(document.createTextNode("."))}else h.textContent=x;h.style.lineHeight="1.45";v.appendChild(h);var _=document.createElement("label");_.style.cssText="display:flex;align-items:flex-start;gap:12px;margin-top:12px;font-size:11px;cursor:pointer;";var I=document.createElement("span");I.style.cssText="flex:1;line-height:1.45;";I.textContent=U("doNotSell");var O=document.createElement("input");O.type="checkbox";O.id="cb-ccpa-optout";O.style.cssText="flex-shrink:0;margin-top:2px;";O.checked=!!(A&&A.accepted&&A.ccpa&&A.ccpa.doNotSell);_.appendChild(O);_.appendChild(I);v.appendChild(_);p.appendChild(v);var B;(B=document.createElement("div")).className="cb-banner-footer";var L=document.createElement("button");L.id="cb-cancel-prefs-btn";L.textContent=W("cancel");B.appendChild(L);var T;(T=document.createElement("button")).id="cb-save-prefs-btn";var z=U("saveMyPreferences")||U("save");console.log("[ConsentBit] saveMyPreferences translation:",z,"| TRANSLATIONS.en:",JSON.stringify(TRANSLATIONS&&TRANSLATIONS.en&&TRANSLATIONS.en.saveMyPreferences));T.textContent=z;B.appendChild(T);p.appendChild(B);je(p);t.appendChild(p)}else{var N=function(e){var t=document.createElement("div");t.style.borderBottom="1px solid #e5e7eb";var n=document.createElement("div");n.style.cssText="display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";var a=document.createElement("button");a.type="button";a.setAttribute("aria-expanded","false");a.textContent="+";a.style.cssText="flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";var r=document.createElement("span");r.className="cb-gdpr-cat-label";r.style.cssText="flex:1;font-size:11px;font-weight:600;";r.textContent=e.labelText;n.appendChild(a);n.appendChild(r);var i=document.createElement("div");i.style.flexShrink="0";if(e.alwaysActive){var o=document.createElement("span");o.style.cssText="font-size:11px;font-weight:600;color:#374151;";o.textContent=U("alwaysActive");i.appendChild(o)}else{var c=document.createElement("input");c.type="checkbox";c.id=e.checkboxId;e.defaultChecked&&(c.checked=!0);c.style.cssText="position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";var s=document.createElement("button");s.type="button";s.className="cb-pref-toggle-track";s.setAttribute("role","switch");s.setAttribute("aria-label",e.labelText);var l=function(){s.setAttribute("aria-checked",c.checked?"true":"false")};s.addEventListener("click",function(){c.checked=!c.checked;l()});l();i.appendChild(c);i.appendChild(s)}n.appendChild(i);var d=document.createElement("div");d.className="cb-gdpr-cat-desc";d.style.cssText="display:none;padding:0 12px 12px 44px;font-size:13px;line-height:1.5;";d.textContent=e.descText;a.addEventListener("click",function(){var e="none"===d.style.display;d.style.display=e?"block":"none";a.textContent=e?"−":"+";a.setAttribute("aria-expanded",e?"true":"false")});t.appendChild(n);t.appendChild(d);return t};var n;(n=document.createElement("div")).className="cb-banner";n.id="cb-initial-banner";n.style.display="none";var a;(a=document.createElement("div")).className="cb-banner-body";var r;(r=document.createElement("h3")).textContent=U("title");a.appendChild(r);var o=document.createElement("p");var c=U("description");if(b&&X()){o.appendChild(document.createTextNode(c+" "));var s;(s=document.createElement("a")).textContent=U("privacyPolicy");s.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";Q(s,b);o.appendChild(s);o.appendChild(document.createTextNode("."))}else o.textContent=c;a.appendChild(o);n.appendChild(a);var j=document.createElement("div");j.className="cb-banner-footer";var P=document.createElement("button");P.id="cb-preferences-btn";P.textContent=J(W("customise"),C);j.appendChild(P);var F=document.createElement("button");F.id="cb-reject-all-btn";F.textContent=J(W("rejectAll"),C);j.appendChild(F);var D=document.createElement("button");D.id="cb-accept-all-btn";D.textContent=J(W("acceptAll"),C);j.appendChild(D);n.appendChild(j);Ne(n,"cb-close-initial-btn");t.appendChild(n);var p;(p=document.createElement("div")).className="cb-banner";p.id="cb-preferences-banner";p.style.display="none";"left"===g?p.classList.add("prefs-left"):"right"===g?p.classList.add("prefs-right"):p.classList.add("prefs-center");var v;(v=document.createElement("div")).className="cb-banner-body";var y;(y=document.createElement("h3")).textContent=Y("cookiePreferences",w);v.appendChild(y);var h=document.createElement("p");var M=(J(U("managePreferences"),k)||"").replace(/\s*More info\.?\s*$/i,"").trim();if(b&&X()){h.appendChild(document.createTextNode(M+" "));var R=document.createElement("a");R.textContent=Y("privacyPolicy",E);R.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";Q(R,b);h.appendChild(R);h.appendChild(document.createTextNode("."))}else h.textContent=M;v.appendChild(h);var q=document.createElement("div");q.className="cb-gdpr-accordion";q.style.cssText="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";var H=U("strictlyNecessary")||U("essential");q.appendChild(N({labelText:H,alwaysActive:!0,descText:U("essentialDescription")}));var V;var $=ae()||A&&A.accepted&&A.categories||{};q.appendChild(N({labelText:U("marketing"),checkboxId:"cb-pref-marketing",defaultChecked:!!$.marketing,descText:U("marketingDescription")}));q.appendChild(N({labelText:U("analytics"),checkboxId:"cb-pref-analytics",defaultChecked:!!$.analytics,descText:U("analyticsDescription")}));q.appendChild(N({labelText:U("preferences"),checkboxId:"cb-pref-preferences",defaultChecked:!!$.preferences,descText:U("preferencesDescription")}));q.lastChild&&(q.lastChild.style.borderBottom="none");v.appendChild(q);p.appendChild(v);var B;(B=document.createElement("div")).className="cb-banner-footer";var G=document.createElement("button");G.id="cb-prefs-reject-btn";G.textContent=J(W("rejectAll"),C);B.appendChild(G);var T;(T=document.createElement("button")).id="cb-save-prefs-btn";T.textContent=J(W("saveMyPreferences")||W("save"),C);B.appendChild(T);p.appendChild(B);je(p);t.appendChild(p)}document.body.appendChild(t);f&&(document.body.style.overflow="hidden");var K=document.getElementById("cb-initial-banner");if(K){var ee=Z(K);K.style.display="flex";K.style.visibility="visible";K.style.opacity="1";if(m){var te="";var ne=u;te=ee?"slide-up"===u?"cb-banner-animate-initial-center-bottom":"slide-down"===u?"cb-banner-animate-initial-center-top":"zoom-in"===u?"cb-banner-animate-initial-center-zoom":"cb-banner-animate-fade":"slide-up"===u?"cb-banner-animate-bottom":"slide-down"===u?"cb-banner-animate-top":"zoom-in"===u?"cb-banner-animate-zoom-in":"cb-banner-animate-fade";K.classList.add(te)}}else console.error("[ConsentBit] Failed to find banner element after creation!")}else{console.warn("[ConsentBit] document.body not ready, retrying...");setTimeout(Pe,100)}}function Fe(){f&&(document.body.style.overflow="")}function De(){try{if(l&&!1===l.showBannerLogo)return!1;if(l&&0===l.showBannerLogo)return!1;var e=R();var t;var n=(TRANSLATIONS[e]||TRANSLATIONS.en||{}).floatingButtonEnabled;return!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function Me(){try{if(l&&l.bannerLogoPosition)return"right"===l.bannerLogoPosition?"right":"left";var e=R();var t;return"right"===(TRANSLATIONS[e]||TRANSLATIONS.en||{}).floatingButtonPosition?"right":"left"}catch(e){return"left"}}function Re(){var e="http://www.w3.org/2000/svg";var t=document.createElementNS(e,"svg");t.setAttribute("xmlns",e);t.setAttribute("viewBox","0 0 40 40");t.setAttribute("width","28");t.setAttribute("height","28");t.setAttribute("aria-hidden","true");t.setAttribute("focusable","false");t.style.cssText="display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none;";var n=document.createElementNS(e,"circle");n.setAttribute("cx","20");n.setAttribute("cy","20");n.setAttribute("r","18");n.setAttribute("fill","#007aff");t.appendChild(n);var a=[{cx:"14",cy:"14",r:"2.2"},{cx:"24",cy:"18",r:"2.5"},{cx:"17",cy:"25",r:"2"}];for(var r=0;r<a.length;r++){var i=document.createElementNS(e,"circle");i.setAttribute("cx",a[r].cx);i.setAttribute("cy",a[r].cy);i.setAttribute("r",a[r].r);i.setAttribute("fill","#ffffff");t.appendChild(i)}return t}function Ue(){try{var e=document.getElementsByTagName("script");for(var t=e.length-1;t>=0;t--){var n=e[t].src||"";if(-1!==n.indexOf("/consentbit/")||-1!==n.indexOf("/client_data/"))return new URL(n).origin}}catch(e){}return""}function We(){if(!document.getElementById("cb-floating-trigger")&&De()){var e=Me();var t=n||"";var r=a||"";if(!t){var i=Ue();if(i){t=i+"/embed/floating-logo.svg";r||(r=t)}}var o=document.createElement("button");o.id="cb-floating-trigger";o.type="button";o.setAttribute("aria-label",U("cookiePreferences"));o.style.cssText="position:fixed;bottom:16px;"+("right"===e?"right:16px;":"left:16px;")+"z-index:2147483646;width:40px;height:40px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;";if(t){var c=document.createElement("img");c.alt="";c.src=t;c.setAttribute("width","28");c.setAttribute("height","28");c.draggable=!1;c.style.cssText="display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none;";var s=!1;c.addEventListener("error",function e(){if(s||!r||t===r){c.removeEventListener("error",e);c.parentNode&&c.parentNode.replaceChild(Re(),c)}else{s=!0;c.src=r}});o.appendChild(c)}else o.appendChild(Re());document.body.appendChild(o)}}function Je(){if(!m)return"";var e=u;return"left"===g?"zoom-in"===u?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-prefs-left":"right"===g?"zoom-in"===u?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-prefs-right":"slide-up"===u?"cb-banner-animate-center-bottom":"slide-down"===u?"cb-banner-animate-center-top":"zoom-in"===u?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-fade"}function Ye(e){if(e){var t=M.split(" ");for(var n=0;n<t.length;n++)t[n]&&e.classList.remove(t[n])}}function Xe(){ze();Pe();We();var e=document.getElementById("cb-initial-banner");var t=document.getElementById("cb-preferences-banner");var n=document.getElementById("cb-preferences-btn");var a=document.getElementById("cb-accept-all-btn");var r=document.getElementById("cb-reject-all-btn");var o=document.getElementById("cb-prefs-reject-btn");var c=document.getElementById("cb-cancel-prefs-btn");var s=document.getElementById("cb-save-prefs-btn");var l=document.getElementById("cb-ccpa-donotsell-link");var d="ccpa"===i;function p(){if(e){e.style.display="none";e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade")}if(t){t.style.display="none";Ye(t)}var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="flex");Fe()}function b(){if(e){if(t){t.style.display="none";Ye(t)}var n=Z(e);e.style.display="flex";e.style.visibility="visible";e.style.opacity="1";e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade","cb-banner-animate-zoom-in");if(m){var a="";var r=u;a=n?"slide-up"===u?"cb-banner-animate-initial-center-bottom":"slide-down"===u?"cb-banner-animate-initial-center-top":"zoom-in"===u?"cb-banner-animate-initial-center-zoom":"cb-banner-animate-fade":"slide-up"===u?"cb-banner-animate-bottom":"slide-down"===u?"cb-banner-animate-top":"zoom-in"===u?"cb-banner-animate-zoom-in":"cb-banner-animate-fade";e.classList.add(a)}f&&(document.body.style.overflow="hidden")}}var g=document.getElementById("cb-floating-trigger");g&&g.addEventListener("click",function(e){e&&e.preventDefault&&e.preventDefault();e&&e.stopPropagation&&e.stopPropagation();b()});n&&n.addEventListener("click",function(){if(e&&t){if(!d){var n=ae()||A&&A.categories||{};var a=function(e,t){var n=document.getElementById(e);if(n){n.checked=!!t;var a=n.parentNode&&n.parentNode.querySelector("button.cb-pref-toggle-track");a&&a.setAttribute("aria-checked",n.checked?"true":"false")}};a("cb-pref-analytics",n.analytics);a("cb-pref-preferences",n.preferences);a("cb-pref-marketing",n.marketing)}e.style.display="none";e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade");t.style.display="flex";t.style.visibility="visible";t.style.opacity="1";Ye(t);var r=Je();r&&t.classList.add(r)}});o&&o.addEventListener("click",function(){var e={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!1,preferences:!1,marketing:!1}};te(e);re(e,{status:"rejected"});ne(e.categories);Te(e.categories,"[PrefsReject]");Ie(e.categories);p()});var v=document.getElementById("cb-close-initial-btn");var y=document.getElementById("cb-close-prefs-btn");v&&v.addEventListener("click",function(){p()});y&&y.addEventListener("click",function(){p()});d&&l&&l.addEventListener("click",function(){if(e&&t){e.style.display="none";t.style.display="flex";t.style.visibility="visible";t.style.opacity="1";Ye(t);var n=Je();n&&t.classList.add(n)}});c&&c.addEventListener("click",function(){b()});r&&r.addEventListener("click",function(){if(!d){var e={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!1,preferences:!1,marketing:!1}};te(e);re(e,{status:"rejected"});ne(e.categories);Te(e.categories,"[Reject]");Ie(e.categories)}p()});a&&a.addEventListener("click",function(){if(d){var e={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:!1}};te(e);re(e,{status:"given"});ke({analytics:!0,marketing:!0,preferences:!0,essential:!0})}else{var t={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!0,preferences:!0,marketing:!0}};te(t);re(t,{status:"given"});ne(t.categories);ke(t.categories);Te(t.categories,"[Accept]")}p()});s&&s.addEventListener("click",function(){if(d){var e=document.getElementById("cb-ccpa-optout");var t=!(!e||!e.checked);var n={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:t}};te(n);re(n,{status:t?"rejected":"given"});t||ke({analytics:!0,marketing:!0,preferences:!0,essential:!0})}else{var a=document.getElementById("cb-pref-analytics");var r=document.getElementById("cb-pref-preferences");var i=document.getElementById("cb-pref-marketing");var o={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!(!a||!a.checked),preferences:!(!r||!r.checked),marketing:!(!i||!i.checked)}};te(o);re(o,{status:"partial"});ne(o.categories);ke(o.categories);Te(o.categories,"[Save]");Ie(o.categories)}p()})}function qe(){Xe();var e=document.getElementById("cb-initial-banner");if(e){e.style.display="flex";e.style.visibility="visible";e.style.opacity="1"}}function He(){var e=be();if("gdpr"===i){Ae();if(s||e){window.gtag&&window.gtag("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500});A.accepted?Te(A.categories||{},"[Reload]"):s&&Le()}}if(o)if(A.accepted){Xe();var t=document.getElementById("cb-floating-trigger");t&&(t.style.display="flex")}else qe();try{ce()}catch(e){console.warn("[ConsentBit] sendPageviewToServer threw",e)}function n(){document.addEventListener("click",function(e){var t=e.target;for(;t&&t!==document.body;){if(t.hasAttribute&&t.hasAttribute("data-consentbit-trigger")){e.preventDefault();e.stopPropagation();try{localStorage.removeItem(I);A={accepted:!1,timestamp:null}}catch(e){console.warn("[ConsentBit] Failed to clear consent:",e)}var n=document.getElementById("cb-initial-banner");if(n){n.style.display="flex";n.style.visibility="visible";n.style.opacity="1";f&&(document.body.style.overflow="hidden");n.scrollIntoView({behavior:"smooth",block:"start"})}else{qe();setTimeout(function(){var e=document.getElementById("cb-initial-banner");e&&e.scrollIntoView({behavior:"smooth",block:"start"})},100)}return!1}t=t.parentElement}},!0)}"loading"===document.readyState?document.addEventListener("DOMContentLoaded",n):n()}}();
`;

  // ETag must change whenever banner customization/translation changes.
  // `Site.updatedAt` does not always update when only BannerCustomization changes, so include both.
  // Also include a script version so CDN logic changes propagate even when site/customization did not change.
  const SCRIPT_VERSION = '2026-04-19-translations-hash';
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
(function(){"use strict";const BASE_URL="https://test-cmp.pages.dev";function loadScriptOnce(e,t){const n=document.querySelector('script[src="'+e+'"]');if(n){t&&("true"===n.dataset.cbLoaded?t():n.addEventListener("load",t,{once:!0}));return}const o=document.createElement("script");o.src=e;o.async=!1;o.onload=function(){o.dataset.cbLoaded="true";t&&t()};o.onerror=function(){try{console.warn("[ConsentBit][IAB] Failed to load",e)}catch(e){}};document.head.appendChild(o)}function initConsentDependencies(){loadScriptOnce(BASE_URL+"/tcf.bundle.js",function(){loadScriptOnce(BASE_URL+"/Tcfmanager.js")})}var siteConfig=window.__CONSENT_SITE__||{},CUSTOMIZATION=siteConfig.customization||{},SITE_ID=siteConfig.id||null,API_BASE=siteConfig.apiBase||"https://manager.consentbit.com",PRIVACY_POLICY_URL=CUSTOMIZATION.privacyPolicyUrl||"";const styleConfig={bannerBg:CUSTOMIZATION.backgroundColor||"#FFFFFF",bannerBg2:CUSTOMIZATION.bannerBg2||"#798EFF",textColor:CUSTOMIZATION.textColor||"#334155",headingColor:CUSTOMIZATION.headingColor||"#0f172a",buttonColor:CUSTOMIZATION.acceptButtonBg||"#007AFF",buttonTextColor:CUSTOMIZATION.acceptButtonText||"#ffffff",rejectButtonBg:CUSTOMIZATION.rejectButtonBg||"#ffffff",rejectButtonText:CUSTOMIZATION.rejectButtonText||"#334155",SecButtonColor:CUSTOMIZATION.customiseButtonBg||"#ffffff",SecButtonTextColor:CUSTOMIZATION.customiseButtonText||"#334155",saveButtonBg:CUSTOMIZATION.saveButtonBg||CUSTOMIZATION.customiseButtonBg||"#ffffff",saveButtonText:CUSTOMIZATION.saveButtonText||CUSTOMIZATION.customiseButtonText||"#334155",textAlign:CUSTOMIZATION.textAlign||CUSTOMIZATION.textAlignment||"left",fontFamily:CUSTOMIZATION.font||"Manrope",fontWeight:CUSTOMIZATION.bannerFontWeight||CUSTOMIZATION.fontWeight||"400",fontSize:CUSTOMIZATION.fontSize||16,borderRadius:null!=CUSTOMIZATION.bannerBorderRadius?parseFloat(CUSTOMIZATION.bannerBorderRadius)*(String(CUSTOMIZATION.bannerBorderRadius).includes("rem")?16:1):12,buttonBorderRadius:CUSTOMIZATION.buttonBorderRadius||"0.375rem",bannerType:CUSTOMIZATION.bannerLayoutVisual||"box",boxAlignment:CUSTOMIZATION.position||"bottom-left",animation:CUSTOMIZATION.bannerEntranceAnimation||"fade-in",showBannerLogo:!1!==CUSTOMIZATION.showBannerLogo&&0!==CUSTOMIZATION.showBannerLogo,bannerLogoPosition:CUSTOMIZATION.bannerLogoPosition||"left"};function getBannerAnimationName(){const e=String(styleConfig.animation||"").trim().toLowerCase(),t={"fade-in":"consentBit-fadeInBanner","slide-up":"consentBit-slideUpBanner","slide-down":"consentBit-slideDownBanner","zoom-in":"consentBit-zoomInBanner"};return t[e]?t[e]:"popup"===styleConfig.bannerType||"bottom-center"===styleConfig.bannerType?"consentBit-zoomInBanner":"banner"===styleConfig.bannerType?"consentBit-slideUpBanner":"consentBit-fadeInBanner"}function injectStyles(){if(document.getElementById("consentbit-inline-styles"))return;const e=styleConfig,t=e.borderRadius+"px",n=Math.min(Number(e.borderRadius),8)+"px",o=Math.min(Number(e.borderRadius),999)+"px",i=getBannerAnimationName(),a='\n.consentBit-vendors-search-wrapper{max-height:500px;overflow-y:auto;padding:20px}\n.consentBit-search-container{position:relative;margin-bottom:20px}\n.consentBit-search-input{width:100%;padding:12px 16px 12px 44px;border:2px solid #e0e0e0;border-radius:\${brSm};font-size:14px;transition:border-color .2s ease;background:transparent;box-sizing:border-box}\n.consentBit-search-input:focus{outline:none;border-color:\${s.SecButtonColor};box-shadow:0 0 0 3px \${s.SecButtonColor}22}\n.consentBit-search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:16px;color:#666;pointer-events:none}\n.consentBit-vendors-list{display:flex;flex-direction:column;gap:12px}\n.consentBit-vendor-item{padding:16px;border-radius:\${brSm};transition:all .2s ease;animation:consentBit-fadeIn .3s ease}\n.consentBit-vendor-item:hover{border-color:\${s.SecButtonColor};box-shadow:0 4px 12px rgba(0,0,0,.1)}\n.consentBit-vendor-item.consentBit-hidden{display:none!important}\n.consentBit-vendor-header{display:flex;justify-content:space-between;align-items:center;gap:16px}\n.consentBit-vendor-info{flex:1}\n.consentBit-vendor-name{font-weight:600;font-size:15px;color:\${s.headingColor};margin-bottom:4px}\n.consentBit-vendor-id{font-size:12px;color:#666;font-family:monospace}\n.consentBit-switch-wrapper{flex-shrink:0}\n.consentBit-consent-switch-wrapper{display:flex;align-items:center;gap:8px}\n.consentBit-switch-label{font-size:13px;font-weight:500;color:\${s.textColor}}\n.consentBit-switch-sm{position:relative;width:36px;height:20px}\n.consentBit-switch-sm input{opacity:0;width:0;height:0}\n.consentBit-switch-sm input:checked+.consentBit-slider{background-color:\${s.SecButtonColor}}\n.consentBit-switch-sm input:focus+.consentBit-slider{box-shadow:0 0 1px \${s.SecButtonColor}}\n.consentBit-switch-sm input:checked+.consentBit-slider:before{transform:translateX(16px)}\n.consentBit-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#ccc;transition:.2s;border-radius:20px}\n.consentBit-slider:before{position:absolute;content:"";height:16px;width:16px;left:2px;top:2px;background-color:#fff;transition:.2s;border-radius:50%}\n.consentBit-no-results{text-align:center;padding:40px 20px;color:#666}\n.consentBit-no-results p{margin:0 0 4px 0;font-size:16px}\n.consentBit-empty-vendors-text{text-align:center;color:#666;padding:40px;font-style:italic}\n.consentBit-loading{text-align:center;padding:40px;color:\${s.textColor}}\n@keyframes consentBit-fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}\n.consentBit-consent-container{position:fixed;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;border-radius:\${br};box-shadow:0 20px 60px rgba(0,0,0,.15);backdrop-filter:blur(10px);animation:\${bannerAnimation} .4s cubic-bezier(.25,.46,.45,.94);--cb-banner-transform-rest:translate3d(0,0,0);--cb-banner-transform-start-up:translate3d(0,100%,0);--cb-banner-transform-start-down:translate3d(0,-100%,0);--cb-banner-transform-start-zoom:scale(.92)}\n.consentBit-type-banner{bottom:0;left:0;right:0;border-radius:0;max-width:100%}\n.consentBit-type-box-bottom-left{bottom:20px;left:20px;right:auto;max-width:450px}\n.consentBit-type-box-bottom-right{bottom:20px;right:20px;left:auto;max-width:450px}\n.consentBit-type-popup{bottom:20px;left:50%;transform:translateX(-50%);right:auto;max-width:480px;width:calc(100% - 40px);animation:\${bannerAnimation} .4s cubic-bezier(.25,.46,.45,.94);--cb-banner-transform-rest:translateX(-50%);--cb-banner-transform-start-up:translate(-50%,100%);--cb-banner-transform-start-down:translate(-50%,-100%);--cb-banner-transform-start-zoom:translateX(-50%) scale(.92)}\n.consentBit-popup-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999998}\n@keyframes consentBit-fadeInBanner{from{opacity:0;transform:var(--cb-banner-transform-rest,translate3d(0,0,0))}to{opacity:1;transform:var(--cb-banner-transform-rest,translate3d(0,0,0))}}\n@keyframes consentBit-slideUpBanner{from{transform:var(--cb-banner-transform-start-up,translate3d(0,100%,0));opacity:0}to{transform:var(--cb-banner-transform-rest,translate3d(0,0,0));opacity:1}}\n@keyframes consentBit-slideDownBanner{from{transform:var(--cb-banner-transform-start-down,translate3d(0,-100%,0));opacity:0}to{transform:var(--cb-banner-transform-rest,translate3d(0,0,0));opacity:1}}\n@keyframes consentBit-zoomInBanner{from{transform:var(--cb-banner-transform-start-zoom,scale(.92));opacity:0}to{transform:var(--cb-banner-transform-rest,translate3d(0,0,0));opacity:1}}\n.consentBit-consent-bar{border:1px solid #f4f4f4;background:\${s.bannerBg};border-radius:\${br};padding:24px;max-height:500px;overflow-y:auto;position: relative;}\n.consentBit-type-banner .consentBit-consent-bar{border-radius:0;padding:16px 24px}\n.consentBit-type-banner .consentBit-notice{flex-direction:row;align-items:center;gap:24px}\n.consentBit-type-banner .consentBit-notice-group{display:flex;flex-direction:row;align-items:center;gap:20px;flex:1}\n.consentBit-type-banner .consentBit-notice-btn-wrapper{flex-direction:row;padding-top:0;border-top:none;flex-shrink:0}\n.consentBit-notice{display:flex;flex-direction:column;gap:16px}\n.consentBit-title{font-size:20px;font-weight:700;line-height:1.3;margin:0 0 12px 0;color:\${s.headingColor};text-align:\${s.textAlign};padding-right: 15px;}\n.consentBit-notice-group{display:flex;flex-direction:column;gap:20px}\n.consentBit-notice-des{flex:1;color:\${s.textColor};line-height:1.6;font-size:14px;font-weight:\${s.fontWeight};text-align:\${s.textAlign}; }\n.consentBit-notice-des p{margin:0 0 12px 0}\n.consentBit-notice-des p:last-child{margin-bottom:0}\n.consentBit-notice-btn-wrapper{display:flex;gap:8px;padding-top:16px;border-top:1px solid #f0f0f0;justify-content:\${s.textAlign === \'center\' ? \'center\' : s.textAlign === \'right\' ? \'flex-end\' : \'flex-start\'}}\n.consentBit-btn{padding:11px 20px;border-radius:\${brSm};font-size:14px;font-weight:\${s.fontWeight};cursor:pointer;transition:opacity .2s ease;border:2px solid transparent;text-align:center;min-height:44px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}\n.consentBit-btn:hover,.cb-btn:hover{opacity:.85}\n.consentBit-btn-reject,.consentBit-btn-accept,.cb-btn-reject,.cb-btn-accept{color:\${s.buttonTextColor};background:\${s.buttonColor};border-color:\${s.buttonColor}}\n.consentBit-btn-customize,.cb-btn-preferences{color:\${s.SecButtonTextColor};background:\${s.SecButtonColor};border-color:\${s.SecButtonColor}}\n.cb-modal{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000000;padding:20px;box-sizing:border-box}\n.cb-modal.cb-modal-hidden{display:none!important}\n.cb-preference-center{background-color:\${s.bannerBg};border:1px solid #f4f4f4;border-radius:\${br};max-width:720px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.15)}\n.cb-preference-header{padding:20px 24px;border-bottom:1px solid #f4f4f4;display:flex;justify-content:space-between;align-items:center}\n.cb-preference-title{font-size:18px;font-weight:600;color:\${s.headingColor}}\n.cb-btn-close{background:none;border:none;cursor:pointer;padding:4px;opacity:.5;transition:opacity .2s}\n.cb-btn-close:hover{opacity:1}\n.cb-btn-close img{width:20px;height:20px}\n.cb-iab-preference-des{margin-top:16px}\n.cb-iab-detail-wrapper{flex:1;overflow-y:auto;padding:0 24px 24px}\n.cb-iab-preference-des,.cb-preference-content-wrapper,.cb-accordion-header-des,.cb-iab-ad-settings-details-des{color:\${s.textColor};font-size:13px;line-height:1.6;font-weight:\${s.fontWeight};text-align:\${s.textAlign}}\n.cb-iab-navbar-wrapper{margin-bottom:24px;border-bottom:2px solid #f4f4f4}\n.cb-iab-navbar{display:flex;list-style:none;gap:0;padding:0;margin:0}\n.cb-iab-nav-item{flex:1}\n.cb-iab-nav-btn{width:100%;padding:12px 16px;background:none;border:none;border-bottom:3px solid transparent;cursor:pointer;font-size:13px;font-weight:\${s.fontWeight};color:\${s.textColor};opacity:.6;transition:all .2s}\n.cb-iab-nav-item-active .cb-iab-nav-btn{color:\${s.SecButtonColor};border-bottom-color:\${s.SecButtonColor};opacity:1;font-weight:600}\n.cb-iab-nav-btn:hover{}\n.cb-preference-body-wrapper{display:none}\n.cb-preference-body-wrapper.active{display:block}\n.cb-iab-detail-title{font-size:16px;font-weight:600;color:\${s.headingColor};margin-bottom:14px;text-align:\${s.textAlign}}\n.cb-horizontal-separator{height:1px;background-color:#ebebeb;margin:20px 0}\n.cb-accordion-wrapper{display:flex;flex-direction:column;gap:10px}\n.cb-accordion{border:1px solid #ebebeb;border-radius:\${brSm};overflow:hidden;background:\${s.bannerBg}}\n.cb-accordion-item,.cb-accordion-iab-item{display:flex;gap:12px;padding:14px 16px;cursor:pointer;transition:background-color .2s}\n.cb-accordion-item:hover,.cb-accordion-iab-item:hover,.cb-child-accordion-item:hover{}\n.cb-accordion-chevron,.cb-child-accordion-chevron{flex-shrink:0;display:flex;align-items:center;justify-content:center}\n.cb-accordion-chevron{width:20px;height:20px}\n.cb-child-accordion-chevron{width:16px;height:16px}\n.cb-chevron-right{width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid #999;transition:transform .2s;display:inline-block}\n.cb-accordion.active .cb-chevron-right,.cb-child-accordion.active .cb-chevron-right{transform:rotate(90deg)}\n.cb-accordion-header-wrapper{flex:1}\n.cb-accordion-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:10px}\n.cb-accordion-btn,.cb-child-accordion-btn{background:none;border:none;font-size:14px;font-weight:600;color:\${s.headingColor};cursor:pointer;text-align:\${s.textAlign};padding:0}\n.cb-child-accordion-btn{font-size:13px;font-weight:500;text-align:left;flex:1}\n.cb-always-active{padding:3px 10px;background-color:#DCFCE7;color:#166534;border-radius:\${brPill};font-size:11px;font-weight:500}\n.cb-switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}\n.cb-switch input{opacity:0;width:0;height:0}\n.cb-switch input[type="checkbox"],.cb-switch-sm input[type="checkbox"]{appearance:none;position:relative;cursor:pointer;transition:background-color .2s}\n.cb-switch input[type="checkbox"]{width:44px;height:24px;background-color:#d0d5d2;border-radius:12px}\n.cb-switch input[type="checkbox"]:checked,.cb-switch-sm input[type="checkbox"]:checked{background-color:\${s.SecButtonColor}}\n.cb-switch input[type="checkbox"]::before,.cb-switch-sm input[type="checkbox"]::before{content:\'\';position:absolute;border-radius:50%;background-color:#fff;top:3px;left:3px;transition:transform .2s}\n.cb-switch input[type="checkbox"]::before{width:18px;height:18px}\n.cb-switch input[type="checkbox"]:checked::before{transform:translateX(20px)}\n.cb-accordion-body,.cb-child-accordion-body{max-height:0;overflow:hidden;transition:max-height .3s ease}\n.cb-accordion.active .cb-accordion-body,.cb-child-accordion.active .cb-child-accordion-body{max-height:2000px}\n.cb-audit-table{border-radius:\${brSm};padding:14px;margin:0 14px 14px 28px}\n.cb-child-accordion{border-top:1px solid #ebebeb}\n.cb-child-accordion:first-child{border-top:none}\n.cb-child-accordion-item{display:flex;gap:12px;padding:12px 16px;cursor:pointer;transition:background-color .2s}\n.cb-child-accordion-header-wrapper{flex:1;display:flex;justify-content:space-between;align-items:center;gap:16px}\n.cb-iab-ad-settings-details{padding:14px;background-color:#f9f9f9;margin:0 14px 14px;border-radius:\${brSm}}\n.cb-iab-illustrations-title{font-weight:600;color:\${s.headingColor};margin-bottom:6px;font-size:13px}\n.cb-iab-illustrations-des{list-style:none;padding-left:0}\n.cb-iab-illustrations-des li{padding-left:18px;position:relative;margin-bottom:10px;color:\${s.textColor};font-size:12px;line-height:1.6;font-weight:\${s.fontWeight}}\n.cb-iab-illustrations-des li::before{content:\'•\';position:absolute;left:0;color:\${s.SecButtonColor}}\n.cb-iab-vendors-count-wrapper{margin-top:12px;font-size:12px;color:\${s.textColor};opacity:.6;font-weight:500}\n.cb-switch-wrapper{display:flex;gap:12px;align-items:center;flex-shrink:0}\n.cb-switch-separator{padding-right:12px;border-right:1px solid #ddd}\n.cb-legitimate-switch-wrapper,.cb-consent-switch-wrapper{display:flex;align-items:center;gap:6px}\n.cb-switch-label{font-size:11px;color:\${s.textColor};opacity:.6;font-weight:500;white-space:nowrap}\n.cb-switch-sm{position:relative;display:inline-block}\n.cb-switch-sm input[type="checkbox"]{width:36px;height:20px;background-color:#d0d5d2;border-radius:10px}\n.cb-switch-sm input[type="checkbox"]::before{width:14px;height:14px}\n.cb-switch-sm input[type="checkbox"]:checked::before{transform:translateX(16px)}\n.cb-switch-sm input[type="checkbox"]:disabled{cursor:not-allowed}\n.cb-switch-sm input[type="checkbox"]:disabled:checked{opacity:.7}\n.cb-footer-wrapper{border-top:1px solid #f4f4f4;background-color:\${s.bannerBg};flex-shrink:0}\n.cb-footer-shadow{display:block;height:20px;margin-top:-20px;background:linear-gradient(180deg,rgba(255,255,255,0) 0%,\${s.bannerBg} 100%)}\n.cb-prefrence-btn-wrapper{padding:14px 22px;display:flex;gap:10px;justify-content:\${s.textAlign === \'center\' ? \'center\' : s.textAlign === \'right\' ? \'flex-start\' : \'flex-end\'};flex-wrap:wrap}\n.cb-btn{padding:9px 20px;border-radius:\${brSm};font-size:13px;font-weight:\${s.fontWeight};cursor:pointer;transition:opacity .2s;border:2px solid;white-space:nowrap}\n.cb-btn-reject,.cb-btn-accept{border:none}\n@media(max-width:768px){.consentBit-type-box-bottom-left,.consentBit-type-box-bottom-right{left:10px;right:10px;max-width:calc(100% - 20px)}.consentBit-type-box-bottom-left,.consentBit-type-box-bottom-right{bottom:10px}.consentBit-consent-bar{padding:18px}.consentBit-title{font-size:16px}.consentBit-notice-btn-wrapper,.cb-prefrence-btn-wrapper{flex-direction:column}.consentBit-btn,.cb-btn{width:100%}.consentBit-type-banner .consentBit-notice,.consentBit-type-banner .consentBit-notice-group{flex-direction:column}.cb-iab-navbar{flex-direction:column}.cb-switch-wrapper{flex-direction:column;align-items:flex-start;gap:6px}.cb-switch-separator{border-right:none;padding-right:0;padding-bottom:6px;border-bottom:1px solid #ddd}}\n',r=document.createElement("style");r.id="consentbit-inline-styles";r.textContent=a;document.head.appendChild(r)}function injectHTML(){if(document.getElementById("consentBitBanner")&&document.getElementById("cbPreferenceModal"))return!0;const e=styleConfig,t=!!localStorage.getItem("cookieConsentPrefs");let n="";n="banner"===e.bannerType?"consentBit-type-banner":"bottom-center"===e.bannerType||"popup"===e.bannerType?"consentBit-type-popup":"bottom-right"===e.boxAlignment?"consentBit-type-box-bottom-right":"consentBit-type-box-bottom-left";const o=t?' style="display:none;"':"",i="bottom-center"===e.bannerType||"popup"===e.bannerType?"<div class='consentBit-popup-overlay' id='consentBitPopupOverlay'\${bannerInlineStyle}></div>":"",a='\n\${popupOverlay}\n<div class="consentBit-consent-container \${bannerPositionClass}"\n     id="consentBitBanner" tabindex="-1"\n     aria-label="We value your privacy" role="region"\${bannerInlineStyle}>\n  <div class="consentBit-consent-bar" data-consentBit-tag="notice">\n<button aria-label="Close" class="cb-btn-close" id="cbCloseBtn1" style="\n    position: absolute;\n    right: 10px;\n">\n        <img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cline x1=\'18\' y1=\'6\' x2=\'6\' y2=\'18\'%3E%3C/line%3E%3Cline x1=\'6\' y1=\'6\' x2=\'18\' y2=\'18\'%3E%3C/line%3E%3C/svg%3E" alt="Close">\n      </button>\n    <div class="consentBit-notice">\n\n      <p class="consentBit-title"\n         aria-level="2" data-consentBit-tag="title" role="heading">\n       Your privacy matters to us\n      </p>\n\n      <div class="consentBit-notice-group">\n        <div class="consentBit-notice-des" data-consentBit-tag="iab-description">\n          <p>We and our trusted partners use cookies and similar technologies to collect and store information from your device. This may include details such as your IP address, browsing behavior, and device information.\nThis data is used to ensure the website functions properly, enhance your experience, deliver personalized content and advertisements, and analyze performance and user engagement. In certain situations, we may also process location data and use device-based identification methods.\nYou have the option to manage your preferences and control how your information is used.\n          </p>\n        </div>\n\n        <div class="consentBit-notice-btn-wrapper" data-consentBit-tag="notice-buttons">\n          <button class="consentBit-btn consentBit-btn-customize"\n                  id="consentBitCustomiseBtn"\n                  aria-label="Customise"\n                  aria-haspopup="dialog"\n                  aria-controls="cbPreferenceModal"\n                  data-consentBit-tag="settings-button">\n            Customise\n          </button>\n          <button class="consentBit-btn consentBit-btn-reject"\n                  id="consentBitRejectAllBanner"\n                  aria-label="Reject All"\n                  data-consentBit-tag="reject-button">\n            Reject All\n          </button>\n          <button class="consentBit-btn consentBit-btn-accept"\n                  id="consentBitAcceptAllBanner"\n                  aria-label="Accept All"\n                  data-consentBit-tag="accept-button">\n            Accept All\n          </button>\n        </div>\n      </div>\n\n    </div>\n  </div>\n</div>\n\n<div class="cb-modal cb-modal-hidden" id="cbPreferenceModal" tabindex="-1">\n  <div class="cb-preference-center" role="dialog" aria-modal="true"\n       aria-label="Customise Consent Preferences">\n    <div class="cb-preference-header">\n      <span class="cb-preference-title" role="heading" aria-level="2">\n        Customise Consent Preferences\n      </span>\n      <button aria-label="Close" class="cb-btn-close" id="cbCloseBtn">\n        <img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cline x1=\'18\' y1=\'6\' x2=\'6\' y2=\'18\'%3E%3C/line%3E%3Cline x1=\'6\' y1=\'6\' x2=\'18\' y2=\'18\'%3E%3C/line%3E%3C/svg%3E" alt="Close">\n      </button>\n    </div>\n\n    <div class="cb-iab-detail-wrapper">\n      <div class="cb-iab-preference-des">\n        <p>Customise your consent preferences for Cookie Categories and advertising tracking\n        preferences for Purposes &amp; Features and Vendors below. You can give granular consent\n        for each Third Party Vendor. Most vendors require explicit consent for personal data\n        processing, while some rely on legitimate interest. However, you have the right to object\n        to their use of legitimate interest.</p>\n      </div>\n\n      <div class="cb-iab-navbar-wrapper">\n        <ul class="cb-iab-navbar">\n          <li class="cb-iab-nav-item cb-iab-nav-item-active" data-tab="cookie">\n            <button aria-label="Cookie Categories" class="cb-iab-nav-btn">Cookie Categories</button>\n          </li>\n          <li class="cb-iab-nav-item" data-tab="purpose">\n            <button aria-label="Purposes &amp; Features" class="cb-iab-nav-btn">Purposes &amp; Features</button>\n          </li>\n          <li class="cb-iab-nav-item" data-tab="vendor">\n            <button aria-label="Vendors" class="cb-iab-nav-btn">Vendors</button>\n          </li>\n        </ul>\n      </div>\n\n      <div class="cb-iab-detail-sub-wrapper">\n        <div class="cb-preference-body-wrapper active" id="cbIABSectionCookie">\n          <p class="cb-iab-detail-title">Cookie Categories</p>\n          <div class="cb-preference-content-wrapper">\n            <p>We use cookies to help you navigate efficiently and perform certain functions.\n            You will find detailed information about all cookies under each consent category below.</p>\n            <p>The cookies that are categorised as "Necessary" are stored on your browser as they\n            are essential for enabling the basic functionalities of the site.</p>\n          </div>\n          <div class="cb-horizontal-separator"></div>\n          <div class="cb-accordion-wrapper" id="cookieAccordions"></div>\n        </div>\n\n        <div class="cb-preference-body-wrapper" id="cbIABSectionPurpose">\n          <p class="cb-iab-detail-title">Purposes &amp; Features</p>\n          <div class="cb-accordion-wrapper" id="purposeAccordions"></div>\n        </div>\n\n        <div class="cb-preference-body-wrapper" id="cbIABSectionVendor">\n          <p class="cb-iab-detail-title">Vendors</p>\n          <div class="consentBit-vendors-search-wrapper">\n            <div class="consentBit-search-container">\n              <input type="text" id="vendorsSearch"\n                     class="consentBit-search-input"\n                     placeholder="Search vendors by name or ID..."\n                     autocomplete="off">\n              <div class="consentBit-search-icon">🔍</div>\n            </div>\n            <div id="vendorsLoading" class="consentBit-loading">Loading vendors...</div>\n            <div id="vendorsList" class="consentBit-vendors-list" style="display:none;"></div>\n          </div>\n        </div>\n      </div>\n    </div>\n\n    <div class="cb-footer-wrapper">\n      <span class="cb-footer-shadow"></span>\n      <div class="cb-prefrence-btn-wrapper">\n        <button aria-label="Reject All" class="cb-btn cb-btn-reject" id="cbRejectBtn">Reject All</button>\n        <button aria-label="Save My Preferences" class="cb-btn cb-btn-preferences" id="cbSaveBtn">Save My Preferences</button>\n        <button aria-label="Accept All" class="cb-btn cb-btn-accept" id="cbAcceptBtn">Accept All</button>\n      </div>\n    </div>\n  </div>\n</div>\n',r=document.createElement("div");r.innerHTML=a;document.body.appendChild(r);return!0}function ensureConsentUiShell(){return!!document.body&&injectHTML()}const cookieCategories=[{id:"necessary",name:"Necessary",alwaysActive:!0,description:"Necessary cookies are required to enable the basic features of this site, such as providing secure log-in or adjusting your consent preferences. These cookies do not store any personally identifiable data.",cookies:[{name:"_cfuvid",duration:"session",description:"Calendly sets this cookie to track users across sessions to optimize user experience by maintaining session consistency and providing personalized services."},{name:"cookieyes-consent",duration:"1 year",description:"CookieYes sets this cookie to remember users' consent preferences so that their preferences are respected on subsequent visits to this site. It does not collect or store any personal information about the site visitors."}]},{id:"functional",name:"Functional",alwaysActive:!1,description:"Functional cookies help perform certain functionalities like sharing the content of the website on social media platforms, collecting feedback, and other third-party features.",cookies:[]},{id:"analytics",name:"Analytics",alwaysActive:!1,description:"Analytical cookies are used to understand how visitors interact with the website. These cookies help provide information on metrics such as the number of visitors, bounce rate, traffic source, etc.",cookies:[{name:"_hjSessionUser_*",duration:"1 year",description:"Hotjar sets this cookie to ensure data from subsequent visits to the same site is attributed to the same user ID, which persists in the Hotjar User ID, which is unique to that site."},{name:"_hjSession_*",duration:"1 hour",description:"Hotjar sets this cookie to ensure data from subsequent visits to the same site is attributed to the same user ID, which persists in the Hotjar User ID, which is unique to that site."}]},{id:"performance",name:"Performance",alwaysActive:!1,description:"Performance cookies are used to understand and analyse the key performance indexes of the website which helps in delivering a better user experience for the visitors.",cookies:[{name:"SRM_B",duration:"1 year 24 days",description:"Used by Microsoft Advertising as a unique ID for visitors."}]},{id:"advertisement",name:"Advertisement",alwaysActive:!1,description:"Advertisement cookies are used to provide visitors with customised advertisements based on the pages you visited previously and to analyse the effectiveness of the ad campaigns.",cookies:[{name:"MUID",duration:"1 year 24 days",description:"Bing sets this cookie to recognise unique web browsers visiting Microsoft sites. This cookie is used for advertising, site analytics, and other operations."},{name:"ANONCHK",duration:"10 minutes",description:"The ANONCHK cookie, set by Bing, is used to store a user's session ID and verify ads' clicks on the Bing search engine. The cookie helps in reporting and personalization as well."}]}],purposesData=[{id:"purposes",title:"Purposes (11)",hasToggle:!0,items:[{id:"purpose1",title:"Store and/or access information on a device",description:"Cookies, device or similar online identifiers (e.g. login-based identifiers, randomly assigned identifiers, network based identifiers) together with other information (e.g. browser type and information, language, screen size, supported technologies etc.) can be stored or read on your device to recognise it each time it connects to an app or to a website, for one or several of the purposes presented here.",illustrations:["Most purposes explained in this notice rely on the storage or accessing of information from your device when you use an app or visit a website."],vendorCount:777,hasConsent:!0,hasLegitimate:!1},{id:"purpose2",title:"Use limited data to select advertising",description:"Advertising presented to you on this service can be based on limited data, such as the website or app you are using, your non-precise location, your device type or which content you are (or have been) interacting with.",illustrations:["A car manufacturer wants to promote its electric vehicles to environmentally conscious users living in the city after office hours.","A large producer of watercolour paints wants to carry out an online advertising campaign for its latest watercolour range."],vendorCount:734,hasConsent:!0,hasLegitimate:!0},{id:"purpose3",title:"Create profiles for personalised advertising",description:"Information about your activity on this service (such as forms you submit, content you look at) can be stored and combined with other information about you.",illustrations:["If you read several articles about the best bike accessories to buy, this information could be used to create a profile about your interest in bike accessories.","An apparel company wishes to promote its new line of high-end baby clothes by building profiles of wealthy young parents."],vendorCount:594,hasConsent:!0,hasLegitimate:!1},{id:"purpose4",title:"Use profiles to select personalised advertising",description:"Advertising presented to you on this service can be based on your advertising profiles, which can reflect your activity on this service or other websites or apps.",illustrations:["An online retailer targets users who previously looked at running shoes.","A profile created on one site is used on another app to show relevant ads."],vendorCount:596,hasConsent:!0,hasLegitimate:!1},{id:"purpose5",title:"Create profiles to personalise content",description:"Information about your activity on this service can be stored and combined with other information to build or improve a profile which is then used to present more relevant content.",illustrations:["Reading DIY articles leads to more DIY content recommendations.","Viewing space videos creates interest profile for space content."],vendorCount:267,hasConsent:!0,hasLegitimate:!1},{id:"purpose6",title:"Use profiles to select personalised content",description:"Content presented to you can be based on your content personalisation profiles and interests.",illustrations:["Vegetarian recipes shown based on reading habits.","Rowing videos recommended based on viewing history."],vendorCount:238,hasConsent:!0,hasLegitimate:!1},{id:"purpose7",title:"Measure advertising performance",description:"Information regarding which advertising is presented to you and how you interact with it can be used to determine how well an advert has worked.",illustrations:["Clicks and purchases tracked for ad performance.","Ad placement optimisation based on interaction data."],vendorCount:847,hasConsent:!0,hasLegitimate:!0},{id:"purpose8",title:"Measure content performance",description:"Information regarding which content is presented to you and how you interact with it can be used to determine content effectiveness.",illustrations:["Blog engagement tracked for content planning.","Video watch time used to optimise length."],vendorCount:404,hasConsent:!0,hasLegitimate:!0},{id:"purpose9",title:"Understand audiences through statistics or combinations of data from different sources",description:"Reports can be generated based on the combination of data sets regarding interactions to identify common characteristics.",illustrations:["Online bookstore audience analytics.","Advertiser audience comparison study."],vendorCount:548,hasConsent:!0,hasLegitimate:!0},{id:"purpose10",title:"Develop and improve services",description:"Information about your activity can be used to improve products and services and build new services.",illustrations:["Optimising ads for mobile devices.","Developing new ad formats for new devices."],vendorCount:633,hasConsent:!0,hasLegitimate:!0},{id:"purpose11",title:"Use limited data to select content",description:"Content can be based on limited data such as website/app used, non-precise location, device type, or interactions.",illustrations:["Travel content selected by location.","Shorter videos selected based on fast-forward behaviour."],vendorCount:174,hasConsent:!0,hasLegitimate:!0}]},{id:"special_purposes",title:"Special Purposes (3)",hasToggle:!1,items:[{id:"specialPurpose1",title:"Ensure security, prevent and detect fraud, and fix errors",description:"Your data can be used to monitor for and prevent unusual and possibly fraudulent activity (for example, regarding advertising, ad clicks by bots), and ensure systems and processes work properly and securely.",illustrations:["An advertising intermediary notices a large increase in clicks on ads and uses data to determine 80% come from bots."],vendorCount:595,hasConsent:!1,hasLegitimate:!1},{id:"specialPurpose2",title:"Deliver and present advertising and content",description:"Certain information (like an IP address or device capabilities) is used to ensure the technical compatibility of the content or advertising, and to facilitate the transmission of the content or ad to your device.",illustrations:["Clicking on a link in an article might normally send you to another page. Your browser sends a request to a server to properly display the information."],vendorCount:594,hasConsent:!1,hasLegitimate:!1},{id:"specialPurpose3",title:"Save and communicate privacy choices",description:"The choices you make regarding the purposes and entities listed in this notice are saved and made available to those entities in the form of digital signals.",illustrations:["When you visit a website and are offered a choice between consenting to personalised advertising or not, the choice you make is saved and made available to advertising providers."],vendorCount:445,hasConsent:!1,hasLegitimate:!1}]},{id:"features",title:"Features (3)",hasToggle:!1,items:[{id:"feature1",title:"Match and combine data from other data sources",description:"Information about your activity on this service may be matched and combined with other information relating to you and originating from various sources.",vendorCount:436,hasConsent:!1,hasLegitimate:!1},{id:"feature2",title:"Link different devices",description:"In support of the purposes explained in this notice, your device might be considered as likely linked to other devices that belong to you or your household.",vendorCount:369,hasConsent:!1,hasLegitimate:!1},{id:"feature3",title:"Identify devices based on information transmitted automatically",description:"Your device might be distinguished from other devices based on information it automatically sends when accessing the Internet.",vendorCount:558,hasConsent:!1,hasLegitimate:!1}]},{id:"special-features",title:"Special Features (2)",hasToggle:!0,items:[{id:"special-feature1",title:"Use precise geolocation data",description:"With your acceptance, your precise location (within a radius of less than 500 metres) may be used in support of the purposes explained in this notice.",vendorCount:280,hasConsent:!0,hasLegitimate:!1},{id:"special-feature2",title:"Actively scan device characteristics for identification",description:"With your acceptance, certain characteristics specific to your device might be requested and used to distinguish it from other devices.",vendorCount:157,hasConsent:!0,hasLegitimate:!1}]}];function waitForTCF(){return new Promise(function(e){var t=function(){window.tcfManager&&window.tcfManager.isInitialized?e():setTimeout(t,50)};t()})}function ensureGtagInitialization(){window.dataLayer=window.dataLayer||[];void 0===window.gtag&&(window.gtag=function(){window.dataLayer.push(arguments)});var e;if(document.querySelectorAll('script[src*="googletagmanager"]').length>0&&"function"==typeof window.gtag)try{window.gtag("event","consent_scripts_enabled",{event_category:"consent",event_label:"scripts_re_enabled"});setTimeout(function(){try{window.gtag("config","GA_MEASUREMENT_ID",{page_title:document.title,page_location:window.location.href})}catch(e){}},500)}catch(e){}}function updateGtagConsent(e){"function"==typeof gtag&&gtag("consent","update",{analytics_storage:e.analytics?"granted":"denied",functionality_storage:"granted",ad_storage:e.marketing?"granted":"denied",ad_personalization:e.marketing?"granted":"denied",ad_user_data:e.marketing?"granted":"denied",personalization_storage:e.personalization?"granted":"denied",security_storage:"granted"});void 0!==window.dataLayer&&window.dataLayer.push({event:"consent_update",consent_analytics:e.analytics,consent_marketing:e.marketing,consent_personalization:e.personalization})}window.SCRIPT_BLOCK_PROVIDERS=[{pattern:"google-analytics\\.com|googletagmanager\\.com/gtag/js|googletagmanager\\.com/gtm\\.js|region1\\.google-analytics\\.com",categories:["analytics"]},{pattern:"googleadservices\\.com|googlesyndication\\.com|pagead/|google\\.com/pagead/|doubleclick\\.net|googleads\\.g\\.doubleclick\\.net",categories:["marketing"]},{pattern:"connect\\.facebook\\.net|facebook\\.com/tr|pixel\\.facebook\\.com|fbevents\\.js",categories:["marketing"]},{pattern:"bing\\.com|bat\\.bing\\.com|linkedin\\.com/px|snap\\.licdn\\.com",categories:["marketing"]},{pattern:"analytics\\.tiktok\\.com|tiktok\\.com/i18n/pixel",categories:["marketing"]},{pattern:"platform\\.twitter\\.com|twimg\\.com|t\\.co/1/i/adsct",categories:["marketing"]},{pattern:"pintrk\\.js|ct\\.pinterest\\.com",categories:["marketing"]},{pattern:"sc-static\\.net/scevent|tr\\.snapchat\\.com",categories:["marketing"]},{pattern:"redditstatic\\.com/ads|reddit\\.com/api/v1/pixel",categories:["marketing"]},{pattern:"amazon-adsystem\\.com|media\\.amazon\\.com|dsp\\.amazon|criteo\\.com|taboola\\.com|outbrain\\.com|widgets\\.outbrain\\.com",categories:["marketing"]},{pattern:"adroll\\.com|adroll_adv_id|adroll_pix_id|__adroll_loaded|roundtrip\\.js",categories:["marketing"]},{pattern:"hotjar\\.com|clarity\\.ms|fullstory\\.com|heap-analytics\\.com|cdn\\.heap|mixpanel\\.com|amplitude\\.com|segment\\.com|segment\\.io|cdn\\.segment|posthog\\.com|app\\.posthog",categories:["analytics","behavioral"]},{pattern:"intercom\\.io|intercomcdn\\.com|drift\\.com|js\\.driftt\\.com|zendesk\\.com/embeddable|zdassets\\.com",categories:["marketing","preferences"]},{pattern:"hubspot\\.com|hs-scripts\\.com|hsforms\\.com|marketo\\.com|mktoresp\\.com|pardot\\.com|go\\.pardot|list-manage\\.com|klaviyo\\.com|static\\.klaviyo",categories:["marketing"]},{pattern:"player\\.vimeo\\.com|vimeo\\.com/api/player|wistia\\.com|fast\\.wistia",categories:["marketing"]},{pattern:"spotify\\.com/embed|soundcloud\\.com/player",categories:["marketing"]},{pattern:"yahoo\\.com|yimg\\.com|advertising\\.com|gemini\\.yahoo\\.com",categories:["marketing"]},{pattern:"yandex\\.ru/metrika|mc\\.yandex|vk\\.com/js|top-fwz1\\.mail\\.ru",categories:["analytics","marketing"]},{pattern:"omniture\\.com|adobedtm\\.com|demdex\\.net|tt.omtrdc\\.net|mbox\\.js",categories:["analytics","marketing"]},{pattern:"quantcast\\.com|quantserve\\.com|liveramp\\.com|rlcdn\\.com|thetradedesk\\.com|adsrvr\\.org",categories:["marketing"]},{pattern:"braze\\.com|sdk\\.braze|iterable\\.com|api\\.iterable",categories:["marketing"]},{pattern:"newrelic\\.com|nr-data\\.net|datadoghq-browser-agent|datadoghq\\.com",categories:["analytics"]},{pattern:"sentry\\.io|browser.sentry-cdn",categories:["analytics"]},{pattern:"matomo\\.php|plausible\\.io|usefathom\\.com|cdn\\.usefathom",categories:["analytics"]},{pattern:"static\\.cloudflareinsights\\.com|cloudflareinsights\\.com",categories:["analytics"]},{pattern:"mouseflow\\.com|cdn\\.mouseflow|luckyorange\\.com|cdn\\.luckyorange|crazyegg\\.com|cdn\\.crazyegg|inspectlet\\.com|cdn\\.inspectlet",categories:["analytics","behavioral"]},{pattern:"chartbeat\\.com|static\\.chartbeat|parsely\\.com|cdn\\.parsely|piano\\.io|tealiumiq\\.com|tags\\.tiqcdn|ensighten\\.com",categories:["analytics","marketing"]},{pattern:"shopify\\.com/s/javascripts|monorail-edge\\.shopifysvc\\.com",categories:["marketing","analytics"]},{pattern:"calendly\\.com/assets|assets\\.calendly|typeform\\.com|tally\\.so",categories:["preferences","marketing"]},{pattern:"maps\\.googleapis\\.com/maps/api/js",categories:["preferences"]}];var __cbInternalCreate=!1,__cbCreateElementBackup=null;function resolveScriptCategories(e,t){if(t&&t.getAttribute){var n=t.getAttribute("data-category");if(n)return n.split(",").map(function(e){return e.trim().toLowerCase()});var o=t.getAttribute("data-cookieyes");if(o){var i=o.match(/categories:([^|]+)/);if(i)return i[1].split(",").map(function(e){return e.trim().toLowerCase()})}}var a=window.siteConfig&&window.siteConfig.scriptBlockProviders||window.SCRIPT_BLOCK_PROVIDERS||[],r="";e&&"string"==typeof e&&(r+=e+" ");t&&"string"==typeof t.textContent&&(r+=t.textContent);if(r&&a.length)for(var c=0;c<a.length;c++){var s=a[c];if(s&&s.pattern)try{if(new RegExp(s.pattern,"i").test(r))return s.categories&&s.categories.length?s.categories.slice():["analytics"]}catch(e){}}return[]}function isCategoryAllowed(e){var t=String(e).toLowerCase();if("necessary"===t||"essential"===t)return!0;var n,o={analytics:"analytics",functional:"functional",performance:"performance",advertisement:"advertisement",advertising:"advertisement",marketing:"advertisement"}[t]||t;if(window.__cbConsentState){if(window.__cbConsentState.allGranted)return!0;if(window.__cbConsentState.allDenied)return!1;if(window.__cbConsentState.categories){var i=window.__cbConsentState.categories;if(void 0!==i[o])return!!i[o];if(void 0!==i[t])return!!i[t]}}var a=null;try{window.tcfManager&&"function"==typeof window.tcfManager.loadStoredConsent&&(a=window.tcfManager.loadStoredConsent())}catch(e){}if(!a)try{for(var r=0;r<localStorage.length;r++){var c=localStorage.key(r);if(c&&0===c.indexOf("consentbit_")){var s=localStorage.getItem(c);if(s){var d=JSON.parse(s);if(d&&d.accepted){a=d;break}}}}}catch(e){}if(!a)return!1;if(a.cookieCategories&&a.cookieCategories[o])return!!a.cookieCategories[o].enabled;if(a.categories){var l,p={analytics:"analytics",functional:"preferences",performance:"preferences",advertisement:"marketing",advertising:"marketing",marketing:"marketing"}[t]||t;if(void 0!==a.categories[p])return!!a.categories[p];if(a.accepted)return!0}return!1}function shouldBlockScript(e,t){if(__cbInternalCreate)return!1;var n="string"==typeof e?e.toLowerCase():"";if(n&&(-1!==n.indexOf("consentbit")||-1!==n.indexOf("consentv2")||-1!==n.indexOf("tcfmanager")))return!1;var o=resolveScriptCategories(e,t);if(!o||0===o.length)return!1;for(var i=0;i<o.length;i++)if("necessary"===o[i]||"essential"===o[i])return!1;for(var a=0;a<o.length;a++)if(isCategoryAllowed(o[a]))return!1;return!0}function patchDynamicScriptElement(e){if(e&&!e.__cbPatched){e.__cbPatched=!0;var t=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"src");t&&Object.defineProperty(e,"src",{set:function(n){if(shouldBlockScript(n,e)){e.setAttribute("data-cb-blocked-src",n);e.setAttribute("type","javascript/blocked")}else t.set.call(e,n)},get:function(){return e.getAttribute("data-cb-blocked-src")||t.get.call(e)},configurable:!0})}}function applyBlockToScriptNode(e){if(e&&"SCRIPT"===e.nodeName&&(!e.getAttribute||"javascript/blocked"!==e.getAttribute("type"))){var t=e.getAttribute&&e.getAttribute("src")||e.src||"";if(shouldBlockScript(t,e))try{if(t){e.setAttribute("data-cb-blocked-src",t);e.removeAttribute("src")}else e.setAttribute("data-cb-blocked-inline","true");e.setAttribute("type","javascript/blocked")}catch(e){}}}function installConsentScriptBlocker(){if(!window.__cbCreateElementHookInstalled){window.__cbCreateElementHookInstalled=!0;try{__cbCreateElementBackup=document.createElement.bind(document)}catch(e){__cbCreateElementBackup=document.createElement}document.createElement=function(e){var t=__cbCreateElementBackup(e);"script"===String(e||"").toLowerCase()&&patchDynamicScriptElement(t);return t};var e=new MutationObserver(function(e){for(var t=0;t<e.length;t++)for(var n=e[t].addedNodes,o=0;o<n.length;o++)applyBlockToScriptNode(n[o])});e.observe(document.documentElement,{childList:!0,subtree:!0});window.__cbMutationObserver=e;console.log("[ConsentBit] ✅ Script blocker installed")}}function blockNonEssentialScripts(){var e=Array.from(document.querySelectorAll("script")),t=0;e.forEach(function(e){var n=e.getAttribute("src")||e.src||"";if(shouldBlockScript(n,e))try{if(n){e.setAttribute("data-cb-blocked-src",n);e.removeAttribute("src")}else e.setAttribute("data-cb-blocked-inline","true");e.setAttribute("type","javascript/blocked");t++}catch(e){}});console.log("[ConsentBit][Block] Done — blocked:",t)}function releaseBlockedScripts(){var list=Array.from(document.querySelectorAll('script[type="javascript/blocked"]')),released=0;list.forEach(function(e){var t=e.getAttribute("data-cb-blocked-src");if(!shouldBlockScript(t,e)){__cbInternalCreate=!0;try{var n=document.createElement("script");n.async=e.hasAttribute("async");n.defer=e.hasAttribute("defer");e.crossOrigin&&(n.crossOrigin=e.crossOrigin);e.integrity&&(n.integrity=e.integrity);Array.from(e.attributes).forEach(function(e){"type"!==e.name&&"data-cb-blocked-src"!==e.name&&"data-cb-blocked-inline"!==e.name&&"src"!==e.name&&n.setAttribute(e.name,e.value)});n.type="text/javascript";if(t){n.src=t;n.onload=function(){ensureGtagInitialization()}}else e.textContent&&(n.text=e.textContent);(e.parentNode||document.head).insertBefore(n,e);e.remove();released++}catch(e){}finally{__cbInternalCreate=!1}}});var legacy=Array.from(document.querySelectorAll('script[type="text/plain"][data-category]'));legacy.forEach(function(el){var src=el.getAttribute("src")||"",cats=resolveScriptCategories(src,el);if(cats.length){var anyAllowed=cats.some(function(e){return isCategoryAllowed(e)});if(anyAllowed){__cbInternalCreate=!0;try{if(src){var ns=document.createElement("script");Array.from(el.attributes).forEach(function(e){"type"!==e.name&&"data-blocked-by-consent"!==e.name&&"data-blocked-by-ccpa"!==e.name&&ns.setAttribute(e.name,e.value)});ns.type="text/javascript";ns.onload=function(){ensureGtagInitialization()};el.parentNode.insertBefore(ns,el);el.remove()}else{el.type="text/javascript";el.removeAttribute("data-blocked-by-consent");if(el.innerHTML)try{eval(el.innerHTML)}catch(e){}}released++}catch(e){}finally{__cbInternalCreate=!1}}}});console.log("[ConsentBit][Release] Done — released:",released);setTimeout(ensureGtagInitialization,100)}function hideBanner(){var e=document.getElementById("consentBitBanner");e&&(e.style.display="none");var t=document.getElementById("consentBitPopupOverlay");t&&(t.style.display="none")}function initCookieAccordions(){var e=document.getElementById("cookieAccordions");!e||e.children.length>0||cookieCategories.forEach(function(t){var n=t.cookies.length>0,o=document.createElement("div");o.className="cb-accordion";o.id="cbDetailCategory"+t.id;var i="";if(n){var a=t.alwaysActive,r,c;i='<div style="display:flex;align-items:center;gap:8px;"><div class="cb-switch-sm"><input '+(a?'type="checkbox" id="cbSwitch'+t.id+'" checked disabled aria-label="'+t.name+' (Always Active)" autocomplete="off"':'type="checkbox" id="cbSwitch'+t.id+'" aria-label="Enable '+t.name+'" autocomplete="off"')+(a?' style="background-color:#2e7d32;"':"")+"></div>"+(a?'<span class="cb-always-active">Always Active</span>':"")+"</div>"}o.innerHTML='<div class="cb-accordion-item"><div class="cb-accordion-chevron"><i class="cb-chevron-right"></i></div><div class="cb-accordion-header-wrapper"><div class="cb-accordion-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;"><button class="cb-accordion-btn" aria-expanded="false" aria-controls="cbDetailCategory'+t.id+'Body">'+t.name+"</button>"+i+'</div><div class="cb-accordion-header-des"></div></div></div><div class="cb-accordion-body" id="cbDetailCategory'+t.id+'Body"><div class="cb-audit-table">'+t.description+"</div></div>";e.appendChild(o)})}function initPurposeAccordions(){var e=document.getElementById("purposeAccordions");!e||e.children.length>0||purposesData.forEach(function(t){var n=document.createElement("div");n.className="cb-accordion";n.id="cbIABPNFSection"+t.id;var o=t.hasToggle?'<div style="display:flex;align-items:center;gap:8px;"><div class="cb-switch-sm"><input type="checkbox" id="cbIABPNFSection'+t.id+'Toggle" aria-label="Enable '+t.title+'" autocomplete="off"></div></div>':"",i=t.items.map(function(e){var t="";if(e.hasLegitimate||e.hasConsent){var n,o;t='<div class="cb-switch-wrapper">'+(e.hasLegitimate?'<div class="cb-legitimate-switch-wrapper'+(e.hasConsent?" cb-switch-separator":"")+'"><div class="cb-switch-label">Legitimate Interest</div><div class="cb-switch-sm"><input type="checkbox" id="cbIABPNFSection'+e.id+'ToggleLegitimate" aria-label="Disable '+e.title+' Legitimate Interest" autocomplete="off" checked></div></div>':"")+(e.hasConsent?'<div class="cb-consent-switch-wrapper"><div class="cb-switch-label">Consent</div><div class="cb-switch-sm"><input type="checkbox" id="cbIABPNFSection'+e.id+'ToggleConsent" aria-label="Enable '+e.title+' Consent" autocomplete="off"></div></div>':"")+"</div>"}var i=e.illustrations?'<div class="cb-iab-illustrations"><p class="cb-iab-illustrations-title">Illustrations</p><ul class="cb-iab-illustrations-des">'+e.illustrations.map(function(e){return"<li>"+e+"</li>"}).join("")+"</ul></div>":"";return'<div class="cb-child-accordion" id="cbIABPNFSection'+e.id+'"><div class="cb-child-accordion-item"><div class="cb-child-accordion-chevron"><i class="cb-chevron-right"></i></div><div class="cb-child-accordion-header-wrapper"><button class="cb-child-accordion-btn" aria-expanded="false" aria-controls="cbIABPNFSection'+e.id+'Body" aria-label="'+e.title+'">'+e.title+"</button>"+t+'</div></div><div class="cb-child-accordion-body" id="cbIABPNFSection'+e.id+'Body"><div class="cb-iab-ad-settings-details"><p class="cb-iab-ad-settings-details-des">'+e.description+"</p>"+i+'<p class="cb-iab-vendors-count-wrapper">Number of Vendors seeking consent: '+e.vendorCount+"</p></div></div></div>"}).join("");n.innerHTML='<div class="cb-accordion-iab-item"><div class="cb-accordion-chevron"><i class="cb-chevron-right"></i></div><div class="cb-accordion-header-wrapper"><div class="cb-accordion-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;"><button class="cb-accordion-btn" aria-expanded="false" aria-controls="cbIABPNFSection'+t.id+'Body" aria-label="'+t.title+'">'+t.title+"</button>"+o+'</div><div class="cb-accordion-header-des"><p>'+(t.description||"")+'</p></div></div></div><div class="cb-accordion-body" id="cbIABPNFSection'+t.id+'Body">'+i+"</div>";e.appendChild(n)})}async function loadVendors(){var e=document.getElementById("vendorsLoading"),t=document.getElementById("vendorsList"),n=document.getElementById("vendorsSearch");try{await waitForTCF();var o=window.tcfManager.getVendors();e.style.display="none";t.style.display="block";if(o&&Object.keys(o).length>0){var i=[];Object.entries(o).forEach(function(e){var t=e[0],n=e[1],o="consentBitVendorSection_"+t,a=document.createElement("div");a.className="consentBit-vendor-item";a.dataset.vendorId=t;a.dataset.vendorName=n.name.toLowerCase();var r=document.createElement("div");r.className="consentBit-vendor-header";var c=document.createElement("div");c.className="consentBit-vendor-info";var s=document.createElement("div");s.className="consentBit-vendor-name";s.textContent=n.name;var d=document.createElement("div");d.className="consentBit-vendor-id";d.textContent="ID: "+t;c.appendChild(s);c.appendChild(d);var l=document.createElement("div");l.className="consentBit-switch-wrapper";var p=document.createElement("div");p.className="consentBit-consent-switch-wrapper";var b=document.createElement("div");b.className="consentBit-switch-label";b.textContent="Consent";var u=document.createElement("div");u.className="cb-switch-sm";var g=document.createElement("input");g.type="checkbox";g.id=o+"ToggleConsent";g.setAttribute("aria-label","Disable "+n.name+" Consent");g.setAttribute("autocomplete","off");g.setAttribute("data-sharkid","__"+t);u.appendChild(g);p.appendChild(b);p.appendChild(u);l.appendChild(p);r.appendChild(c);r.appendChild(l);a.appendChild(r);i.push(a)});t.vendorsData=i;t.innerHTML="";t.append.apply(t,i);window.vendorPreferences&&Object.entries(window.vendorPreferences).forEach(function(e){var t=e[0],n=e[1],o=document.querySelector('input[data-sharkid="'+t+'"]');o&&(o.checked=n.consent)});initVendorSearch(t,n)}else t.innerHTML='<p class="consentBit-empty-vendors-text">No vendors to display.</p>'}catch(t){console.error("Error loading vendors:",t);e.textContent="Failed to load vendors. Please try again."}}function initVendorSearch(e,t){t&&t.addEventListener("input",function(t){var n=t.target.value.toLowerCase().trim(),o=e.vendorsData||[];o.forEach(function(e){var t=e.dataset.vendorName,o=e.dataset.vendorId;if(""===n||t.includes(n)||o.includes(n)){e.style.display="block";e.classList.remove("consentBit-hidden")}else{e.style.display="none";e.classList.add("consentBit-hidden")}});updateNoResultsMessage(e,n,o)})}function updateNoResultsMessage(e,t,n){var o=n.filter(function(e){return"none"!==e.style.display&&!e.classList.contains("consentBit-hidden")}).length,i=e.querySelector(".consentBit-no-results");if(0===o&&""!==t){if(!i){(i=document.createElement("div")).className="consentBit-no-results";i.innerHTML='<p>No vendors found for "'+t+'"</p><small>Try searching by vendor name or ID</small>';e.prepend(i)}}else i&&i.remove()}function loadExistingPreferences(){if(window.tcfManager){var e=window.tcfManager.loadStoredConsent();if(e){hideBanner();e.cookieCategories&&Object.entries(e.cookieCategories).forEach(function(e){var t=e[0],n=e[1],o=document.getElementById("cbSwitch"+t);o&&!o.disabled&&(o.checked=n.enabled)});e.purposes&&Object.entries(e.purposes).forEach(function(e){var t=e[0],n=e[1],o=document.getElementById("cbIABPNFSection"+t+"ToggleConsent"),i=document.getElementById("cbIABPNFSection"+t+"ToggleLegitimate");o&&void 0!==n.consent&&(o.checked=n.consent);i&&void 0!==n.legitimate&&(i.checked=n.legitimate)});e.specialFeatures&&Object.entries(e.specialFeatures).forEach(function(e){var t=e[0],n=e[1],o=document.getElementById("cbIABPNFSection"+t+"ToggleConsent");o&&void 0!==n.consent&&(o.checked=n.consent)});window.__cbConsentState={categories:{analytics:!!(e.cookieCategories&&e.cookieCategories.analytics&&e.cookieCategories.analytics.enabled),functional:!!(e.cookieCategories&&e.cookieCategories.functional&&e.cookieCategories.functional.enabled),performance:!!(e.cookieCategories&&e.cookieCategories.performance&&e.cookieCategories.performance.enabled),advertisement:!!(e.cookieCategories&&e.cookieCategories.advertisement&&e.cookieCategories.advertisement.enabled)}};releaseBlockedScripts();window.vendorPreferences=e.vendors||{};window.vendorPreferences&&Object.entries(window.vendorPreferences).forEach(function(e){var t=e[0],n=e[1],o=document.querySelector('input[data-sharkid="'+t+'"]');o&&(o.checked=n.consent)})}else console.log("[ConsentBit][LoadPrefs] No stored consent — first-time visitor")}else console.warn("TCF Manager not initialized yet")}function initTabs(){var e=document.querySelectorAll(".cb-iab-nav-item"),t=document.querySelectorAll(".cb-preference-body-wrapper");e.forEach(function(n){n.addEventListener("click",function(){var o=n.dataset.tab;e.forEach(function(e){e.classList.remove("cb-iab-nav-item-active")});n.classList.add("cb-iab-nav-item-active");t.forEach(function(e){e.classList.remove("active")});"cookie"===o?document.getElementById("cbIABSectionCookie").classList.add("active"):"purpose"===o?document.getElementById("cbIABSectionPurpose").classList.add("active"):"vendor"===o&&document.getElementById("cbIABSectionVendor").classList.add("active")})})}function initAccordions(){document.addEventListener("click",function(e){var t=e.target.closest(".cb-accordion-item, .cb-accordion-iab-item");if(t&&!e.target.closest("input, .cb-switch")){var n=t.closest(".cb-accordion");n.classList.toggle("active");var o=t.querySelector(".cb-accordion-btn");o&&o.setAttribute("aria-expanded",n.classList.contains("active"))}var i=e.target.closest(".cb-child-accordion-item");if(i&&!e.target.closest("input, .cb-switch, .cb-switch-wrapper")){var a=i.closest(".cb-child-accordion");a.classList.toggle("active");var r=i.querySelector(".cb-child-accordion-btn");r&&r.setAttribute("aria-expanded",a.classList.contains("active"))}})}function closeModal(){document.getElementById("cbPreferenceModal").classList.add("cb-modal-hidden")}function openModal(){document.getElementById("cbPreferenceModal").classList.remove("cb-modal-hidden")}function initButtons(){document.getElementById("cbCloseBtn").addEventListener("click",closeModal);document.getElementById("cbCloseBtn1").addEventListener("click",hideBanner);document.getElementById("cbRejectBtn").addEventListener("click",rejectAll);document.querySelector(".consentBit-btn-reject").addEventListener("click",rejectAll);document.getElementById("cbSaveBtn").addEventListener("click",savePreferences);document.getElementById("cbAcceptBtn").addEventListener("click",acceptAll);document.querySelector(".consentBit-btn-accept").addEventListener("click",acceptAll);var e=document.querySelector(".consentBit-btn-customize"),t=document.querySelector(".cb-modal"),n=document.querySelector(".consentBit-consent-container");e&&t&&e.addEventListener("click",function(){openModal();n&&(n.style.display="none")})}async function rejectAll(){if(window.tcfManager){await window.tcfManager.rejectAll();window.__cbConsentState={allDenied:!0};blockNonEssentialScripts();hideBanner();closeModal()}}async function savePreferences(){if(window.tcfManager){var e={cookieCategories:{},purposes:{},vendors:{},specialFeatures:{}};document.querySelectorAll('input[id^="cbSwitch"]:not([id*="IAB"])').forEach(function(t){var n=t.id.replace("cbSwitch","");e.cookieCategories[n]={enabled:t.checked,alwaysActive:t.disabled}});document.querySelectorAll('input[id$="ToggleLegitimate"], input[id$="ToggleConsent"]').forEach(function(t){var n=t.id.match(/cbIABPNFSection([^T]+)Toggle(Legitimate|Consent)/);if(n){var o=n[1],i=n[2].toLowerCase();e.purposes[o]=e.purposes[o]||{};e.purposes[o][i]=t.checked}});purposesData.forEach(function(t){"special-features"===t.id&&t.items.forEach(function(t){var n=document.getElementById("cbIABPNFSection"+t.id+"ToggleConsent");n&&(e.specialFeatures[t.id]={consent:n.checked})})});document.querySelectorAll("input[data-sharkid]").forEach(function(t){var n=t.getAttribute("data-sharkid");n&&(e.vendors[n]={consent:t.checked})});await window.tcfManager.saveConsent(e);window.__cbConsentState={categories:{analytics:!(!e.cookieCategories.analytics||!e.cookieCategories.analytics.enabled),functional:!(!e.cookieCategories.functional||!e.cookieCategories.functional.enabled),performance:!(!e.cookieCategories.performance||!e.cookieCategories.performance.enabled),advertisement:!(!e.cookieCategories.advertisement||!e.cookieCategories.advertisement.enabled)}};blockNonEssentialScripts();releaseBlockedScripts();closeModal()}}async function acceptAll(){if(window.tcfManager){await window.tcfManager.acceptAll();window.__cbConsentState={allGranted:!0};releaseBlockedScripts();document.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach(function(e){e.checked=!0});hideBanner();closeModal()}}function injectFloatingTrigger(){if(!document.getElementById("cb-floating-trigger")){var e=document.createElement("button");e.id="cb-floating-trigger";e.type="button";e.setAttribute("aria-label","Cookie Preferences");e.style.cssText="position:fixed;bottom:16px;left:16px;z-index:99999;width:40px;height:40px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none";var t=document.createElement("img");t.alt="";var n=siteConfig&&siteConfig.floatingLogoUrl||BASE_URL+"/embed/floating-logo.svg";t.src=n;t.width=28;t.height=28;t.draggable=!1;t.style.cssText="display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none";e.appendChild(t);document.body.appendChild(e);e.addEventListener("click",function(){openModal()})}}function initGroupToggles(){var e;[{toggleId:"cbIABPNFSectionpurposesToggle",childSelector:'[id^="cbIABPNFSectionpurpose"][id$="ToggleConsent"]:not([id="cbIABPNFSectionpurposesToggle"])'},{toggleId:"cbIABPNFSectionspecial-featuresToggle",childSelector:'[id^="cbIABPNFSectionspecial-feature"][id$="ToggleConsent"]:not([id="cbIABPNFSectionspecial-featuresToggle"])'}].forEach(function(e){var t=document.getElementById(e.toggleId);if(t){var n=function(){return Array.from(document.querySelectorAll(e.childSelector))};t.addEventListener("change",function(){n().forEach(function(e){e.checked=t.checked})});document.addEventListener("change",function(e){n().includes(e.target)&&o()});o()}function o(){var e=n();e.length&&(t.checked=e.every(function(e){return e.checked}))}})}async function initAll(){injectStyles();if(ensureConsentUiShell()){blockNonEssentialScripts();initCookieAccordions();initPurposeAccordions();initGroupToggles();initTabs();initAccordions();initButtons();injectFloatingTrigger();await loadVendors();var e=setInterval(function(){if(window.tcfManager&&window.tcfManager.isInitialized){clearInterval(e);loadExistingPreferences()}},100)}}installConsentScriptBlocker();initConsentDependencies();"loading"===document.readyState?document.addEventListener("DOMContentLoaded",initAll):initAll();var CB_OVER_LIMIT_KEY_IAB="cb_pv_over_limit_"+(SITE_ID||"");function isPageviewOverLimitIab(){try{var e=localStorage.getItem(CB_OVER_LIMIT_KEY_IAB);if(!e)return!1;var t=JSON.parse(e),n=new Date,o=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0");return t.yearMonth===o&&!0===t.overLimit}catch(e){return!1}}function markPageviewOverLimitIab(e){try{localStorage.setItem(CB_OVER_LIMIT_KEY_IAB,JSON.stringify({overLimit:!0,yearMonth:e}))}catch(e){}}function sendPageviewIab(){if(SITE_ID&&API_BASE&&!isPageviewOverLimitIab())try{fetch(API_BASE+"/api/pageview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({siteId:SITE_ID,pageUrl:"undefined"!=typeof window&&window.location?window.location.href:null}),keepalive:!0}).then(function(e){return e.json()}).then(function(e){if(e&&e.overLimit){var t=new Date,n;markPageviewOverLimitIab(e.yearMonth||t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0"))}}).catch(function(e){console.warn("[ConsentBit] /api/pageview failed",e)})}catch(e){console.warn("[ConsentBit] /api/pageview threw",e)}}try{sendPageviewIab()}catch(e){}})();
`

  // loaderWebflow: standard banner behaviour with script blocking delegated to consent.js.
  // Sets window.__CB_WEBFLOW_MODE__ = true before the main IIFE so that
  // installConsentScriptBlocker / blockNonEssentialScripts become no-ops and
  // releaseBlockedScripts / notifyWebflowConsent dispatch 'consentUpdated' events instead.
  // consent.js is served from the same CDN origin as a static asset (public/consent.js).
  const consentJsSrc = (env.CDN_BASE_URL || apiBase) + '/consent.js';
  const loaderWebflow = `
(function(){
  window.__CB_WEBFLOW_MODE__ = true;

  // Load consent.js (UP_Script) from the CDN — handles data-category script blocking,
  // unblocking, and gtag consent mode for Webflow/Framer sites.
  var CONSENT_JS_SRC = ${JSON.stringify(consentJsSrc)};
  if (!document.querySelector('script[src="' + CONSENT_JS_SRC + '"]')) {
    var _s = document.createElement('script');
    _s.src = CONSENT_JS_SRC;
    _s.async = true;
    _s.setAttribute('data-display-name', 'ConsentBitScript2025');
    document.head.appendChild(_s);
  }
})();
` + loader;

  // loaderIabWebflow: IAB/TCF banner with script blocking delegated to consent.js.
  // Built by patching loaderIab's 3 blocking functions + injecting notifyWebflowConsent.
  // loaderIab itself is never modified.
  const loaderIabWebflow = (() => {
    const webflowSetup = `
(function(){
  window.__CB_WEBFLOW_MODE__ = true;
  var CONSENT_JS_SRC = ${JSON.stringify(consentJsSrc)};
  if (!document.querySelector('script[src="' + CONSENT_JS_SRC + '"]')) {
    var _s = document.createElement('script');
    _s.src = CONSENT_JS_SRC;
    _s.async = true;
    _s.setAttribute('data-display-name', 'ConsentBitScript2025');
    document.head.appendChild(_s);
  }
})();
`;
    const notifyFn = `
  function notifyWebflowConsent(cats) {
    if (!window.__CB_WEBFLOW_MODE__) return;
    var detail = cats || {};
    window.userConsent = detail;
    try { document.dispatchEvent(new CustomEvent('consentUpdated', { detail: detail, bubbles: true })); } catch(e) {}
  }
`;
    const installGuard =
      `function installConsentScriptBlocker() {\n    if (window.__CB_WEBFLOW_MODE__) return;`;
    const blockGuard =
      `function blockNonEssentialScripts() {\n    if (window.__CB_WEBFLOW_MODE__) { try { document.dispatchEvent(new CustomEvent('cbBlockScripts', { bubbles: true })); } catch(e) {} return; }`;
    const releaseGuard =
      `function releaseBlockedScripts() {\n    if (window.__CB_WEBFLOW_MODE__) { notifyWebflowConsent((window.__cbConsentState && (window.__cbConsentState.categories || window.__cbConsentState)) || { analytics: true, marketing: true, preferences: true, essential: true }); return; }`;

    // Use regex so newlines match regardless of \n vs real newline in the template
    let patched = loaderIab
      .replace(
        /function installConsentScriptBlocker\(\) \{\s*if \(window\.__cbCreateElementHookInstalled\) return;/,
        installGuard + '\n    if (window.__cbCreateElementHookInstalled) return;'
      )
      .replace(
        /function blockNonEssentialScripts\(\) \{\s*var scripts = Array\.from/,
        blockGuard + '\n    var scripts = Array.from'
      )
      .replace(
        /function releaseBlockedScripts\(\) \{\s*var list = Array\.from/,
        releaseGuard + '\n    var list = Array.from'
      )
      // inject notifyWebflowConsent before installConsentScriptBlocker (after first replace)
      .replace(
        /function installConsentScriptBlocker\(\) \{\s*if \(window\.__CB_WEBFLOW_MODE__\) return;/,
        notifyFn + '  function installConsentScriptBlocker() {\n    if (window.__CB_WEBFLOW_MODE__) return;'
      );
    return webflowSetup + patched;
  })();

  // IAB/TCF banner requires a paid tier that includes IAB (Essential or Growth).
  // If the site was downgraded to a lower plan, fall back to the standard GDPR banner
  // so the IAB UI is never served.
  const iabAllowed = effectivePlanId === 'growth' || effectivePlanId === 'essential';
  const wantsIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab';
  const isWebflow = String(resolvedSite.platform || '').toLowerCase() === 'webflow' ||
                    String(resolvedSite.platform || '').toLowerCase() === 'framer';
  const serveKind = (wantsIab && isWebflow) ? 'iabwebflow' : wantsIab ? 'iab' : isWebflow ? 'webflow' : 'standard';
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
    `// ConsentBit loader=${serveKind}\n` +
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
