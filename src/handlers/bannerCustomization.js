// handlers/bannerCustomization.js
import { getBannerCustomization, saveBannerCustomization } from '../services/db.js';

export async function handleBannerCustomization(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method === 'GET') {
    const url = new URL(request.url);
    let siteId = url.searchParams.get('siteId');
    const wfSiteId = url.searchParams.get('wfSiteId');

    // wfSiteId lookup — resolve D1 internal siteId from Webflow platform siteId
    if (!siteId && wfSiteId) {
      try {
        // 1. Fast path: direct platformSiteId match
        const siteRow = await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(wfSiteId).first();
        if (siteRow) {
          siteId = siteRow.id;
        } else {
          // 2. Fallback: get domain from WEBFLOW_AUTHENTICATION KV → find Site by domain → auto-link
          // Handles new users who paid via checkout (Site created with domain only, no platformSiteId yet)
          const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(wfSiteId);
          if (kvRaw) {
            const kvEntry = JSON.parse(kvRaw);
            const rawDomain = kvEntry.customDomain || kvEntry.stagingUrl || kvEntry.domain || null;
            if (rawDomain) {
              const cleanDomain = rawDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
              const domainRow = await db.prepare(
                'SELECT id, platform FROM Site WHERE LOWER(REPLACE(domain, "https://", "")) = ?1 LIMIT 1'
              ).bind(cleanDomain).first();
              if (domainRow) {
                siteId = domainRow.id;
                // Auto-update platformSiteId + platform so future lookups hit the fast path
                db.prepare(
                  'UPDATE Site SET platformSiteId = ?1, platform = COALESCE(platform, ?2), updatedAt = ?3 WHERE id = ?4'
                ).bind(wfSiteId, 'webflow', new Date().toISOString(), siteId).run().catch(() => {});
                console.log('[BannerCustomization] auto-linked platformSiteId=%s to siteId=%s via domain=%s', wfSiteId, siteId, cleanDomain);
              }
            }
          }
        }
      } catch (_) { /* non-critical */ }
    }

    if (!siteId) {
      // wfSiteId passed but no D1 record found — site not registered yet
      if (wfSiteId) {
        return Response.json({ success: true, customization: null, platform: null, isLegacy: 0, isWebappMigrated: false, isWebflowFree: false });
      }
      return Response.json({ success: false, error: 'siteId or wfSiteId is required' }, { status: 400 });
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

      // Fetch Site flags so callers can distinguish new-free Webflow users from legacy migrated users
      let siteFlags = { platform: null, isLegacy: 0 };
      try {
        const siteRow = await db.prepare('SELECT platform, isLegacy FROM Site WHERE id = ?1').bind(siteId).first();
        if (siteRow) siteFlags = { platform: siteRow.platform ?? null, isLegacy: Number(siteRow.isLegacy ?? 0) };
      } catch (_) { /* non-critical */ }

      const isWebappMigrated = true; // site exists in D1
      const isWebflowFree = siteFlags.platform === 'webflow' && siteFlags.isLegacy === 0;

      console.log('[BannerCustomization] GET siteId=%s platform=%s isLegacy=%s isWebflowFree=%s', siteId, siteFlags.platform, siteFlags.isLegacy, isWebflowFree);
      return Response.json({ success: true, customization, platform: siteFlags.platform, isLegacy: siteFlags.isLegacy, isWebappMigrated, isWebflowFree });
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

    const postUrl = new URL(request.url);
    let siteId = body?.siteId;
    const customization = body?.customization;
    const wfSiteId = body?.wfSiteId || postUrl.searchParams.get('wfSiteId') || null;

    // If siteId provided but doesn't exist in D1, resolve via wfSiteId or platformSiteId
    if (siteId) {
      try {
        const exists = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
        if (!exists) {
          console.warn('[BannerCustomization] POST siteId=%s not found in D1 — attempting wfSiteId fallback', siteId);
          const fallbackWfId = wfSiteId || siteId; // siteId might actually be a wfSiteId
          const byPlatform = await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(fallbackWfId).first();
          if (byPlatform) {
            console.log('[BannerCustomization] POST resolved stale siteId=%s → %s via platformSiteId', siteId, byPlatform.id);
            siteId = byPlatform.id;
          } else {
            return Response.json({ success: false, error: 'Site not found — please re-register', stale: true }, { status: 404 });
          }
        }
      } catch (_) {}
    }

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

        // Parse translations to extract content fields and toggle states
        let enTrans = {};
        try {
          const rawTrans = customization.translations;
          const parsed = typeof rawTrans === 'string' ? JSON.parse(rawTrans) : rawTrans;
          enTrans = parsed?.en ?? {};
        } catch (_) {}

        // Convert rem/px border radius string to integer pixels for the Designer App
        const parseBorderRadius = (val) => {
          if (val == null) return null;
          const s = String(val).trim();
          const n = parseFloat(s);
          if (isNaN(n)) return 0;
          // rem suffix, OR small decimal (< 10 and not a whole number) stored with any suffix — treat as rem
          if (s.endsWith('rem') || (n < 10 && n % 1 !== 0)) return Math.round(n * 16);
          return Math.round(n) || 0;
        };

        const appData = {
          ...prevAppData,
          // Colors
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
          // Radii — converted to px integers
          borderRadius: customization.bannerBorderRadius != null ? parseBorderRadius(customization.bannerBorderRadius) : prevAppData.borderRadius,
          buttonRadius: customization.buttonBorderRadius != null ? parseBorderRadius(customization.buttonBorderRadius) : prevAppData.buttonRadius,
          // Layout & settings
          selected: customization.position?.includes('right') ? 'right'
            : customization.position?.includes('center') ? 'center'
            : prevAppData.selected,
          cookieExpiration: customization.cookieExpirationDays ?? prevAppData.cookieExpiration,
          animation: customization.centerAnimationDirection ?? prevAppData.animation,
          language: customization.language ?? prevAppData.language,
          privacyUrl: customization.privacyPolicyUrl ?? prevAppData.privacyUrl,
          hideLogo: customization.showBannerLogo != null ? !customization.showBannerLogo : prevAppData.hideLogo,
          // Toggle states from translations.en
          closebutton: enTrans.closeButtonEnabled != null ? (enTrans.closeButtonEnabled === '1' || enTrans.closeButtonEnabled === true) : (prevAppData.closebutton ?? false),
          // Webapp-edited content fields (English only — always overwrite from translations.en)
          webappContent: {
            title: enTrans.title ?? prevAppData.webappContent?.title ?? '',
            description: enTrans.description ?? prevAppData.webappContent?.description ?? '',
            acceptAll: enTrans.acceptAll ?? prevAppData.webappContent?.acceptAll ?? 'Accept',
            rejectAll: enTrans.rejectAll ?? prevAppData.webappContent?.rejectAll ?? 'Reject',
            customise: enTrans.customise ?? prevAppData.webappContent?.customise ?? 'Preference',
            saveMyPreferences: enTrans.saveMyPreferences ?? prevAppData.webappContent?.saveMyPreferences ?? 'Save my preferences',
          },
          // Flag: content was edited from webapp
          contentEditedFromWebapp: customization.contentEditedFromWebapp === true ? true : (prevAppData.contentEditedFromWebapp ?? false),
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
