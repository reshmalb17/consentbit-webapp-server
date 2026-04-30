// src/handlers/adminMigrateSingleSite.js
// Migrates one legacy Webflow site into CONSENT_WEBAPP D1.
// Reads from WEBFLOW_AUTHENTICATION KV (by wfSiteId) and ACTIVE_SITES_CONSENTBIT KV (by domain).
// After migration, writes cdnScriptId + webapp IDs back to both KVs.
function checkAuth(request, env) {
  const provided = request.headers.get('X-Admin-Key') || request.headers.get('X-Internal-Secret');
  const valid = [env.ADMIN_SECRET, env.LEGACY_API_SECRET].filter(Boolean);
  if (!valid.length || !provided || !valid.includes(provided)) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

function normalizeDomain(raw) {
  return (raw || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function upsertUser(db, email, now) {
  const existing = await db.prepare('SELECT id FROM User WHERE email = ?1').bind(email).first();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO User (id, email, password_hash, isLegacy, createdAt, updatedAt)
     VALUES (?1, ?2, 'legacy:no-password', 1, ?3, ?3)`
  ).bind(id, email, now).run();
  return id;
}

async function upsertOrganization(db, userId, name, now) {
  const existing = await db.prepare('SELECT id FROM Organization WHERE ownerUserId = ?1').bind(userId).first();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Organization (id, ownerUserId, name, createdAt, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?4)`
  ).bind(id, userId, name, now).run();
  return id;
}

async function upsertSite(db, { organizationId, domain, name, stagingUrl, customDomain, platformSiteId, platform, now }) {
  const existing = await db.prepare('SELECT id, cdnScriptId FROM Site WHERE domain = ?1').bind(domain).first();
  if (existing) {
    await db.prepare(
      `UPDATE Site SET platformSiteId=?1, platform=?2, stagingUrl=?3, customDomain=?4,
       isLegacy=1, legacySource=?5, updatedAt=?6 WHERE id=?7`
    ).bind(platformSiteId || null, platform || null, stagingUrl || null, customDomain || null, platform || null, now, existing.id).run();
    return { siteId: existing.id, cdnScriptId: existing.cdnScriptId };
  }
  const id = crypto.randomUUID();
  const cdnScriptId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Site (id, organizationId, name, domain, cdnScriptId, apiKey,
      platformSiteId, platform, stagingUrl, customDomain, isLegacy, legacySource, createdAt, updatedAt)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?12,?12)`
  ).bind(id, organizationId, name, domain, cdnScriptId, apiKey,
    platformSiteId || null, platform || null, stagingUrl || null, customDomain || null, platform || null, now).run();
  return { siteId: id, cdnScriptId };
}

async function upsertSubscription(db, { organizationId, siteId, subscriptionId, customerId, status, cancelAtPeriodEnd, interval, currentPeriodEnd, now }) {
  if (!subscriptionId) return;
  const existing = await db.prepare('SELECT id FROM Subscription WHERE stripeSubscriptionId = ?1').bind(subscriptionId).first();
  if (existing) {
    await db.prepare(
      `UPDATE Subscription SET status=?1, cancelAtPeriodEnd=?2, planId='basic', updatedAt=?3 WHERE id=?4`
    ).bind(status || 'active', cancelAtPeriodEnd ? 1 : 0, now, existing.id).run();
    return;
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Subscription (id, organizationId, siteId, stripeSubscriptionId, stripeCustomerId,
      planType, planId, interval, status, cancelAtPeriodEnd, currentPeriodEnd, createdAt, updatedAt)
     VALUES (?1,?2,?3,?4,?5,'single','basic',?6,?7,?8,?9,?10,?10)`
  ).bind(id, organizationId, siteId, subscriptionId, customerId || null,
    interval || 'monthly', status || 'active', cancelAtPeriodEnd ? 1 : 0,
    currentPeriodEnd || null, now).run();
}

