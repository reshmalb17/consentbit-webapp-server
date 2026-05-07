// src/handlers/adminMigrateCustomization.js
import { checkAdminAuth } from '../utils/adminAuth.js';
import { saveBannerCustomization } from '../services/db.js';

// Maps appData.style (KV format) → configJson bannerStyle
const STYLE_FORWARD_MAP = {
  align: 'style1',
  alignstyle: 'style2',
  bigstyle: 'style3',
  centeralign: 'style4',
  fullwidth: 'style5',
};

// Maps configJson bannerStyle → translations.en.bannerLayoutVisual
function bannerLayoutVisual(style) {
  if (style === 'style5') return 'banner';
  if (style === 'style4') return 'bottom-center';
  return 'box';
}


function mapAppDataToCustomization(appData) {
  const wc = appData.webappContent ?? {};
  const style = appData.style ?? appData.bannerLayout ?? 'fullwidth';
  const bannerStyle = STYLE_FORWARD_MAP[style] ?? 'style5';
  const layoutVisual = bannerLayoutVisual(bannerStyle);

  // Position: appData.selected = 'left'|'center'|'right'
  const selected = appData.selected ?? 'left';
  const bannerAlignment = selected === 'right' ? 'bottom-right'
    : selected === 'center' ? 'bottom-center'
    : 'bottom-left';

  const bgColor = appData.bgColor ?? appData.color ?? '#ffffff';
  const headColor = appData.headColor ?? '#0f172a';
  const paraColor = appData.paraColor ?? '#334155';
  const btnColor = appData.btnColor ?? '#0284c7';
  const primaryButtonText = appData.primaryButtonText ?? '#ffffff';
  const secondcolor = appData.secondcolor ?? '#ffffff';
  const secondbuttontext = appData.secondbuttontext ?? '#334155';
  const custBg = appData.customiseButtonBg ?? appData.secondcolor ?? '#ffffff';
  const custTx = appData.customiseButtonText ?? appData.secondbuttontext ?? '#334155';
  const saveBg = appData.saveButtonBg ?? custBg;
  const saveTx = appData.saveButtonText ?? custTx;
  const borderRadius = appData.borderRadius != null ? Number(appData.borderRadius) : 6;
  const buttonRadius = appData.buttonRadius != null ? Number(appData.buttonRadius) : 6;
  const showBannerLogo = appData.hideLogo != null ? !appData.hideLogo : true;

  // Full designConfig format — matches what banner-script-config stores
  const configJson = {
    compliance: appData.compliance ?? ['gdpr'],
    customization: {
      bannerAlignment,
      bannerStyle,
      colors: {
        bannerBg: bgColor,
        title: headColor,
        body: paraColor,
        btnPrimaryBg: btnColor,
        btnPrimaryText: primaryButtonText,
        btnSecondaryBg: btnColor,
        btnSecondaryText: primaryButtonText,
        customiseButtonBg: custBg,
        customiseButtonText: custTx,
        saveButtonBg: saveBg,
        saveButtonText: saveTx,
        bannerBg2: appData.bgColors ?? '#798EFF',
      },
      radius: {
        container: borderRadius,
        button: buttonRadius,
      },
      brandLogo: { show: showBannerLogo, position: appData.logoPosition ?? 'left' },
      closeButton: { show: appData.closebutton ? true : false },
      font: appData.Font ?? appData.font ?? 'Manrope',
      size: appData.size != null ? Number(appData.size) : 16,
      weight: appData.weight ?? 'Regular',
      textAlignment: appData.selectedtext ?? 'left',
    },
    settings: {
      expires: appData.cookieExpiration != null ? Number(appData.cookieExpiration) : 120,
      animation: appData.animation ?? 'Fade',
      language: appData.language ?? 'English',
      privacyUrl: appData.privacyUrl ?? '',
    },
  };

  const translations = {
    en: {
      title: wc.title ?? '',
      description: wc.description ?? '',
      acceptAll: wc.acceptAll ?? 'Accept',
      rejectAll: wc.rejectAll ?? 'Reject',
      customise: wc.customise ?? 'Preference',
      saveMyPreferences: wc.saveMyPreferences ?? 'Save my preferences',
      bannerLayoutVisual: layoutVisual,
      closeButtonEnabled: appData.closebutton ? '1' : '0',
      bannerFontFamily: appData.Font ?? appData.font ?? 'Manrope',
      bannerFontWeight: appData.weight ?? 'Regular',
      bannerFontSize: appData.size != null ? Number(appData.size) : 16,
      bannerTextAlign: appData.selectedtext ?? 'left',
      bannerBg2: appData.bgColors ?? '#798EFF',
    },
  };

  return {
    backgroundColor: bgColor,
    textColor: paraColor,
    headingColor: headColor,
    acceptButtonBg: btnColor,
    acceptButtonText: primaryButtonText,
    rejectButtonBg: btnColor,
    rejectButtonText: primaryButtonText,
    customiseButtonBg: custBg,
    customiseButtonText: custTx,
    saveButtonBg: saveBg,
    saveButtonText: saveTx,
    position: bannerAlignment,
    bannerBorderRadius: `${borderRadius}px`,
    buttonBorderRadius: `${buttonRadius}px`,
    cookieExpirationDays: appData.cookieExpiration != null ? Number(appData.cookieExpiration) : 30,
    language: appData.language ?? 'en',
    privacyPolicyUrl: appData.privacyUrl ?? null,
    showBannerLogo,
    centerAnimationDirection: appData.animation ?? 'fade',
    translations,
    configJson,
    contentEditedFromWebapp: appData.contentEditedFromWebapp ?? false,
  };
}

