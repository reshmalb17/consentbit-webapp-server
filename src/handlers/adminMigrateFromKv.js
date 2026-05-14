// src/handlers/adminMigrateFromKv.js
import { checkAdminAuth } from '../utils/adminAuth.js';
// Migrates active sites from ACTIVE_SITES_CONSENTBIT (Webflow) and
// ACTIVE_SITES_CONSENTBIT_FRAMER (Framer) into CONSENT_WEBAPP D1.
// For each active site, looks up platform auth KV for site details,
// then upserts User → Organization → Site → Subscription.
// After migration writes new IDs back to both KV stores.

function normalizeDomain(raw) {
  return (raw || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function listAllKvKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const listed = await kv.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const k of listed.keys) keys.push(k.name);
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
  return keys;
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

async function upsertSite(db, { organizationId, domain, name, stagingUrl, customDomain, platformSiteId, platform, billingEmail, now }) {
  const existing = await db.prepare('SELECT id, cdnScriptId FROM Site WHERE domain = ?1').bind(domain).first();
  if (existing) {
    await db.prepare(
      `UPDATE Site SET platformSiteId=?1, platform=?2, stagingUrl=?3, customDomain=?4,
       isLegacy=1, legacySource=?5, billingEmail=?6, updatedAt=?7 WHERE id=?8`
    ).bind(platformSiteId || null, platform || null, stagingUrl || null, customDomain || null,
      platform || null, billingEmail || null, now, existing.id).run();
    return { siteId: existing.id, cdnScriptId: existing.cdnScriptId };
  }
  const id = crypto.randomUUID();
  const cdnScriptId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Site (id, organizationId, name, domain, cdnScriptId, apiKey,
      platformSiteId, platform, stagingUrl, customDomain, isLegacy, legacySource,
      billingEmail, createdAt, updatedAt)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?12,?13,?13)`
  ).bind(id, organizationId, name, domain, cdnScriptId, apiKey,
    platformSiteId || null, platform || null, stagingUrl || null, customDomain || null,
    platform || null, billingEmail || null, now).run();
  return { siteId: id, cdnScriptId };
}

async function upsertSubscription(db, { organizationId, siteId, subscriptionId, customerId, status, cancelAtPeriodEnd, interval, currentPeriodEnd, planId, now }) {
  const resolvedPlanId = ['basic', 'essential', 'growth'].includes(planId) ? planId : 'basic';
  // If subscriptionId exists, check for existing record first
  if (subscriptionId) {
    const existing = await db.prepare('SELECT id FROM Subscription WHERE stripeSubscriptionId = ?1').bind(subscriptionId).first();
    if (existing) {
      await db.prepare(
        `UPDATE Subscription SET status=?1, cancelAtPeriodEnd=?2, planId=?3, updatedAt=?4 WHERE id=?5`
      ).bind(status || 'active', cancelAtPeriodEnd ? 1 : 0, resolvedPlanId, now, existing.id).run();
      return;
    }
  } else {
    // No subscriptionId — check if a subscription already exists for this site
    const existing = await db.prepare('SELECT id FROM Subscription WHERE siteId = ?1 LIMIT 1').bind(siteId).first();
    if (existing) {
      await db.prepare(
        `UPDATE Subscription SET status=?1, cancelAtPeriodEnd=?2, planId=?3, updatedAt=?4 WHERE id=?5`
      ).bind(status || 'active', cancelAtPeriodEnd ? 1 : 0, resolvedPlanId, now, existing.id).run();
      return;
    }
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Subscription (id, organizationId, siteId, stripeSubscriptionId, stripeCustomerId,
      planType, planId, interval, status, cancelAtPeriodEnd, currentPeriodEnd, createdAt, updatedAt)
     VALUES (?1,?2,?3,?4,?5,'single',?6,?7,?8,?9,?10,?11,?11)`
  ).bind(id, organizationId, siteId, subscriptionId || null, customerId || null,
    resolvedPlanId, interval || 'monthly', status || 'active', cancelAtPeriodEnd ? 1 : 0,
    currentPeriodEnd || null, now).run();
}