async function upsertBannerCustomization(db, siteId, configJson, now) {
  const c = configJson.customization || {};
  const s = configJson.settings || {};
  const id = `banner-custom-${siteId}`;
  await db.prepare(`
    INSERT INTO BannerCustomization (
      id, siteId, position, backgroundColor, textColor, headingColor,
      acceptButtonBg, acceptButtonText, rejectButtonBg, rejectButtonText,
      customiseButtonBg, customiseButtonText, saveButtonBg, saveButtonText,
      backButtonBg, backButtonText, doNotSellButtonBg, doNotSellButtonText,
      privacyPolicyUrl, bannerBorderRadius, buttonBorderRadius,
      stopScroll, footerLink, animationEnabled, preferencePosition, centerAnimationDirection,
      language, autoDetectLanguage, translations, cookieExpirationDays,
      showBannerLogo, bannerLogoPosition, configJson, createdAt, updatedAt
    ) VALUES (
      ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
      ?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35
    )
    ON CONFLICT(siteId) DO UPDATE SET
      configJson = ?33,
      backgroundColor = ?4, textColor = ?5, headingColor = ?6,
      acceptButtonBg = ?7, acceptButtonText = ?8,
      rejectButtonBg = ?9, rejectButtonText = ?10,
      privacyPolicyUrl = ?19,
      bannerBorderRadius = ?20, buttonBorderRadius = ?21,
      language = ?27, cookieExpirationDays = ?30,
      updatedAt = ?35
  `)
  .bind(
    id, siteId,
    c.bannerAlignment || 'bottom-left',
    c.colors?.bannerBg || '#ffffff',
    c.colors?.body || '#334155',
    c.colors?.title || '#0f172a',
    c.colors?.btnPrimaryBg || '#0284c7',
    c.colors?.btnPrimaryText || '#ffffff',
    c.colors?.btnSecondaryBg || '#ffffff',
    c.colors?.btnSecondaryText || '#334155',
    '#ffffff', '#334155', '#ffffff', '#334155',
    '#ffffff', '#334155', '#ffffff', '#334155',
    s.privacyUrl || null,
    String(c.radius?.container ?? '0.375rem'),
    String(c.radius?.button ?? '0.375rem'),
    0, 0, 1,
    'center', 'fade',
    s.language || 'en', 0, null,
    s.expires || 30,
    1, 'left',
    JSON.stringify(configJson),
    now, now
  )
  .run();
}

