// handlers/bannerCustomization.js
import { getBannerCustomization, saveBannerCustomization } from '../services/db.js';

export async function handleBannerCustomization(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const siteId = url.searchParams.get('siteId');

    if (!siteId) {
      return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    }

    try {
      const row = await getBannerCustomization(db, siteId);
      let translations = null;
      if (row?.translations) {
        try {
          translations = typeof row.translations === 'string' ? JSON.parse(row.translations) : row.translations;
        } catch (_) {
          translations = null;
        }
      }
      const customization = row ? { ...row, translations } : null;
      console.log('[BannerCustomization] GET siteId=%s customization=%s', siteId, JSON.stringify(customization));
      return Response.json({ success: true, customization });
    } catch (error) {
      console.error('[BannerCustomization] Error fetching:', error);
      return Response.json(
        { success: false, error: error?.message || 'Failed to fetch customization' },
        { status: 500 }
      );
    }
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const siteId = body?.siteId;
    const customization = body?.customization;

    if (!siteId) {
      return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    }

    if (!customization) {
      return Response.json({ success: false, error: 'customization is required' }, { status: 400 });
    }

    try {
      console.log('[BannerCustomization] POST siteId=%s customization=%s', siteId, JSON.stringify(customization));
      await saveBannerCustomization(db, siteId, customization);

      // Sync customization to WEBFLOW_AUTHENTICATION KV so the Webflow Designer App
      // always reads fresh data from Banner-Settings:{platformSiteId}.
      try {
        const siteRow = await db.prepare('SELECT platformSiteId FROM Site WHERE id = ?1').bind(siteId).first();
        const webflowSiteId = siteRow?.platformSiteId ?? null;
        console.log('[BannerCustomization] webappSiteId=%s → platformSiteId(webflowSiteId)=%s', siteId, webflowSiteId ?? 'NOT FOUND (not a Webflow site)');

        if (!webflowSiteId) {
          console.log('[BannerCustomization] No platformSiteId for siteId=%s — skipping KV sync', siteId);
          return Response.json({ success: true });
        }

        const kvKey = `Banner-Settings:${webflowSiteId}`;
        const existing = await env.WEBFLOW_AUTHENTICATION.get(kvKey, { type: 'json' });
        console.log('[BannerCustomization] Existing KV key=%s found=%s', kvKey, existing ? 'YES' : 'NO (first write)');
        const prevAppData = existing?.appData ?? {};

        const appData = {
          ...prevAppData,
          color: customization.backgroundColor ?? prevAppData.color,
          bgColor: customization.backgroundColor ?? prevAppData.bgColor,
          btnColor: customization.acceptButtonBg ?? prevAppData.btnColor,
          headColor: customization.headingColor ?? prevAppData.headColor,
          paraColor: customization.textColor ?? prevAppData.paraColor,
          secondcolor: customization.rejectButtonBg ?? prevAppData.secondcolor,
          secondbuttontext: customization.rejectButtonText ?? prevAppData.secondbuttontext,
          primaryButtonText: customization.acceptButtonText ?? prevAppData.primaryButtonText,
          customiseButtonBg: customization.customiseButtonBg ?? prevAppData.customiseButtonBg,
          customiseButtonText: customization.customiseButtonText ?? prevAppData.customiseButtonText,
          saveButtonBg: customization.saveButtonBg ?? prevAppData.saveButtonBg,
          saveButtonText: customization.saveButtonText ?? prevAppData.saveButtonText,
          borderRadius: customization.bannerBorderRadius != null ? parseFloat(customization.bannerBorderRadius) : prevAppData.borderRadius,
          buttonRadius: customization.buttonBorderRadius != null ? parseFloat(customization.buttonBorderRadius) : prevAppData.buttonRadius,
          selected: customization.position?.includes('right') ? 'right'
            : customization.position?.includes('center') ? 'center'
            : prevAppData.selected,
          cookieExpiration: customization.cookieExpirationDays ?? prevAppData.cookieExpiration,
          animation: customization.centerAnimationDirection ?? prevAppData.animation,
          language: customization.language ?? prevAppData.language,
          privacyUrl: customization.privacyPolicyUrl ?? prevAppData.privacyUrl,
          hideLogo: customization.showBannerLogo != null ? !customization.showBannerLogo : prevAppData.hideLogo,
          isWebappMigrated: true,
        };

        const dataToStore = { appData, siteId: webflowSiteId, updatedAt: new Date().toISOString() };
        console.log('[BannerCustomization] Writing to KV key=%s data=%s', kvKey, JSON.stringify(dataToStore));
        await env.WEBFLOW_AUTHENTICATION.put(kvKey, JSON.stringify(dataToStore));

        // Verify the write by reading back immediately
        const verify = await env.WEBFLOW_AUTHENTICATION.get(kvKey, { type: 'json' });
        console.log('[BannerCustomization] KV verify read key=%s result=%s', kvKey, JSON.stringify(verify));
      } catch (kvErr) {
        console.error('[BannerCustomization] Failed to sync Banner-Settings KV:', kvErr);
      }

      return Response.json({ success: true });
    } catch (error) {
      console.error('[BannerCustomization] Error saving:', error);
      return Response.json(
        { success: false, error: error?.message || 'Failed to save customization' },
        { status: 500 }
      );
    }
  }

  return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
}
