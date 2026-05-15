// Migrates all data from consentbit-licenses (env.LEGACY_DB) → consent-webapp (env.CONSENT_WEBAPP)
//
// POST /api/admin/migrate-from-dashboard?offset=0&limit=50&dryRun=false
// Header: X-Admin-Key: <ADMIN_SECRET>
//
// Run with dryRun=true first to review conflicts before writing anything.
// Paginate: call repeatedly with offset=0, 50, 100... until licenses_in_batch = 0.

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normDomain(raw) {
  return (raw || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
}

function normEmail(raw) {
  return (raw || '').toLowerCase().trim();
}

function unixToIso(ts) {
  if (!ts) return null;
  const n = typeof ts === 'string' ? parseInt(ts, 10) : ts;
  if (!n || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function mapInterval(billingPeriod) {
  if (!billingPeriod) return null;
  const b = String(billingPeriod).toLowerCase();
  if (b === 'yearly' || b === 'year' || b === 'annual') return 'yearly';
  if (b === 'monthly' || b === 'month') return 'monthly';
  return null;
}

function mapSubStatus(s) {
  if (!s) return null;
  if (['active', 'trialing', 'past_due', 'unpaid'].includes(s)) return s;
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  return null;
}

function mapLicenseStatus(s) {
  if (!s || s === 'active') return 'active';
  if (s === 'cancelled' || s === 'inactive' || s === 'canceled') return 'canceled';
  return 'active';
}

function inferPlanId(priceId, env) {
  if (!priceId || !env) return null;
  const p = String(priceId).trim();
  const checks = [
    ['growth',    [env.STRIPE_PRICE_GROWTH_MONTHLY,    env.STRIPE_PRICE_GROWTH_YEARLY]],
    ['essential', [env.STRIPE_PRICE_ESSENTIAL_MONTHLY, env.STRIPE_PRICE_ESSENTIAL_YEARLY]],
    ['basic',     [env.STRIPE_PRICE_BASIC_MONTHLY,     env.STRIPE_PRICE_BASIC_YEARLY,
                   env.STRIPE_PRICE_MONTHLY,           env.STRIPE_PRICE_YEARLY]],
  ];
  for (const [plan, ids] of checks) {
    if (ids.some(id => id && String(id).trim() === p)) return plan;
  }
  return null;
}

function inferIntervalFromPriceId(priceId, env) {
  if (!priceId || !env) return null;
  const p = String(priceId).trim();
  const yearly = [
    env.STRIPE_PRICE_GROWTH_YEARLY, env.STRIPE_PRICE_ESSENTIAL_YEARLY,
    env.STRIPE_PRICE_BASIC_YEARLY,  env.STRIPE_PRICE_YEARLY,
  ].filter(Boolean).map(s => String(s).trim());
  if (yearly.includes(p)) return 'yearly';
  const monthly = [
    env.STRIPE_PRICE_GROWTH_MONTHLY, env.STRIPE_PRICE_ESSENTIAL_MONTHLY,
    env.STRIPE_PRICE_BASIC_MONTHLY,  env.STRIPE_PRICE_MONTHLY,
  ].filter(Boolean).map(s => String(s).trim());
  if (monthly.includes(p)) return 'monthly';
  return null;
}

// ─── Platform resolution (HTML fetch + KV) ───────────────────────────────────

async function resolveWfSiteId(domain) {
  if (!domain) return null;
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/data-wf-site="([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function resolveFramerSiteId(domain) {
  if (!domain) return null;
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/data-fid="([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Try KV with both bare domain and https:// prefix
async function kvGetByDomain(kv, domain) {
  if (!kv || !domain) return null;
  let v = await kv.get(domain, { type: 'json' }).catch(() => null);
  if (!v) {
    const prefixed = domain.startsWith('http') ? domain : `https://${domain}`;
    v = await kv.get(prefixed, { type: 'json' }).catch(() => null);
  }
  return v;
}

// Identifies platform + platformSiteId + cdnScriptId for a normalized domain.
// platformCache: Map<domain, result> — pass in to avoid repeat fetches within one run.
async function identifyPlatform(domain, srcSite, srcLic, env, platformCache) {
  if (!domain) return { platform: null, platformSiteId: null, cdnScriptId: null, wfKvEntry: null };
  if (platformCache.has(domain)) return platformCache.get(domain);

  const result = { platform: null, platformSiteId: null, cdnScriptId: null, wfKvEntry: null };

  // 1. From DB field
  const dbPlatform = ((srcSite?.platform || srcLic?.platform) || '').toLowerCase();
  if (dbPlatform === 'webflow' || dbPlatform === 'framer') result.platform = dbPlatform;

  // 2. Domain pattern
  if (!result.platform && domain.endsWith('.webflow.io')) result.platform = 'webflow';

  // 3. ACTIVE_SITES_CONSENTBIT KV
  if (env.ACTIVE_SITES_CONSENTBIT && (!result.platform || result.platform === 'webflow')) {
    const kv = await kvGetByDomain(env.ACTIVE_SITES_CONSENTBIT, domain);
    if (kv) {
      if (!result.platform) result.platform = 'webflow';
      if (kv.wfSiteId) result.platformSiteId = kv.wfSiteId;
    }
  }

  // 4. ACTIVE_SITES_CONSENTBIT_FRAMER KV
  if (!result.platform && env.ACTIVE_SITES_CONSENTBIT_FRAMER) {
    const kv = await kvGetByDomain(env.ACTIVE_SITES_CONSENTBIT_FRAMER, domain);
    if (kv) {
      result.platform = 'framer';
      result.platformSiteId = kv.framerId || kv.platformSiteId || kv.framerSiteId || null;
    }
  }

  // 5. HTML fetch → Webflow (only if platform is webflow or still unknown)
  if (!result.platformSiteId && result.platform !== 'framer') {
    const wfId = await resolveWfSiteId(domain);
    if (wfId) {
      result.platform = 'webflow';
      result.platformSiteId = wfId;
    }
  }

  // 6. HTML fetch → Framer (only if still totally unknown)
  if (!result.platform) {
    const framerId = await resolveFramerSiteId(domain);
    if (framerId) {
      result.platform = 'framer';
      result.platformSiteId = framerId;
    }
  }

  // 7. For Webflow: look up WEBFLOW_AUTHENTICATION for cdnScriptId + existing entry
  //    For Framer: never write to WEBFLOW_AUTHENTICATION
  if (result.platform === 'webflow' && result.platformSiteId && env.WEBFLOW_AUTHENTICATION) {
    const wfEntry = await env.WEBFLOW_AUTHENTICATION.get(result.platformSiteId, { type: 'json' }).catch(() => null);
    if (wfEntry) {
      result.wfKvEntry = wfEntry;
      if (wfEntry.cdnScriptId) result.cdnScriptId = wfEntry.cdnScriptId;
    }
  }

  platformCache.set(domain, result);
  return result;
}

// ─── CONSENT_WEBAPP upsert helpers ───────────────────────────────────────────

// orgCache: Map<email, { userId, orgId }> — avoids re-querying same user per batch
async function resolveUserOrg(dst, email, now, summary, dryRun, orgCache) {
  const e = normEmail(email);
  if (!e || !e.includes('@')) return null;
  if (orgCache.has(e)) return orgCache.get(e);

  let user = await dst.prepare('SELECT id, isLegacy FROM User WHERE email = ?1').bind(e).first();
  let userId;

  if (!user) {
    userId = crypto.randomUUID();
    if (!dryRun) {
      try {
        await dst.prepare(
          `INSERT INTO User (id,email,name,passwordHash,password_hash,isLegacy,createdAt,updatedAt)
           VALUES (?1,?2,?3,'legacy:no-password','legacy:no-password',1,?4,?4)`
        ).bind(userId, e, e.split('@')[0], now).run();
      } catch {
        await dst.prepare(
          `INSERT INTO User (id,email,name,passwordHash,isLegacy,createdAt,updatedAt)
           VALUES (?1,?2,?3,'legacy:no-password',1,?4,?4)`
        ).bind(userId, e, e.split('@')[0], now).run();
      }
    }
    summary.users_created++;
  } else {
    userId = user.id;
    const isLegacy = user.isLegacy ?? user.islegacy;
    if (!dryRun && !isLegacy) {
      await dst.prepare(`UPDATE User SET isLegacy=1, updatedAt=?1 WHERE id=?2`)
        .bind(now, userId).run().catch(() => {});
    }
    summary.users_updated++;
  }

  let org = await dst.prepare('SELECT id FROM Organization WHERE ownerUserId = ?1').bind(userId).first();
  let orgId;

  if (!org) {
    orgId = crypto.randomUUID();
    if (!dryRun) {
      await dst.prepare(
        `INSERT INTO Organization (id,ownerUserId,name,createdAt,updatedAt) VALUES (?1,?2,?3,?4,?4)`
      ).bind(orgId, userId, e.split('@')[0], now).run();
      await dst.prepare(
        `INSERT OR IGNORE INTO OrganizationMember (organizationId,userId,role,joinedAt) VALUES (?1,?2,'owner',?3)`
      ).bind(orgId, userId, now).run();
    }
    summary.orgs_created++;
  } else {
    orgId = org.id;
    if (!dryRun) {
      await dst.prepare(
        `INSERT OR IGNORE INTO OrganizationMember (organizationId,userId,role,joinedAt) VALUES (?1,?2,'owner',?3)`
      ).bind(orgId, userId, now).run().catch(() => {});
    }
  }

  const r = { userId, orgId };
  orgCache.set(e, r);
  return r;
}

async function resolveSite(dst, orgId, domain, platform, platformSiteId, cdnScriptId, billingEmail, now, summary, dryRun) {
  const d = normDomain(domain);
  if (!d) return null;

  const existing = await dst.prepare('SELECT id, organizationId FROM Site WHERE domain = ?1').bind(d).first();

  if (existing) {
    const existingOrg = existing.organizationId ?? existing.organizationid;
    if (existingOrg && existingOrg !== orgId) {
      summary.sites_skipped_domain_conflict.push({ domain: d, existingOrgId: existingOrg, migratingOrgId: orgId });
      return { siteId: existing.id, conflict: true };
    }
    if (!dryRun) {
      await dst.prepare(`
        UPDATE Site SET
          organizationId  = COALESCE(organizationId, ?1),
          platform        = COALESCE(platform, ?2),
          platformSiteId  = COALESCE(platformSiteId, ?3),
          cdnScriptId     = COALESCE(cdnScriptId, ?4),
          billingEmail    = COALESCE(billingEmail, ?5),
          legacySource    = COALESCE(legacySource, 'dashboard'),
          isLegacy        = 1,
          updatedAt       = ?6
        WHERE id = ?7
      `).bind(orgId, platform || null, platformSiteId || null, cdnScriptId || null, billingEmail || null, now, existing.id)
        .run().catch(e => summary.errors.push(`Site UPDATE ${d}: ${e.message}`));
    }
    summary.sites_updated++;
    return { siteId: existing.id, conflict: false };
  }

  // New site — generate placeholder cdnScriptId + apiKey (columns are NOT NULL in schema)
  const siteId = crypto.randomUUID();
  const genCdnScriptId = cdnScriptId || `cdn_legacy_${crypto.randomUUID().replace(/-/g, '')}`;
  const genApiKey = `api_legacy_${crypto.randomUUID().replace(/-/g, '')}`;

  if (!dryRun) {
    try {
      await dst.prepare(`
        INSERT INTO Site (id,organizationId,name,domain,cdnScriptId,apiKey,platform,platformSiteId,legacySource,billingEmail,isLegacy,createdAt,updatedAt)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'dashboard',?9,1,?10,?10)
      `).bind(siteId, orgId, d, d, genCdnScriptId, genApiKey, platform || null, platformSiteId || null, billingEmail || null, now).run();
    } catch {
      await dst.prepare(`
        INSERT INTO Site (id,organizationId,name,domain,cdnScriptId,platform,platformSiteId,legacySource,billingEmail,isLegacy,createdAt,updatedAt)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'dashboard',?8,1,?9,?9)
      `).bind(siteId, orgId, d, d, genCdnScriptId, platform || null, platformSiteId || null, billingEmail || null, now)
        .run().catch(e => summary.errors.push(`Site INSERT ${d}: ${e.message}`));
    }
  }
  summary.sites_created++;
  return { siteId, conflict: false };
}

async function upsertSubscription(dst, data, now, summary, dryRun) {
  const {
    orgId, siteId, stripeSubscriptionId, stripeCustomerId, stripePriceId,
    stripeItemId, planType, planId, interval, status, currentPeriodStart,
    currentPeriodEnd, cancelAtPeriodEnd, canceledAt, licenseKey, amountCents,
    migratedSubId,
  } = data;

  // Lookup: by stripeSubscriptionId first, then migratedSubId
  let existing = stripeSubscriptionId
    ? await dst.prepare('SELECT id, licenseKey, migratedSubId FROM Subscription WHERE stripeSubscriptionId = ?1')
        .bind(stripeSubscriptionId).first()
    : null;

  if (!existing && migratedSubId) {
    existing = await dst.prepare('SELECT id, licenseKey, migratedSubId FROM Subscription WHERE migratedSubId = ?1')
      .bind(migratedSubId).first().catch(() => null);
  }

  if (existing) {
    const existingMigratedSubId = existing.migratedSubId ?? existing.migratedsubid;
    if (existingMigratedSubId && migratedSubId && existingMigratedSubId !== migratedSubId) {
      summary.subscriptions_skipped_conflict.push({
        reason: 'migratedSubId_mismatch',
        existing: existingMigratedSubId,
        incoming: migratedSubId,
        cwSubId: existing.id,
      });
      return { subId: existing.id, conflict: true };
    }

    const existingLicenseKey = existing.licenseKey ?? existing.licensekey;
    if (!dryRun) {
      await dst.prepare(`
        UPDATE Subscription SET
          siteId             = COALESCE(siteId, ?1),
          stripeCustomerId   = COALESCE(stripeCustomerId, ?2),
          stripePriceId      = COALESCE(stripePriceId, ?3),
          stripeItemId       = COALESCE(stripeItemId, ?4),
          planType           = COALESCE(planType, ?5),
          planId             = COALESCE(planId, ?6),
          interval           = CASE WHEN interval = 'monthly' AND ?7 = 'yearly' THEN 'yearly' ELSE interval END,
          status             = COALESCE(status, ?8),
          currentPeriodStart = COALESCE(currentPeriodStart, ?9),
          currentPeriodEnd   = COALESCE(currentPeriodEnd, ?10),
          cancelAtPeriodEnd  = COALESCE(cancelAtPeriodEnd, ?11),
          canceledAt         = COALESCE(canceledAt, ?12),
          licenseKey         = COALESCE(licenseKey, ?13),
          amountCents        = COALESCE(amountCents, ?14),
          migratedSubId      = COALESCE(migratedSubId, ?15),
          updatedAt          = ?16
        WHERE id = ?17
      `).bind(
        siteId || null, stripeCustomerId || null, stripePriceId || null,
        stripeItemId || null, planType || null, planId || null,
        interval || null, status || null, currentPeriodStart || null,
        currentPeriodEnd || null, cancelAtPeriodEnd ?? null, canceledAt || null,
        licenseKey || null, amountCents || null, migratedSubId || null,
        now, existing.id
      ).run().catch(e => summary.errors.push(`Subscription UPDATE ${existing.id}: ${e.message}`));

      if (!existingLicenseKey && licenseKey) summary.license_keys_set++;
      else if (existingLicenseKey && licenseKey && existingLicenseKey !== licenseKey) summary.license_keys_skipped_already_set++;
    }
    summary.subscriptions_patched++;
    return { subId: existing.id, conflict: false };
  }

  // INSERT
  const subId = crypto.randomUUID();
  if (!dryRun) {
    await dst.prepare(`
      INSERT INTO Subscription (
        id, organizationId, siteId, stripeSubscriptionId, stripeCustomerId,
        stripePriceId, stripeItemId, planType, planId, interval, status,
        currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, canceledAt,
        licenseKey, amountCents, migratedSubId, createdAt, updatedAt
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19)
    `).bind(
      subId, orgId, siteId || null, stripeSubscriptionId || null, stripeCustomerId || null,
      stripePriceId || null, stripeItemId || null, planType || 'single', planId || null,
      interval || 'monthly', status || 'active', currentPeriodStart || null,
      currentPeriodEnd || null, cancelAtPeriodEnd ?? 0, canceledAt || null,
      licenseKey || null, amountCents || null, migratedSubId || null, now
    ).run().catch(e => summary.errors.push(`Subscription INSERT: ${e.message}`));

    if (licenseKey) summary.license_keys_set++;
  }
  summary.subscriptions_created++;
  return { subId, conflict: false };
}

async function upsertLicenseActivation(dst, licenseKey, siteId, orgId, subId, now, summary, dryRun) {
  if (!licenseKey || !siteId || !orgId) return;
  if (!dryRun) {
    await dst.prepare(`
      INSERT INTO LicenseActivation (licenseKey, siteId, organizationId, subscriptionId, createdAt)
      VALUES (?1,?2,?3,?4,?5)
      ON CONFLICT(licenseKey) DO UPDATE SET siteId=?2, organizationId=?3, subscriptionId=?4
    `).bind(licenseKey, siteId, orgId, subId || null, now)
      .run().catch(e => summary.errors.push(`LicenseActivation ${licenseKey}: ${e.message}`));
  }
  summary.activations_created++;
}

// Updates WEBFLOW_AUTHENTICATION KV — Webflow only, never for Framer
async function updateWebflowKV(env, wfSiteId, cwSiteId, resolvedPlanId, wfKvEntry, now, summary, dryRun) {
  if (!wfSiteId || !env.WEBFLOW_AUTHENTICATION) return;

  const existing = wfKvEntry ||
    await env.WEBFLOW_AUTHENTICATION.get(wfSiteId, { type: 'json' }).catch(() => null) ||
    {};

  const existingWebappSiteId = existing.webappSiteId;

  if (existingWebappSiteId && existingWebappSiteId !== cwSiteId) {
    summary.kv_conflicts.push({ wfSiteId, existingWebappSiteId, incomingCwSiteId: cwSiteId });
    return;
  }
  if (existingWebappSiteId === cwSiteId && existing.isWebappMigrated) {
    summary.kv_already_done++;
    return;
  }

  // Keep existing plan if set; otherwise use resolved or default 'basic'
  const planToWrite = existing.plan || resolvedPlanId || 'basic';

  if (!dryRun) {
    await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify({
      ...existing,
      webappSiteId: cwSiteId,
      plan: planToWrite,
      isWebappMigrated: true,
      migratedAt: now,
    })).catch(e => summary.errors.push(`WEBFLOW_AUTH KV ${wfSiteId}: ${e.message}`));
  }
  summary.kv_updated++;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleAdminMigrateFromDashboard(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'POST required' }, { status: 405 });
  }

  // Admin auth — uses same X-Admin-Key header as all other admin endpoints
  const adminSecret = env.ADMIN_SECRET;
  if (!adminSecret) return Response.json({ error: 'Admin secret not configured' }, { status: 500 });
  const provided = request.headers.get('X-Admin-Key');
  if (!provided || provided !== adminSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const src = env.LEGACY_DB;
  const dst = env.CONSENT_WEBAPP;
  if (!src || !dst) {
    return Response.json({ error: 'LEGACY_DB or CONSENT_WEBAPP binding missing' }, { status: 503 });
  }

  const url    = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));

  // Ensure new columns exist (safe to run multiple times)
  for (const sql of [
    `ALTER TABLE Subscription ADD COLUMN migratedSubId TEXT`,
    `ALTER TABLE Subscription ADD COLUMN stripeItemId TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_sub_migratedSubId ON Subscription(migratedSubId)`,
  ]) {
    try { await dst.prepare(sql).run(); } catch (_) {}
  }

  const now = new Date().toISOString();

  const summary = {
    dryRun,
    offset,
    limit,
    licenses_in_batch: 0,
    users_created: 0,
    users_updated: 0,
    orgs_created: 0,
    sites_created: 0,
    sites_updated: 0,
    sites_skipped_domain_conflict: [],
    subscriptions_created: 0,
    subscriptions_patched: 0,
    subscriptions_skipped_conflict: [],
    license_keys_set: 0,
    license_keys_skipped_already_set: 0,
    activations_created: 0,
    unactivated_keys_mapped: 0,
    subs_no_license_migrated: 0,
    webflow_identified: 0,
    framer_identified: 0,
    platform_unknown: [],
    webflow_site_id_missing: [],
    kv_updated: 0,
    kv_already_done: 0,
    kv_conflicts: [],
    errors: [],
  };

  // Per-run caches
  const orgCache      = new Map(); // email → { userId, orgId }
  const platformCache = new Map(); // domain → identifyPlatform result

  // ── Load source data ──────────────────────────────────────────────────────
  const [customersRes, subsRes, sitesRes, licensesRes, paymentsRes] = await Promise.all([
    src.prepare('SELECT * FROM customers').all(),
    src.prepare('SELECT * FROM subscriptions').all(),
    src.prepare('SELECT * FROM sites').all(),
    src.prepare('SELECT * FROM licenses ORDER BY created_at ASC LIMIT ?1 OFFSET ?2').bind(limit, offset).all(),
    src.prepare('SELECT * FROM payments').all(),
  ]);

  const srcCustomers = customersRes.results || [];
  const srcSubs      = subsRes.results || [];
  const srcSites     = sitesRes.results || [];
  const srcLicenses  = licensesRes.results || [];
  const srcPayments  = paymentsRes.results || [];

  summary.licenses_in_batch = srcLicenses.length;

  // Build lookup maps
  const customerToEmail = new Map(); // customer_id → email
  for (const c of srcCustomers) {
    if (c.customer_id && c.user_email) customerToEmail.set(c.customer_id, c.user_email);
  }

  const subById = new Map(); // subscription_id → sub row
  for (const s of srcSubs) {
    if (s.subscription_id) subById.set(s.subscription_id, s);
  }

  const sitesBySubId = new Map(); // subscription_id → site rows[]
  for (const s of srcSites) {
    if (!s.subscription_id) continue;
    const arr = sitesBySubId.get(s.subscription_id) || [];
    arr.push(s);
    sitesBySubId.set(s.subscription_id, arr);
  }

  const paymentBySubId  = new Map(); // subscription_id → payment row
  const paymentByEmail  = new Map(); // email → latest payment row
  for (const p of srcPayments) {
    if (p.subscription_id) paymentBySubId.set(p.subscription_id, p);
    if (p.email) paymentByEmail.set(normEmail(p.email), p);
  }

  // ── Pass 1: process each license row ─────────────────────────────────────
  const migratedSubIds = new Set();

  for (const lic of srcLicenses) {
    try {
      const customerId = lic.customer_id;
      const email      = customerToEmail.get(customerId);

      if (!email) {
        summary.errors.push(`[SKIP] No email — customer_id=${customerId} license=${lic.license_key}`);
        continue;
      }

      const srcSub      = subById.get(lic.subscription_id) || null;
      const srcSite     = (sitesBySubId.get(lic.subscription_id) || [])[0] || null;
      const payment     = paymentBySubId.get(lic.subscription_id) || paymentByEmail.get(normEmail(email)) || null;

      const purchaseDomain = normDomain(lic.site_domain || srcSite?.site_domain || '');
      const usedDomain     = normDomain(lic.used_site_domain || '');
      const billingEmail   = normEmail(payment?.email || email);

      // Resolve subscription fields
      const priceId      = srcSite?.price_id || null;
      const interval     = mapInterval(srcSub?.billing_period) || inferIntervalFromPriceId(priceId, env) || 'monthly';
      const periodStart  = unixToIso(srcSub?.current_period_start  || srcSite?.current_period_start);
      const periodEnd    = unixToIso(srcSub?.current_period_end    || srcSite?.current_period_end || srcSite?.renewal_date);
      const cancelAtEnd  = (srcSub?.cancel_at_period_end || srcSite?.cancel_at_period_end) ? 1 : 0;
      const canceledAt   = unixToIso(srcSub?.cancel_at || srcSite?.canceled_at);
      const status       = mapSubStatus(srcSub?.status) || mapLicenseStatus(lic.status);
      const planId       = inferPlanId(priceId, env);
      const amountCents  = payment?.amount  || srcSite?.amount_paid || null;
      const stripeItemId = srcSite?.item_id || lic.item_id          || null;

      // User + Org
      const uo = await resolveUserOrg(dst, email, now, summary, dryRun, orgCache);
      if (!uo) {
        summary.errors.push(`[SKIP] Cannot resolve user/org — email=${email}`);
        continue;
      }

      // Active domain = where the license is used, or where it was purchased
      const activeDomain = usedDomain || purchaseDomain;
      if (!activeDomain) {
        summary.errors.push(`[SKIP] No domain — license=${lic.license_key}`);
        continue;
      }

      // Platform identification for active domain
      const platformInfo = await identifyPlatform(activeDomain, srcSite, lic, env, platformCache);
      if (platformInfo.platform === 'webflow')   summary.webflow_identified++;
      else if (platformInfo.platform === 'framer') summary.framer_identified++;
      else summary.platform_unknown.push(activeDomain);

      if (platformInfo.platform === 'webflow' && !platformInfo.platformSiteId) {
        summary.webflow_site_id_missing.push(activeDomain);
      }

      // Resolve site
      const siteResult = await resolveSite(
        dst, uo.orgId, activeDomain,
        platformInfo.platform, platformInfo.platformSiteId, platformInfo.cdnScriptId,
        billingEmail, now, summary, dryRun
      );
      if (!siteResult) {
        summary.errors.push(`[SKIP] Cannot resolve site — domain=${activeDomain}`);
        continue;
      }

      const isActivated = !!usedDomain;
      const siteId = siteResult.conflict ? null : siteResult.siteId;

      // Upsert Subscription
      const subResult = await upsertSubscription(dst, {
        orgId:                uo.orgId,
        siteId,
        stripeSubscriptionId: lic.subscription_id,
        stripeCustomerId:     customerId,
        stripePriceId:        priceId,
        stripeItemId,
        planType:             'single',
        planId,
        interval,
        status,
        currentPeriodStart:   periodStart,
        currentPeriodEnd:     periodEnd,
        cancelAtPeriodEnd:    cancelAtEnd,
        canceledAt,
        licenseKey:           lic.license_key,
        amountCents,
        migratedSubId:        lic.subscription_id,
      }, now, summary, dryRun);

      if (lic.subscription_id) migratedSubIds.add(lic.subscription_id);

      // LicenseActivation — only for activated keys (used_site_domain is set)
      if (isActivated && siteResult.siteId && !subResult.conflict) {
        await upsertLicenseActivation(
          dst, lic.license_key, siteResult.siteId,
          uo.orgId, subResult.subId, now, summary, dryRun
        );
      } else if (!isActivated) {
        summary.unactivated_keys_mapped++;
      }

      // WEBFLOW_AUTHENTICATION KV — Webflow only, never Framer
      if (
        platformInfo.platform === 'webflow' &&
        platformInfo.platformSiteId &&
        siteResult.siteId &&
        !siteResult.conflict
      ) {
        await updateWebflowKV(
          env, platformInfo.platformSiteId, siteResult.siteId,
          planId, platformInfo.wfKvEntry, now, summary, dryRun
        );
      }

    } catch (e) {
      summary.errors.push(`license ${lic.license_key || 'unknown'}: ${e.message}`);
    }
  }

  // ── Pass 2: subscriptions that have no licenses row ───────────────────────
  // Only run on first page (offset=0) to avoid re-running on every paginated call
  if (offset === 0) {
    for (const srcSub of srcSubs) {
      if (migratedSubIds.has(srcSub.subscription_id)) continue;
      if (!srcSub.subscription_id) continue;

      try {
        const email = srcSub.user_email;
        if (!email) continue;

        const srcSite      = (sitesBySubId.get(srcSub.subscription_id) || [])[0] || null;
        const payment      = paymentBySubId.get(srcSub.subscription_id) || paymentByEmail.get(normEmail(email)) || null;
        const domain       = normDomain(srcSite?.site_domain || '');
        const billingEmail = normEmail(payment?.email || email);
        const priceId      = srcSite?.price_id || null;
        const interval     = mapInterval(srcSub.billing_period) || inferIntervalFromPriceId(priceId, env) || 'monthly';
        const periodStart  = unixToIso(srcSub.current_period_start || srcSite?.current_period_start);
        const periodEnd    = unixToIso(srcSub.current_period_end   || srcSite?.current_period_end || srcSite?.renewal_date);
        const cancelAtEnd  = srcSub.cancel_at_period_end ? 1 : 0;
        const canceledAt   = unixToIso(srcSub.cancel_at || srcSite?.canceled_at);
        const status       = mapSubStatus(srcSub.status) || 'active';
        const planId       = inferPlanId(priceId, env);
        const amountCents  = payment?.amount || srcSite?.amount_paid || null;
        const stripeItemId = srcSite?.item_id || null;

        const uo = await resolveUserOrg(dst, email, now, summary, dryRun, orgCache);
        if (!uo) continue;

        let siteId = null;
        if (domain) {
          const platformInfo = await identifyPlatform(domain, srcSite, null, env, platformCache);
          const siteResult = await resolveSite(
            dst, uo.orgId, domain,
            platformInfo.platform, platformInfo.platformSiteId, platformInfo.cdnScriptId,
            billingEmail, now, summary, dryRun
          );
          if (siteResult && !siteResult.conflict) siteId = siteResult.siteId;

          if (
            platformInfo.platform === 'webflow' &&
            platformInfo.platformSiteId &&
            siteResult?.siteId &&
            !siteResult.conflict
          ) {
            await updateWebflowKV(
              env, platformInfo.platformSiteId, siteResult.siteId,
              planId, platformInfo.wfKvEntry, now, summary, dryRun
            );
          }
        }

        await upsertSubscription(dst, {
          orgId:                uo.orgId,
          siteId,
          stripeSubscriptionId: srcSub.subscription_id,
          stripeCustomerId:     srcSub.customer_id,
          stripePriceId:        priceId,
          stripeItemId,
          planType:             'single',
          planId,
          interval,
          status,
          currentPeriodStart:   periodStart,
          currentPeriodEnd:     periodEnd,
          cancelAtPeriodEnd:    cancelAtEnd,
          canceledAt,
          licenseKey:           null,
          amountCents,
          migratedSubId:        srcSub.subscription_id,
        }, now, summary, dryRun);

        summary.subs_no_license_migrated++;

      } catch (e) {
        summary.errors.push(`sub_no_license ${srcSub.subscription_id}: ${e.message}`);
      }
    }
  }

  return Response.json({ success: true, ...summary });
}