export async function handleAdminMigrateSingleSite(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // --- action: updatePlan — update plan in KV + D1 without full migration ---
  if (body.action === 'updatePlan') {
    const domain = body.domain ? normalizeDomain(body.domain) : null;
    const plan = body.plan;
    if (!domain) return Response.json({ success: false, error: 'Provide domain' }, { status: 400 });
    if (!['basic', 'essential', 'growth'].includes(plan)) {
      return Response.json({ success: false, error: 'plan must be basic, essential, or growth' }, { status: 400 });
    }

    const activeKv = env.ACTIVE_SITES_CONSENTBIT;
    if (!activeKv) return Response.json({ success: false, error: 'ACTIVE_SITES_CONSENTBIT not configured' }, { status: 503 });

    const existing = await activeKv.get(domain, { type: 'json' });
    if (!existing) return Response.json({ success: false, error: `No KV entry found for domain="${domain}"` }, { status: 404 });

    const updated = { ...existing, plan };
    await activeKv.put(domain, JSON.stringify(updated));

    // Also update D1 Subscription if siteId is known
    let d1Updated = false;
    const siteRow = await db.prepare('SELECT id FROM Site WHERE domain = ?1').bind(domain).first();
    if (siteRow) {
      await db.prepare(`UPDATE Subscription SET planId=?1, updatedAt=?2 WHERE siteId=?3`)
        .bind(plan, new Date().toISOString(), siteRow.id).run();
      d1Updated = true;
    }

    return Response.json({ success: true, domain, plan, kvUpdated: true, d1Updated });
  }

  // Accept either domain or wfSiteId as lookup key, or rawEntry to skip KV lookup
  const inputDomain = body.domain ? normalizeDomain(body.domain) : null;
  const inputWfSiteId = body.wfSiteId || null;
  const dryRun = body.dryRun === true;

  if (!inputDomain && !inputWfSiteId && !body.rawEntry) {
    return Response.json({ success: false, error: 'Provide domain, wfSiteId, or rawEntry' }, { status: 400 });
  }

  const activeKv = env.ACTIVE_SITES_CONSENTBIT;
  const authKv = env.WEBFLOW_AUTHENTICATION;

  if (!activeKv) return Response.json({ success: false, error: 'ACTIVE_SITES_CONSENTBIT KV not configured' }, { status: 503 });

  const logs = [];
  const log = (msg) => { console.log(`[migrate-single-site] ${msg}`); logs.push(msg); };

  // --- 1. Resolve KV entry ---
  let domain = inputDomain;
  let activeEntry = null;

  // Option A: caller passes raw KV data directly (bypass KV lookup)
  if (body.rawEntry) {
    activeEntry = body.rawEntry;
    if (!domain) domain = normalizeDomain(activeEntry.domain || activeEntry.siteDomain || '');
    log(`Using rawEntry — domain resolved to "${domain}"`);
  }

  // Option B: lookup by domain in ACTIVE_SITES_CONSENTBIT
  if (!activeEntry && domain) {
    log(`Looking up ACTIVE_SITES_CONSENTBIT key "${domain}"...`);
    activeEntry = await activeKv.get(domain, { type: 'json' });
    log(activeEntry ? `Found KV entry for "${domain}"` : `No KV entry for "${domain}"`);
  }

  // Option C: look up by wfSiteId via WEBFLOW_AUTHENTICATION to find domain
  if (!activeEntry && inputWfSiteId && authKv) {
    log(`Looking up WEBFLOW_AUTHENTICATION key "${inputWfSiteId}" to resolve domain...`);
    try {
      const raw = await authKv.get(inputWfSiteId);
      if (raw) {
        const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const candidateDomain = normalizeDomain(wfData.customDomain || wfData.stagingUrl || '');
        log(`WEBFLOW_AUTHENTICATION resolved candidate domain "${candidateDomain}"`);
        if (candidateDomain) {
          activeEntry = await activeKv.get(candidateDomain, { type: 'json' });
          if (activeEntry) { domain = candidateDomain; log(`Found KV entry via wfSiteId → domain "${domain}"`); }
          else log(`No KV entry for candidate domain "${candidateDomain}"`);
        }
      } else {
        log(`No WEBFLOW_AUTHENTICATION entry for wfSiteId="${inputWfSiteId}"`);
      }
    } catch (e) { log(`WEBFLOW_AUTHENTICATION lookup error: ${e?.message}`); }
  }

  if (!activeEntry) {
    log(`FAILED: no active KV entry found`);
    return Response.json({ success: false, error: `No KV entry found for domain="${inputDomain}" or wfSiteId="${inputWfSiteId}". Try passing rawEntry directly.`, logs }, { status: 404 });
  }

  const email = activeEntry.email;
  if (!email) {
    log(`FAILED: KV entry has no email field`);
    return Response.json({ success: false, error: 'KV entry has no email field', logs }, { status: 422 });
  }
  log(`email="${email}"`);

  // --- 2. Resolve Webflow auth details ---
  const wfSiteId = inputWfSiteId || activeEntry.wfSiteId || null;
  let siteName = domain;
  let stagingUrl = null;
  let customDomain = null;
  let configJson = null;

  if (authKv && wfSiteId) {
    log(`Looking up WEBFLOW_AUTHENTICATION for siteName/config (wfSiteId="${wfSiteId}")...`);
    try {
      const raw = await authKv.get(wfSiteId);
      if (raw) {
        const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
        siteName = wfData.siteName || domain;
        stagingUrl = wfData.stagingUrl || null;
        customDomain = wfData.customDomain || null;
        configJson = wfData.config || wfData.configJson || null;
        log(`Auth KV found — siteName="${siteName}", stagingUrl="${stagingUrl}", hasConfig=${!!configJson}`);
      } else {
        log(`No WEBFLOW_AUTHENTICATION entry for wfSiteId="${wfSiteId}" — using domain as siteName`);
      }
    } catch (e) { log(`Auth KV lookup error: ${e?.message}`); }
  }

  // --- 3. Dry run — return what would be migrated ---
  if (dryRun) {
    log('Dry run complete');
    return Response.json({
      success: true,
      dryRun: true,
      logs,
      preview: {
        email,
        domain,
        wfSiteId,
        siteName,
        stagingUrl,
        customDomain,
        subscriptionId: activeEntry.subscriptionId || null,
        plan: activeEntry.plan || null,
        hasConfigJson: !!configJson,
      }
    });
  }

  // --- 4. Migrate ---
  const now = nowIso();

  log(`Upserting User email="${email}"...`);
  const userId = await upsertUser(db, email, now);
  log(`userId="${userId}"`);

  log(`Upserting Organization for userId="${userId}"...`);
  const orgId = await upsertOrganization(db, userId, siteName, now);
  log(`orgId="${orgId}"`);

  log(`Upserting Site domain="${domain}" platform="webflow"...`);
  const { siteId, cdnScriptId } = await upsertSite(db, {
    organizationId: orgId,
    domain,
    name: siteName,
    stagingUrl,
    customDomain,
    platformSiteId: wfSiteId,
    platform: 'webflow',
    now,
  });
  log(`siteId="${siteId}" cdnScriptId="${cdnScriptId}"`);

  const siteRow = await db.prepare('SELECT cdnScriptId, apiKey FROM Site WHERE id = ?1').bind(siteId).first();
  const licenseKey = siteRow?.apiKey || null;

  log(`Upserting Subscription subscriptionId="${activeEntry.subscriptionId || 'none'}"...`);
  await upsertSubscription(db, {
    organizationId: orgId,
    siteId,
    subscriptionId: activeEntry.subscriptionId || null,
    customerId: activeEntry.customerId || null,
    status: activeEntry.active ? 'active' : 'canceled',
    cancelAtPeriodEnd: activeEntry.cancelAtPeriodEnd || false,
    interval: activeEntry.interval || 'monthly',
    currentPeriodEnd: activeEntry.currentPeriodEnd || activeEntry.serviceExpiresAt || null,
    now,
  });
  log('Subscription upserted');

  if (configJson) {
    log('Upserting BannerCustomization...');
    await upsertBannerCustomization(db, siteId, configJson, now);
    log('BannerCustomization upserted');
  } else {
    log('No configJson — BannerCustomization skipped');
  }

  // --- 5. Write new webapp IDs back to KVs ---
  const newIds = { cdnScriptId, webappSiteId: siteId, orgId, licenseKey };

  log(`Updating ACTIVE_SITES_CONSENTBIT key "${domain}" with new IDs...`);
  const updatedActive = { ...activeEntry, ...newIds, plan: 'basic' };
  await activeKv.put(domain, JSON.stringify(updatedActive));
  log('ACTIVE_SITES_CONSENTBIT updated');

  if (authKv && wfSiteId) {
    log(`Updating WEBFLOW_AUTHENTICATION key "${wfSiteId}" with new IDs...`);
    try {
      const raw = await authKv.get(wfSiteId);
      const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      await authKv.put(wfSiteId, JSON.stringify({ ...existing, ...newIds }));
      log('WEBFLOW_AUTHENTICATION updated');
    } catch (e) { log(`WEBFLOW_AUTHENTICATION update error: ${e?.message}`); }
  }

  log('Migration complete');
  return Response.json({
    success: true,
    logs,
    migrated: { email, domain, wfSiteId, siteId, orgId, cdnScriptId, licenseKey },
  });
}