async function migrateWebflow(env, db, dryRun, results, domainFilter = null) {
  const kv = env.ACTIVE_SITES_CONSENTBIT;
  const authKv = env.WEBFLOW_AUTHENTICATION;
  if (!kv) { results.push({ platform: 'webflow', status: 'skipped', reason: 'KV not configured' }); return; }

  const keys = await listAllKvKeys(kv);
  for (const key of keys) {
    try {
      const entry = await kv.get(key, { type: 'json' });
      if (!entry || !entry.active) continue;

      const domain = normalizeDomain(key);
      if (!domain) continue;
      if (domainFilter && domain !== normalizeDomain(domainFilter)) continue;

      const email = entry.email;
      if (!email) { results.push({ key, platform: 'webflow', status: 'skipped', reason: 'no email' }); continue; }

      // Look up Webflow site details
      let siteName = domain;
      let stagingUrl = null;
      let customDomain = null;
      let createdOn = null;

      if (authKv && entry.wfSiteId) {
        try {
          const raw = await authKv.get(entry.wfSiteId);
          if (raw) {
            const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
            siteName = wfData.siteName || domain;
            stagingUrl = wfData.stagingUrl || null;
            customDomain = wfData.customDomain || null;
            createdOn = wfData.createdOn || null;
          }
        } catch (_) {}
      }

      if (!dryRun) {
        const now = createdOn || nowIso();

        const userId = await upsertUser(db, email, nowIso());
        const orgId = await upsertOrganization(db, userId, siteName, nowIso());
        const { siteId, cdnScriptId } = await upsertSite(db, {
          organizationId: orgId,
          domain,
          name: siteName,
          stagingUrl,
          customDomain,
          platformSiteId: entry.wfSiteId || null,
          platform: 'webflow',
          billingEmail: email,
          now: nowIso(),
        });
        await upsertSubscription(db, {
          organizationId: orgId,
          siteId,
          subscriptionId: entry.subscriptionId,
          customerId: entry.customerId,
          status: entry.active ? 'active' : 'canceled',
          cancelAtPeriodEnd: entry.cancelAtPeriodEnd,
          interval: entry.interval || 'monthly',
          currentPeriodEnd: entry.currentPeriodEnd || entry.serviceExpiresAt || null,
          planId: entry.plan || 'basic',
          now: nowIso(),
        });

        // Write back to ACTIVE_SITES_CONSENTBIT — preserve existing plan, default to 'basic' only if unset
        const preservedPlan = ['basic', 'essential', 'growth'].includes(entry.plan) ? entry.plan : 'basic';
        const updatedActive = { ...entry, plan: preservedPlan, cdnScriptId, webappSiteId: siteId, orgId, userEmail: email };
        await kv.put(key, JSON.stringify(updatedActive));

        // Write back to WEBFLOW_AUTHENTICATION
        if (authKv && entry.wfSiteId) {
          try {
            const raw = await authKv.get(entry.wfSiteId);
            const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
            await authKv.put(entry.wfSiteId, JSON.stringify({
              ...existing,
              cdnScriptId,
              webappSiteId: siteId,
              organizationId: orgId,
              userId,
              userEmail: email,
              isLegacyUser: true,
              upgradedThroughApp: false,
            }));
          } catch (_) {}
        }
      }

      results.push({ key, platform: 'webflow', status: dryRun ? 'dry-run' : 'migrated', email, domain, wfSiteId: entry.wfSiteId || null });
    } catch (err) {
      results.push({ key, platform: 'webflow', status: 'error', reason: err?.message });
    }
  }
}

async function migrateFramer(env, db, dryRun, results, emailFilter = null) {
  const kv = env.ACTIVE_SITES_CONSENTBIT_FRAMER;
  const authKv = env.AUTH_STORE_FRAMER;
  if (!kv) { results.push({ platform: 'framer', status: 'skipped', reason: 'KV not configured' }); return; }

  const keys = await listAllKvKeys(kv);
  for (const key of keys) {
    try {
      const entry = await kv.get(key, { type: 'json' });
      if (!entry || !entry.active) continue;

      const domain = normalizeDomain(entry.site_domain || key);
      if (!domain) continue;

      const framerSiteId = entry.framerSiteId || null;

      // Look up Framer auth details
      let email = entry.email || null;
      let siteName = domain;
      let stagingUrl = null;

      if (authKv && framerSiteId) {
        try {
          const raw = await authKv.get(framerSiteId);
          if (raw) {
            const authData = typeof raw === 'string' ? JSON.parse(raw) : raw;
            email = email || authData?.userData?.email || null;
            stagingUrl = authData?.userData?.productionUrl || authData?.userData?.stagingUrl || null;
            siteName = authData?.userData?.name ? `${authData.userData.name}'s site` : domain;
          }
        } catch (_) {}
      }

      if (!email) { results.push({ key, platform: 'framer', status: 'skipped', reason: 'no email' }); continue; }
      if (emailFilter && email.toLowerCase() !== emailFilter.toLowerCase()) continue;

      if (!dryRun) {
        const userId = await upsertUser(db, email, nowIso());
        const orgId = await upsertOrganization(db, userId, siteName, nowIso());
        const siteId = await upsertSite(db, {
          organizationId: orgId,
          domain,
          name: siteName,
          stagingUrl,
          customDomain: null,
          platformSiteId: framerSiteId,
          platform: 'framer',
          billingEmail: email,
          now: nowIso(),
        });
        await upsertSubscription(db, {
          organizationId: orgId,
          siteId: siteId.siteId,
          subscriptionId: entry.subscription_id || entry.subscriptionId,
          customerId: entry.customer_id || entry.customerId,
          status: entry.active ? 'active' : 'canceled',
          cancelAtPeriodEnd: entry.cancelAtPeriodEnd,
          interval: 'monthly',
          currentPeriodEnd: null,
          planId: entry.plan || 'basic',
          now: nowIso(),
        });
      }

      results.push({ key, platform: 'framer', status: dryRun ? 'dry-run' : 'migrated', email, domain, framerSiteId });
    } catch (err) {
      results.push({ key, platform: 'framer', status: 'error', reason: err?.message });
    }
  }
}

export async function handleAdminMigrateFromKv(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const platformFilter = url.searchParams.get('platform'); // 'webflow' | 'framer' | null (both)
  const domainFilter = url.searchParams.get('domain') || null; // e.g. 'migration-b64514.webflow.io'
  const emailFilter = url.searchParams.get('email') || null;   // e.g. 'narendra@seattlenewmedia.com'

  const results = [];

  if (!platformFilter || platformFilter === 'webflow') {
    await migrateWebflow(env, db, dryRun, results, domainFilter);
  }
  if (!platformFilter || platformFilter === 'framer') {
    await migrateFramer(env, db, dryRun, results, emailFilter);
  }

  const migrated = results.filter(r => r.status === 'migrated' || r.status === 'dry-run').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;

  return Response.json({ success: true, dryRun, migrated, skipped, errors, results });
}
