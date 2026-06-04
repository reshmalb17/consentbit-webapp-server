// src/handlers/webflowFreeRegister.js
// Internal endpoint called by cb-server on first publish without payment.
// Creates (or finds) a webapp account for the Webflow user and registers their
// site as a free plan with platform='webflow' so the CDN serves loaderWebflow.

import {
  getOrCreateOrganizationForUser,
  createSite,
  canonicalEmbedOrigin,
  buildEmbedScriptUrl,
  normalizeDomain,
  markSiteVerified,
  saveBannerCustomization,
} from '../services/db.js';
import { capturePostHogEvent, identifyPostHogPerson, identifyPostHogSite } from '../services/posthog.js';

const TAG = '[webflow-free-register][webapp]';

export async function handleWebflowFreeRegister(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    console.warn(`${TAG} Rejected: wrong method ${request.method}`);
    return new Response('Method Not Allowed', { status: 405 });
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  // Accepts either X-Admin-Key (internal cb-server calls) or open access (direct from Webflow app)
  const adminKey = request.headers.get('X-Admin-Key') || request.headers.get('X-Internal-Secret');
  const expectedKey = env.ADMIN_KEY || env.INTERNAL_SECRET;
  const isAdminCall = expectedKey && adminKey === expectedKey;

  if (!db) {
    console.error(`${TAG} CONSENT_WEBAPP D1 binding is missing`);
    return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    console.error(`${TAG} Failed to parse request body`);
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  const domain = (body.domain || '').trim();
  const wfSiteId = (body.wfSiteId || '').trim();
  const initialCustomization = body.initialCustomization ?? null;

  if (!email || !domain) {
    console.warn(`${TAG} Rejected: missing email or domain`);
    return Response.json({ success: false, error: 'email and domain are required' }, { status: 400 });
  }

  // ── Short-circuit if already registered ──────────────────────────────────
  if (wfSiteId) {
    const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(wfSiteId);
    if (kvRaw) {
      const kvEntry = JSON.parse(kvRaw);
      if (kvEntry.webappSiteId && kvEntry.webappScriptUrl) {
        // Verify the site still exists in D1 — KV can be stale after data deletion
        const siteExists = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(kvEntry.webappSiteId).first();
        if (siteExists) {
          return Response.json({
            success: true,
            alreadyRegistered: true,
            webappSiteId: kvEntry.webappSiteId,
            scriptUrl: kvEntry.webappScriptUrl,
            cdnScriptId: kvEntry.cdnScriptId,
          });
        }
        // Site was deleted — clear stale KV fields and fall through to re-register
        const cleanedKv = { ...kvEntry };
        delete cleanedKv.webappSiteId;
        delete cleanedKv.webappScriptUrl;
        delete cleanedKv.cdnScriptId;
        await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify(cleanedKv)).catch(() => {});
      }
    }
  }

  // ── Early site-limit check (read-only, no side-effects) ─────────────────
  // Run BEFORE creating any user/org record or injecting any scripts.
  // If the email already has a registered site on a different domain, reject now.
  {
    const earlyUser = await db.prepare('SELECT id FROM User WHERE email = ?1').bind(email).first();
    if (earlyUser) {
      const earlyOrg = await db.prepare(
        `SELECT o.id FROM Organization o
         LEFT JOIN OrganizationMember ou ON ou.organizationId = o.id
         WHERE ou.userId = ?1
         ORDER BY o.createdAt ASC LIMIT 1`
      ).bind(earlyUser.id).first();
      if (earlyOrg) {
        const earlySites = await db
          .prepare('SELECT id, domain, platformSiteId FROM Site WHERE organizationId = ?1 LIMIT 5')
          .bind(earlyOrg.id)
          .all();
        const earlySiteList = earlySites?.results || [];
        const earlyNormalizedDomain = normalizeDomain(domain);
        // Skip if this exact wfSiteId is already registered (idempotent re-publish)
        const isIdempotentRepublish = wfSiteId && earlySiteList.some(s => s.platformSiteId === wfSiteId);
        if (!isIdempotentRepublish) {
          const conflictSite = earlySiteList.find(s => s.domain && s.domain !== earlyNormalizedDomain);
          if (conflictSite) {
            console.warn(`${TAG} Early check: SITE_LIMIT_REACHED — email=${email} already has free site on domain=${conflictSite.domain}`);
            return Response.json(
              {
                success: false,
                code: 'SITE_LIMIT_REACHED',
                error: 'Your account already has a free site registered on a different domain.',
                existingDomain: conflictSite.domain,
              },
              { status: 403 }
            );
          }
        }
      }
    }
  }

  const now = new Date().toISOString();

  // ── Step 1: Find or create user by email ─────────────────────────────────
  let user = await db.prepare('SELECT * FROM User WHERE email = ?1').bind(email).first();

  if (!user) {
    const userId = crypto.randomUUID();
    const nameGuess = email.split('@')[0];
    try {
      await db
        .prepare(
          `INSERT INTO User (id, email, name, passwordHash, password_hash, createdAt, updatedAt)
           VALUES (?1, ?2, ?3, 'webflow:no-password', 'webflow:no-password', ?4, ?4)`
        )
        .bind(userId, email, nameGuess, now)
        .run();
    } catch {
      await db
        .prepare(
          `INSERT INTO User (id, email, name, passwordHash, createdAt, updatedAt)
           VALUES (?1, ?2, ?3, 'webflow:no-password', ?4, ?4)`
        )
        .bind(userId, email, nameGuess, now)
        .run();
    }
    user = await db.prepare('SELECT * FROM User WHERE id = ?1').bind(userId).first();
  }

  if (!user) {
    console.error(`${TAG} Step 1: FAILED — could not create user`);
    return Response.json({ success: false, error: 'Failed to create user account' }, { status: 500 });
  }

  // ── Step 2: Get or create organization ───────────────────────────────────
  const org = await getOrCreateOrganizationForUser(db, {
    userId: user.id,
    organizationName: `${email.split('@')[0]}'s Organization`,
  });
  if (!org?.id) {
    console.error(`${TAG} Step 2: FAILED — could not create organization`);
    return Response.json({ success: false, error: 'Failed to initialize organization' }, { status: 500 });
  }

  // ── Step 3: Check free plan site limit (1 site per account) ──────────────
  const existingSites = await db
    .prepare('SELECT id, domain, platformSiteId, cdnScriptId, embedScriptUrl, webflowScriptId FROM Site WHERE organizationId = ?1 LIMIT 5')
    .bind(org.id)
    .all();

  const normalizedDomain = normalizeDomain(domain);
  const siteList = existingSites?.results || [];

  // Idempotency: if any existing site already has this wfSiteId as platformSiteId, return success
  if (wfSiteId) {
    const platformMatch = siteList.find((s) => s.platformSiteId === wfSiteId);
    if (platformMatch) {
      console.log(`${TAG} Step 3: platformSiteId match — already registered, returning idempotent success for site=${platformMatch.id}`);
      const embedOriginForMatch = canonicalEmbedOrigin(request, env);
      const scriptUrlMatch =
        platformMatch.embedScriptUrl ||
        buildEmbedScriptUrl(embedOriginForMatch || new URL(request.url).origin, platformMatch.cdnScriptId) ||
        `${new URL(request.url).origin}/consentbit/${platformMatch.cdnScriptId}/script.js`;

      // Save current customization payload so this publish's settings are persisted
      if (initialCustomization?.customization) {
        try {
          await saveBannerCustomization(db, platformMatch.id, initialCustomization.customization);
        } catch (saveErr) {
          console.warn(`${TAG} Step 3: saveBannerCustomization failed (non-fatal):`, saveErr?.message || saveErr);
        }
      }

      // Stamp KV with webappSiteId + scriptUrl if missing so the short-circuit fires next time
      try {
        const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(wfSiteId);
        if (kvRaw) {
          const kvEntry = JSON.parse(kvRaw);
          if (!kvEntry.webappSiteId || !kvEntry.webappScriptUrl) {
            const updatedKv = {
              ...kvEntry,
              webappSiteId: platformMatch.id,
              webappScriptUrl: scriptUrlMatch,
              cdnScriptId: platformMatch.cdnScriptId,
              isWebappMigrated: true,
            };
            await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify(updatedKv));
          }
        }
      } catch (_) { /* best-effort */ }

      return Response.json({
        success: true,
        alreadyRegistered: true,
        webappSiteId: platformMatch.id,
        scriptUrl: scriptUrlMatch,
        cdnScriptId: platformMatch.cdnScriptId,
      });
    }
  }

  const existingOnDifferentDomain = siteList.find(
    (s) => s.domain && s.domain !== normalizedDomain
  );
  if (existingOnDifferentDomain) {
    console.warn(`${TAG} Step 3: SITE_LIMIT_REACHED — user already has free site on domain=${existingOnDifferentDomain.domain}`);
    return Response.json(
      {
        success: false,
        code: 'SITE_LIMIT_REACHED',
        error: 'Your account already has a free site registered on a different domain.',
        existingDomain: existingOnDifferentDomain.domain,
      },
      { status: 403 }
    );
  }

  // Check if the same domain already exists for this org (idempotent re-register)
  const existingSameDomain = siteList.find((s) => s.domain === normalizedDomain);

  // ── Step 4: Create or find site ──────────────────────────────────────────
  const embedOrigin = canonicalEmbedOrigin(request, env);

  let site;
  try {
    site = await createSite(db, {
      organizationId: org.id,
      name: normalizedDomain,
      domain,
      origin: embedOrigin || new URL(request.url).origin,
      bannerType: 'gdpr',
      regionMode: 'gdpr',
    });
  } catch (e) {
    if (e?.code === 'DOMAIN_EXISTS' || e?.status === 409) {
      site = await db.prepare('SELECT * FROM Site WHERE domain = ?1').bind(normalizedDomain).first();
      if (!site || String(site.organizationId) !== String(org.id)) {
        return Response.json(
          { success: false, code: 'DOMAIN_EXISTS', error: 'This domain is already registered to another account.' },
          { status: 409 }
        );
      }
    } else {
      console.error(`${TAG} Step 4: Unexpected error creating site:`, e?.message || e);
      throw e;
    }
  }

  if (!site) {
    console.error(`${TAG} Step 4: FAILED — site is null after create/lookup`);
    return Response.json({ success: false, error: 'Failed to create site' }, { status: 500 });
  }

  // ── Step 5: Set platform='webflow' so CDN serves loaderWebflow ───────────
  await db
    .prepare(`UPDATE Site SET platform = 'webflow', updatedAt = ?1 WHERE id = ?2`)
    .bind(now, site.id)
    .run();

  if (wfSiteId) {
    await db
      .prepare(`UPDATE Site SET platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3`)
      .bind(wfSiteId, now, site.id)
      .run();
  }

  // ── Step 5b: Save initial banner customization + sync to KV ─────────────
  if (initialCustomization?.customization) {
    try {
      const custData = initialCustomization.customization;

      // Save to D1
      await saveBannerCustomization(db, site.id, custData);

      // Sync to Banner-Settings:{wfSiteId} KV so the Webflow app reads it immediately
      if (wfSiteId && env.WEBFLOW_AUTHENTICATION) {
        try {
          const parseBorderRadius = (val) => {
            if (val == null) return null;
            const s = String(val).trim();
            const n = parseFloat(s);
            if (isNaN(n)) return 0;
            if (s.endsWith('rem') || (n < 10 && n % 1 !== 0)) return Math.round(n * 16);
            return Math.round(n) || 0;
          };

          let enTrans = {};
          let configTrans = {};
          try {
            const rawTrans = custData.translations;
            const parsed = typeof rawTrans === 'string' ? JSON.parse(rawTrans) : rawTrans;
            enTrans = parsed?.en ?? {};
            configTrans = parsed?.config ?? {};
          } catch (_) {}

          const appData = {
            color: custData.backgroundColor ?? '#ffffff',
            bgColor: custData.backgroundColor ?? '#ffffff',
            btnColor: custData.acceptButtonBg ?? '#0284c7',
            headColor: custData.headingColor ?? '#0f172a',
            paraColor: custData.textColor ?? '#334155',
            secondcolor: custData.rejectButtonBg ?? '#0284c7',
            secondbuttontext: custData.rejectButtonText ?? '#ffffff',
            primaryButtonText: custData.acceptButtonText ?? '#ffffff',
            customiseButtonBg: custData.customiseButtonBg ?? '#ffffff',
            customiseButtonText: custData.customiseButtonText ?? '#0284c7',
            saveButtonBg: custData.saveButtonBg ?? '#ffffff',
            saveButtonText: custData.saveButtonText ?? '#0284c7',
            borderRadius: parseBorderRadius(custData.bannerBorderRadius),
            selected: custData.position?.includes('right') ? 'right'
              : custData.position?.includes('center') ? 'center'
              : 'left',
            privacyUrl: custData.privacyPolicyUrl ?? '',
            animation: custData.centerAnimationDirection ?? 'fade',
            language: custData.language ?? 'en',
            closebutton: (() => { const v = configTrans.closeButtonEnabled ?? enTrans.closeButtonEnabled; return v != null ? (v === '1' || v === true) : false; })(),
            webappContent: {
              title: enTrans.title ?? 'We value your privacy',
              description: enTrans.description ?? '',
              acceptAll: enTrans.acceptAll ?? 'Accept',
              rejectAll: enTrans.rejectAll ?? 'Reject',
              customise: enTrans.customise ?? 'Preference',
              saveMyPreferences: enTrans.saveMyPreferences ?? 'Save my preferences',
            },
            contentEditedFromWebapp: true,
            isWebappMigrated: true,
          };

          const kvKey = `Banner-Settings:${wfSiteId}`;
          const dataToStore = { appData, siteId: wfSiteId, updatedAt: now };
          await env.WEBFLOW_AUTHENTICATION.put(kvKey, JSON.stringify(dataToStore));
        } catch (kvErr) {
          console.warn(`${TAG} Step 5b: Banner-Settings KV sync failed (non-fatal):`, kvErr?.message || kvErr);
        }
      }
    } catch (err) {
      console.warn(`${TAG} Step 5b: saveBannerCustomization failed (non-fatal):`, err?.message || err);
    }
  }

  // ── Step 6: Build CDN script URL ─────────────────────────────────────────
  const scriptUrl =
    site.embedScriptUrl ||
    buildEmbedScriptUrl(embedOrigin || new URL(request.url).origin, site.cdnScriptId) ||
    `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;

  // ── Step 7: Inject script into Webflow site head via Webflow REST API ────
  let injectedIntoHead = false;
  if (wfSiteId) {
    try {
      const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(wfSiteId);
      if (!kvRaw) {
        console.warn(`${TAG} Step 7: No KV entry found for wfSiteId=${wfSiteId} — skipping injection`);
      } else {
        const kvEntry = JSON.parse(kvRaw);
        const accessToken = kvEntry.accessToken;
        if (!accessToken) {
          console.warn(`${TAG} Step 7: No accessToken in KV — skipping injection`);
        } else {
          // Read stored Webflow script ID from D1 so we reuse it instead of creating a new registered script
          let storedWebflowScriptId = null;
          try {
            const siteRow = await db.prepare('SELECT webflowScriptId FROM Site WHERE id = ?1').bind(site.id).first();
            storedWebflowScriptId = siteRow?.webflowScriptId ?? null;
          } catch (_) {}

          const result = await injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, TAG, storedWebflowScriptId);
          injectedIntoHead = result.success;

          // Mark site as verified so scan doesn't block on published-HTML check
          if (result.success) {
            try { await markSiteVerified(db, site.id, scriptUrl); } catch { /* best-effort */ }
          }

          // Persist the Webflow registered script ID back to D1 for future reuse
          if (result.webflowScriptId && result.webflowScriptId !== storedWebflowScriptId) {
            await db.prepare('UPDATE Site SET webflowScriptId = ?1, updatedAt = ?2 WHERE id = ?3')
              .bind(result.webflowScriptId, new Date().toISOString(), site.id).run().catch(() => {});
          }

          // Update KV with webappSiteId + scriptUrl
          const updatedKv = { ...kvEntry, webappSiteId: site.id, webappScriptUrl: scriptUrl, cdnScriptId: site.cdnScriptId, userId: user.id, email: user.email, registeredThroughApp: true, isWebappMigrated: true };
          await env.WEBFLOW_AUTHENTICATION?.put(wfSiteId, JSON.stringify(updatedKv));

          // Publish the Webflow site so the injected script goes live immediately.
          if (result.success && accessToken) {
            try {
              const WEBFLOW_API = 'https://api.webflow.com/v2';
              const pubHeaders = {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'accept-version': '1.0.0',
              };
              let customDomains = [];
              try {
                const siteInfoRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}`, { headers: pubHeaders });
                if (siteInfoRes.ok) {
                  const siteInfo = await siteInfoRes.json();
                  customDomains = (siteInfo.customDomains || []).map(d => d.url || d.name).filter(Boolean);
                }
              } catch (_) {}
              const publishRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/publish`, {
                method: 'POST',
                headers: pubHeaders,
                body: JSON.stringify({ publishToWebflowSubdomain: true, customDomains }),
              });
              if (!publishRes.ok) {
                const err = await publishRes.text();
                console.warn(`${TAG} Step 7: Webflow publish failed status=${publishRes.status} body=${err}`);
              } else {
                console.log(`${TAG} Step 7: Webflow site published successfully wfSiteId=${wfSiteId}`);
              }
            } catch (publishErr) {
              console.warn(`${TAG} Step 7: Webflow publish error (non-fatal):`, publishErr?.message || publishErr);
            }
          }
        }
      }
    } catch (err) {
      console.error(`${TAG} Step 7: Script injection error:`, err?.message || err);
    }
  }

  // PostHog: use email as canonical distinct_id (matches client-side Webflow Designer app)
  const isNewInstall = !existingSameDomain;
  try {
    if (isNewInstall) {
      await capturePostHogEvent(env, user.email, 'app_installed', {
        platform: 'webflow',
        domain: site.domain,
        site_id: site.id,
        org_id: org.id,
        wf_site_id: wfSiteId || null,
        injected_into_head: injectedIntoHead,
        $groups: { site: site.id },
      });
    }
    await identifyPostHogPerson(env, user.email, {
      email: user.email,
      org_id: org.id,
      platform: 'webflow',
      subscription_status: 'none',
      plan_tier: 'free',
      lifecycle_stage: isNewInstall ? 'installed' : 'published',
      did_install_app: true,
      installed_at: isNewInstall ? now : undefined,
    });
    // Group: one row per site — tracks plan/status per site independently
    await identifyPostHogSite(env, user.email, site.id, {
      domain: site.domain,
      platform: 'webflow',
      wf_site_id: wfSiteId || null,
      owner_email: user.email,
      subscription_status: 'none',
      plan_tier: 'free',
      installed_at: now,
    });
  } catch (_) {}

  return Response.json({
    success: true,
    webappSiteId: site.id,
    cdnScriptId: site.cdnScriptId,
    scriptUrl,
    domain: site.domain,
    userId: user.id,
    organizationId: org.id,
    injectedIntoHead,
  });
}

// ── Webflow script injection via REST API ──────────────────────────────────

export async function injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, TAG, storedWebflowScriptId = null) {
  const WEBFLOW_API = 'https://api.webflow.com/v2';
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'accept-version': '1.0.0',
  };

  const inlineCode = `(function(){var h=document.head||document.getElementsByTagName("head")[0]||document.documentElement;var s=document.createElement("script");s.src=${JSON.stringify(scriptUrl)};s.type="text/javascript";s.setAttribute("consentbit","consentbit");s.setAttribute("data-site-id",${JSON.stringify(wfSiteId)});h.appendChild(s);})();`;

  // 1. Get existing applied scripts
  let existingScripts = [];
  let appliedConsentBitId = null;
  try {
    const existingRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/custom_code`, { headers });
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      const allScripts = existingData.scripts || [];
      const existing = allScripts.find(s => s.id?.toLowerCase().includes('consentbitbanner'));
      if (existing) appliedConsentBitId = existing.id;
      existingScripts = allScripts.filter(s => !s.id?.toLowerCase().includes('consentbitbanner'));
    }
  } catch { /* start fresh */ }

  // 2. Determine which script ID to use — prefer stored D1 scriptId, then applied one
  const candidateId = storedWebflowScriptId || appliedConsentBitId;

  // 3. If we have a stored/applied script ID, verify its URL is correct — if so, just re-apply it
  if (candidateId) {
    try {
      const scriptRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/registered_scripts/${candidateId}`, { headers });
      if (scriptRes.ok) {
        const scriptData = await scriptRes.json();
        if (scriptData.sourceCode?.includes(scriptUrl)) {
          // URL is correct — just ensure it's applied in the head
          const alreadyApplied = appliedConsentBitId === candidateId;
          if (!alreadyApplied) {
            existingScripts.push({ id: candidateId, location: 'header', version: '1.0.0' });
            await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/custom_code`, {
              method: 'PUT', headers, body: JSON.stringify({ scripts: existingScripts }),
            });
          }
          return { success: true, webflowScriptId: candidateId };
        }
      }
    } catch { /* proceed to register new */ }
  }

  // 4. Register new inline script
  const displayName = `ConsentBitBanner${Date.now()}`;
  const registerRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/registered_scripts/inline`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sourceCode: inlineCode, displayName, version: '1.0.0' }),
  });

  if (!registerRes.ok) {
    const err = await registerRes.text();
    console.error(`${TAG} Step 7: registerInline failed status=${registerRes.status} body=${err}`);
    return { success: false, webflowScriptId: null };
  }

  const registered = await registerRes.json();
  const scriptId = registered.id;
  if (!scriptId) {
    console.error(`${TAG} Step 7: No scriptId returned from registerInline`);
    return { success: false, webflowScriptId: null };
  }

  // 5. Apply to header (old ConsentBit scripts already filtered out)
  existingScripts.push({ id: scriptId, location: 'header', version: '1.0.0' });

  const upsertRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/custom_code`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ scripts: existingScripts }),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error(`${TAG} Step 7: upsertCustomCode failed status=${upsertRes.status} body=${err}`);
    return { success: false, webflowScriptId: scriptId };
  }

  return { success: true, webflowScriptId: scriptId };
}