export async function handleAdminMigrateCustomization(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }
  const authKv = env.WEBFLOW_AUTHENTICATION;
  if (!authKv) {
    return Response.json({ success: false, error: 'WEBFLOW_AUTHENTICATION not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const domainFilter = url.searchParams.get('domain') || null;

  // Fetch all legacy Webflow sites that have been migrated (have platformSiteId)
  let sites;
  try {
    const query = domainFilter
      ? `SELECT s.id AS siteId, s.platformSiteId, s.cdnScriptId, s.domain,
                u.id AS userId
         FROM Site s
         LEFT JOIN Organization o ON o.id = s.organizationId
         LEFT JOIN User u ON u.id = o.ownerUserId
         WHERE s.isLegacy = 1 AND s.platform = 'webflow' AND s.platformSiteId IS NOT NULL
           AND s.domain = ?1`
      : `SELECT s.id AS siteId, s.platformSiteId, s.cdnScriptId, s.domain,
                u.id AS userId
         FROM Site s
         LEFT JOIN Organization o ON o.id = s.organizationId
         LEFT JOIN User u ON u.id = o.ownerUserId
         WHERE s.isLegacy = 1 AND s.platform = 'webflow' AND s.platformSiteId IS NOT NULL`;
    const { results } = domainFilter
      ? await db.prepare(query).bind(domainFilter).all()
      : await db.prepare(query).all();
    sites = results ?? [];
  } catch (err) {
    return Response.json({ success: false, error: `DB query failed: ${err?.message}` }, { status: 500 });
  }

  const migrated = [], skipped = [], errors = [];

  for (const site of sites) {
    const { siteId, platformSiteId, cdnScriptId, domain, userId } = site;
    const kvKey = `Banner-Settings:${platformSiteId}`;
    try {
      const raw = await authKv.get(kvKey, { type: 'json' });
      if (!raw || !raw.appData) {
        skipped.push({ siteId, domain, wfSiteId: platformSiteId, reason: 'no Banner-Settings in KV' });
        continue;
      }

      const appData = raw.appData;
      const customization = mapAppDataToCustomization(appData);

      if (!dryRun) {
        await saveBannerCustomization(db, siteId, customization);
      }

      migrated.push({ siteId, domain, wfSiteId: platformSiteId, status: dryRun ? 'dry-run' : 'migrated' });
    } catch (err) {
      errors.push({ siteId, domain, wfSiteId: platformSiteId, error: err?.message });
    }
  }

  return Response.json({
    success: true,
    dryRun,
    total: sites.length,
    migrated: migrated.length,
    skipped: skipped.length,
    errors: errors.length,
    results: { migrated, skipped, errors },
  });
}
