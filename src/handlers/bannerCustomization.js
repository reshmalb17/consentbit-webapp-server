// handlers/bannerCustomization.js
import { getBannerCustomization, saveBannerCustomization } from '../services/db.js';
import { injectScriptIntoWebflowHead } from './webflowFreeRegister.js';
import { capturePostHogEvent, identifyPostHogPerson } from '../services/posthog.js';

function encodeEnvelope(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { d: btoa(binary) };
}

function decodeEnvelopeBody(body) {
  if (body && typeof body.d === 'string') {
    try {
      const binary = atob(body.d);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {}
  }
  return body;
}

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

            // Direct webappSiteId lookup (fastest — set after registerWebflowFree completes)
            if (!siteId && kvEntry.webappSiteId) {
              const directRow = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(kvEntry.webappSiteId).first();
              if (directRow) {
                siteId = directRow.id;
                // Stamp platformSiteId so future lookups hit the fast path
                db.prepare('UPDATE Site SET platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3')
                  .bind(wfSiteId, new Date().toISOString(), siteId).run().catch(() => {});
              }
            }

            // Domain-based fallback (handles checkout-registered sites before platformSiteId is set)
            if (!siteId) {
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
                }
              }
            }
          }
        }
      } catch (_) { /* non-critical */ }
    }

    if (!siteId) {
      // wfSiteId passed but no D1 record found — site not registered yet
      if (wfSiteId) {
        return Response.json({ success: true, customization: null, platform: null, isLegacy: 0, isWebappMigrated: false, isWebflowFree: false, isBannerAdded: false, plan: null, webappSiteId: null });
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

      // customization returned below

      // Fetch Site flags so callers can distinguish new-free Webflow users from legacy migrated users
      let siteFlags = { platform: null, isLegacy: 0, bannerType: 'gdpr', regionMode: 'gdpr', webflowScriptId: null, platformSiteId: null };
      try {
        const siteRow = await db.prepare('SELECT platform, isLegacy, banner_type, region_mode, webflowScriptId, platformSiteId FROM Site WHERE id = ?1').bind(siteId).first();
        if (siteRow) siteFlags = { platform: siteRow.platform ?? null, isLegacy: Number(siteRow.isLegacy ?? 0), bannerType: siteRow.banner_type ?? 'gdpr', regionMode: siteRow.region_mode ?? 'gdpr', webflowScriptId: siteRow.webflowScriptId ?? null, platformSiteId: siteRow.platformSiteId ?? null };
      } catch (_) { /* non-critical */ }

      const isWebappMigrated = true; // site exists in D1
      const isWebflowFree = siteFlags.platform === 'webflow' && siteFlags.isLegacy === 0;
      const iabActivated = siteFlags.bannerType === 'iab';
      // Legacy users: banner added via old OAuth flow (isLegacy = 1).
      // New free users: banner is only considered "added" once the user has published at least once
      // from the Designer App (which creates the BannerCustomization record). webflowScriptId alone
      // is not enough because registerWebflowFree sets it during installation before the user has
      // gone through the Scan Project onboarding flow.
      const isBannerAdded = siteFlags.isLegacy === 1 || (!!siteFlags.webflowScriptId && customization !== null);

      // Derive compliance from DB region_mode (set whenever POST includes compliance).
      // KV Banner-Settings takes precedence if present (stores last value sent from Webflow Designer App).
      // Content-based inference is the last-resort fallback for sites that have never published
      // compliance explicitly (region_mode still at default 'gdpr' but CCPA content is present).
      const regionModeToCompliance = (rm) => {
        if (rm === 'both') return ['gdpr', 'us'];
        if (rm === 'ccpa') return ['us'];
        return null; // null = not explicitly set — allow content fallback below
      };
      let compliance = iabActivated ? ['gdpr', 'us'] : regionModeToCompliance(siteFlags.regionMode);
      let kvPlan = null;
      let kvWebappSiteId = null;
      try {
        const resolvedWfSiteId = siteFlags.platformSiteId ?? wfSiteId ?? null;
        if (resolvedWfSiteId) {
          const kvEntry = await env.WEBFLOW_AUTHENTICATION?.get(`Banner-Settings:${resolvedWfSiteId}`, { type: 'json' });
          if (Array.isArray(kvEntry?.appData?.compliance) && kvEntry.appData.compliance.length) {
            // Only trust KV if it was explicitly set (not just the default ['gdpr'])
            const kvC = kvEntry.appData.compliance;
            if (kvC.includes('us') || kvC.includes('ccpa') || kvC.includes('both')) {
              compliance = kvC; // explicitly set to CCPA or both
            } else if (compliance === null) {
              compliance = kvC; // use KV gdpr-only as the explicit value
            }
          }
          // Read plan + webappSiteId from root WEBFLOW_AUTHENTICATION entry (stamped by Stripe webhook after checkout)
          try {
            const rootKvRaw = await env.WEBFLOW_AUTHENTICATION?.get(resolvedWfSiteId);
            if (rootKvRaw) {
              const rootKvEntry = typeof rootKvRaw === 'string' ? JSON.parse(rootKvRaw) : rootKvRaw;
              if (rootKvEntry?.plan && ['basic', 'essential', 'growth'].includes(rootKvEntry.plan)) {
                kvPlan = rootKvEntry.plan;
              }
              if (rootKvEntry?.webappSiteId) {
                kvWebappSiteId = rootKvEntry.webappSiteId;
              }
            }
          } catch (_) { /* non-critical */ }
        }
      } catch (_) { /* non-critical */ }

      // Content-based fallback: if compliance is still null (region_mode was 'gdpr' default and KV
      // had no explicit CCPA), check if CCPA content exists in translations — indicates user selected US.
      if (compliance === null) {
        try {
          const tr = customization?.translations;
          const en = (typeof tr === 'string' ? JSON.parse(tr) : tr)?.en ?? {};
          const hasCcpaContent = !!(en.doNotSell?.trim() || en.ccpaDescription?.trim());
          compliance = hasCcpaContent ? ['us'] : ['gdpr'];
        } catch (_) {
          compliance = ['gdpr'];
        }
      }

      return Response.json(encodeEnvelope({ success: true, customization, platform: siteFlags.platform, isLegacy: siteFlags.isLegacy, isWebappMigrated, isWebflowFree, iabActivated, isBannerAdded, compliance, plan: kvPlan, webappSiteId: kvWebappSiteId }));
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
      body = decodeEnvelopeBody(await request.json());
    } catch (e) {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const postUrl = new URL(request.url);
    let siteId = body?.siteId;
    const customization = body?.customization;
    const wfSiteId = body?.wfSiteId || postUrl.searchParams.get('wfSiteId') || null;
    const skipScriptSwap = body?.skipScriptSwap === true;
    // compliance: ['gdpr'], ['us'], ['gdpr','us'] — from Webflow Designer App publish
    const compliance = Array.isArray(body?.compliance) && body.compliance.length ? body.compliance : null;


    // If siteId provided but doesn't exist in D1, resolve via wfSiteId or platformSiteId
    if (siteId) {
      try {
        const exists = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
        if (!exists) {
          const fallbackWfId = wfSiteId || siteId; // siteId might actually be a wfSiteId
          const byPlatform = await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(fallbackWfId).first();
          if (byPlatform) {
            siteId = byPlatform.id;
          } else {
            return Response.json({ success: false, error: 'Site not found — please re-register', stale: true }, { status: 404 });
          }
        }
      } catch (_) {}
    }

    // If still no siteId, try direct platformSiteId match first (covers paid checkout flow)
    if (!siteId && wfSiteId) {
      try {
        const byPlatform = await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(wfSiteId).first();
        if (byPlatform) {
          siteId = byPlatform.id;
        }
      } catch (_) {}
    }

    // Fallback: check WEBFLOW_AUTHENTICATION KV for webappSiteId (set after registerWebflowFree or checkout injection)
    if (!siteId && wfSiteId) {
      try {
        const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(wfSiteId);
        if (kvRaw) {
          const kvEntry = JSON.parse(kvRaw);
          if (kvEntry.webappSiteId) {
            const siteExists = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(kvEntry.webappSiteId).first();
            if (siteExists) {
              siteId = kvEntry.webappSiteId;
            }
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
      await saveBannerCustomization(db, siteId, customization);

      // Update Site.banner_type and region_mode when compliance is set from the Webflow Designer App.
      // App always includes 'gdpr' (GDPR is forced), so:
      //   gdpr only          → banner_type='gdpr', region_mode='gdpr'
      //   gdpr + us (both)   → banner_type='gdpr', region_mode='both'  (CDN routes by country)
      //   us only            → banner_type='ccpa', region_mode='ccpa'
      if (compliance) {
        const hasUs = compliance.includes('us') || compliance.includes('ccpa');
        const hasGdpr = compliance.includes('gdpr');
        // Default: preserve 'iab' banner_type unless the caller explicitly sends iabEnabled: false.
        // This protects sites configured via the webapp dashboard — they don't send iabEnabled at all
        // (body.iabEnabled is undefined, so iabExplicitlyDisabled = false → 'iab' is kept).
        // The Webflow extension sends iabEnabled: false only when the user accepted the "Continue & Replace"
        // warning, signalling they intentionally want to switch from IAB to a standard banner.
        // iab_enabled lives inside translations.en (JSON blob — no schema change).
        // true  → site has IAB active; preserve banner_type='iab' in the Site table.
        // false → user explicitly chose to replace IAB with a standard banner.
        // undefined/missing → default: preserve 'iab' if it was already set (safe for webapp saves).
        let parsedTrans = null;
        try {
          const rawTrans = customization?.translations;
          parsedTrans = typeof rawTrans === 'string' ? JSON.parse(rawTrans) : rawTrans;
        } catch (_) {}
        const iabEnabledField = parsedTrans?.en?.iab_enabled;
        const iabExplicitlyEnabled = iabEnabledField === true;
        const iabExplicitlyDisabled = iabEnabledField === false;
        const currentSiteRow = await db.prepare('SELECT banner_type FROM Site WHERE id = ?1').bind(siteId).first();
        const currentBannerType = currentSiteRow?.banner_type ?? 'gdpr';
        const newBannerType = iabExplicitlyEnabled
          ? 'iab'
          : (currentBannerType === 'iab' && !iabExplicitlyDisabled)
          ? 'iab'
          : (hasUs && !hasGdpr ? 'ccpa' : 'gdpr');
        const newRegionMode = hasUs && hasGdpr ? 'both' : hasUs ? 'ccpa' : 'gdpr';
        try {
          await db.prepare('UPDATE Site SET banner_type = ?1, region_mode = ?2, updatedAt = ?3 WHERE id = ?4')
            .bind(newBannerType, newRegionMode, new Date().toISOString(), siteId).run();
        } catch (updateErr) {
          console.warn('[BannerCustomization][POST] Failed to update banner_type/region_mode:', updateErr?.message);
        }
      }

      // Sync customization to WEBFLOW_AUTHENTICATION KV so the Webflow Designer App
      // always reads fresh data from Banner-Settings:{platformSiteId}.
      try {
        const siteRow = await db.prepare('SELECT platformSiteId, cdnScriptId, webflowScriptId, embedScriptUrl, banner_type FROM Site WHERE id = ?1').bind(siteId).first();
        // Fall back to wfSiteId from request body if platformSiteId is not yet stamped in DB.
        const webflowSiteId = siteRow?.platformSiteId ?? wfSiteId ?? null;

        if (!webflowSiteId) {
          console.warn('[BannerCustomization][POST] No webflowSiteId — skipping KV sync and script injection');
          return Response.json({ success: true });
        }

        // Stamp platformSiteId if it was missing so future lookups skip this fallback path.
        if (!siteRow?.platformSiteId && webflowSiteId) {
          db.prepare('UPDATE Site SET platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3')
            .bind(webflowSiteId, new Date().toISOString(), siteId).run().catch(() => {});
        }

        const kvKey = `Banner-Settings:${webflowSiteId}`;
        const existing = await env.WEBFLOW_AUTHENTICATION.get(kvKey, { type: 'json' });
        const prevAppData = existing?.appData ?? {};

        // Parse translations — configTrans holds layout/toggle fields (Option 2), enTrans holds text content
        let enTrans = {};
        let configTrans = {};
        try {
          const rawTrans = customization.translations;
          const parsed = typeof rawTrans === 'string' ? JSON.parse(rawTrans) : rawTrans;
          enTrans = parsed?.en ?? {};
          configTrans = parsed?.config ?? {};
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
          selectedtext: configTrans.bannerTextAlign ?? prevAppData.selectedtext ?? 'left',
          language: customization.language ?? prevAppData.language,
          privacyUrl: customization.privacyPolicyUrl ?? prevAppData.privacyUrl,
          hideLogo: customization.showBannerLogo != null ? !customization.showBannerLogo : prevAppData.hideLogo,
          // Toggle states from translations.config (Option 2), fall back to translations.en
          closebutton: (() => { const v = configTrans.closeButtonEnabled ?? enTrans.closeButtonEnabled; return v != null ? (v === '1' || v === true) : (prevAppData.closebutton ?? false); })(),
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
          // Persist compliance so Webflow Designer App reloads the correct selection
          compliance: compliance ?? prevAppData.compliance ?? ['gdpr'],
        };

        const dataToStore = { appData, siteId: webflowSiteId, updatedAt: new Date().toISOString() };
        await env.WEBFLOW_AUTHENTICATION.put(kvKey, JSON.stringify(dataToStore));

        // ── Ensure CDN script is injected into Webflow head on every publish/save ──
        // Runs regardless of skipScriptSwap — always verify the script is in the head.
        // skipScriptSwap only suppresses the post-injection Webflow site publish.
        try {
          const mainKvRaw = await env.WEBFLOW_AUTHENTICATION.get(webflowSiteId);
          if (mainKvRaw) {
            const mainKvEntry = JSON.parse(mainKvRaw);
            if (mainKvEntry.accessToken) {
              await ensureScriptInjected(env, db, siteId, webflowSiteId, mainKvEntry, siteRow, { skipPublish: skipScriptSwap });
            } else {
              console.warn('[BannerCustomization][POST] No accessToken in KV — script injection skipped');
            }
          } else {
            console.warn('[BannerCustomization][POST] No KV entry found for webflowSiteId:', webflowSiteId);
          }
        } catch (swapErr) {
          console.error('[BannerCustomization] Script inject error (non-fatal):', swapErr?.message || swapErr);
        }

        // ── iabActivated flag: reflect site banner_type in main auth KV ──
        // This lets the Webflow app check whether an IAB/TCF banner was activated
        // from the webapp dashboard before overwriting it with a normal banner.
        try {
          const iabActivated = String(siteRow?.banner_type || '').toLowerCase() === 'iab';
          const mainKvForIab = await env.WEBFLOW_AUTHENTICATION.get(webflowSiteId);
          if (mainKvForIab) {
            const mainKvEntryForIab = JSON.parse(mainKvForIab);
            if (mainKvEntryForIab.iabActivated !== iabActivated) {
              await env.WEBFLOW_AUTHENTICATION.put(webflowSiteId, JSON.stringify({ ...mainKvEntryForIab, iabActivated }));
            }
          }
        } catch (iabFlagErr) {
          console.warn('[BannerCustomization] iabActivated flag update failed (non-fatal):', iabFlagErr?.message);
        }
      } catch (kvErr) {
        console.error('[BannerCustomization] Failed to sync Banner-Settings KV:', kvErr);
      }

      // PostHog: track banner customized + published (save from Webflow = publish)
      try {
        const orgRow = await db.prepare('SELECT organizationId FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
        const orgId = orgRow?.organizationId;
        if (orgId) {
          await capturePostHogEvent(env, orgId, 'banner_customized', { platform: 'webflow', site_id: siteId, wf_site_id: wfSiteId || null });
          await capturePostHogEvent(env, orgId, 'banner_published_staging', { platform: 'webflow', site_id: siteId, wf_site_id: wfSiteId || null });
          await identifyPostHogPerson(env, orgId, { platform: 'webflow', did_customize_banner: true, did_publish_banner: true, lifecycle_stage: 'published' });
        }
      } catch (_) {}

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

async function ensureScriptInjected(env, db, siteId, wfSiteId, kvEntry, siteRow, { skipPublish = false } = {}) {
  const TAG = '[BannerCustomization][ScriptInject]';
  const accessToken = kvEntry.accessToken;
  const cdnScriptId = siteRow?.cdnScriptId ?? null;
  const storedWebflowScriptId = siteRow?.webflowScriptId ?? null;

  if (!cdnScriptId) {
    console.warn(`${TAG} cdnScriptId missing for siteId=${siteId} — skipping`);
    return;
  }

  const scriptUrl = siteRow?.embedScriptUrl ||
    `https://manager.consentbit.com/consentbit/${cdnScriptId}/script.js`;

  const result = await injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, TAG, storedWebflowScriptId);

  if (result.success) {
    let userId = null;
    let ownerRow = null;
    try {
      ownerRow = await db.prepare(
        `SELECT om.userId, u.email, u.billingEmail FROM OrganizationMember om
         JOIN Site s ON s.organizationId = om.organizationId
         JOIN User u ON u.id = om.userId
         WHERE s.id = ?1 LIMIT 1`
      ).bind(siteId).first();
      userId = ownerRow?.userId ?? null;
    } catch (_) {}

    const updatedKv = {
      ...kvEntry,
      scriptSwapped: true,
      scriptSwappedAt: new Date().toISOString(),
      webappSiteId: siteId,
      webappScriptUrl: scriptUrl,
      cdnScriptId,
      isWebappMigrated: true,
      ...(userId ? { userId } : {}),
      ...(ownerRow?.email ? { email: ownerRow.email } : {}),
      ...(ownerRow?.billingEmail ? { billingEmail: ownerRow.billingEmail } : {}),
    };
    await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify(updatedKv));

    if (result.webflowScriptId && result.webflowScriptId !== storedWebflowScriptId) {
      await db.prepare('UPDATE Site SET webflowScriptId = ?1, updatedAt = ?2 WHERE id = ?3')
        .bind(result.webflowScriptId, new Date().toISOString(), siteId)
        .run()
        .catch(() => {});
    }

    // Publish the Webflow site so the injected script goes live immediately.
    // Skipped when called from webapp save (skipPublish=true) to avoid unintended publishes.
    if (!skipPublish) {
      try {
        const WEBFLOW_API = 'https://api.webflow.com/v2';
        const headers = {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'accept-version': '1.0.0',
        };
        let customDomains = [];
        try {
          const siteInfoRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}`, { headers });
          if (siteInfoRes.ok) {
            const siteInfo = await siteInfoRes.json();
            customDomains = (siteInfo.customDomains || []).map(d => d.url || d.name).filter(Boolean);
          }
        } catch (_) {}
        const publishRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/publish`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ publishToWebflowSubdomain: true, customDomains }),
        });
        if (!publishRes.ok) {
          const err = await publishRes.text();
          console.warn(`${TAG} Webflow publish failed status=${publishRes.status} body=${err}`);
        }
      } catch (publishErr) {
        console.warn(`${TAG} Webflow publish error (non-fatal):`, publishErr?.message || publishErr);
      }
    }
  }
}
