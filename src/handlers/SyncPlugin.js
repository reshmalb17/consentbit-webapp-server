// POST /api/sync-plugin
//
// Triggered when a user clicks "Publish" inside the platform plugin (Framer/Webflow/etc).
//
// Body:
//   {
//     email: string,
//     domain: string,
//     siteName?: string,
//     platformSiteId: string,        // identifier from the host platform (Framer/Webflow site id)
//     customization?: object,        // banner customization data
//   }
//
// Plan is always 'free' for this flow.
//
// Behavior:
//   1. Look up user by email.
//        a. If exists → check whether they already own a free-plan site (no active subscription).
//             - If yes → 409 "You already have a free site in your account."
//             - If no  → add the new site under their existing organization.
//        b. If not exists → create user + organization → add site under it.
//   2. Save banner customization for the new site.
//   3. Persist { userId, siteId } in env.AUTH_STORE_FRAMER KV keyed by platformSiteId.
//   4. Return { success: true, userId, siteId }.

import {
  getUserByEmail,
  createUser,
  getOrCreateOrganizationForUser,
  listSites,
  getSubscriptionBySiteId,
  createSite,
  saveBannerCustomization,
  getBannerCustomization,
  getSiteByDomain,
  inferTierPlanIdFromStripePriceId,
  canonicalEmbedOrigin,
  markSiteVerified,
} from '../services/db.js';

const VERIFY_SCRIPT_BASE_URL = 'https://consent-webapp-manager.web-8fb.workers.dev/consentbit';

function buildVerifyScriptUrl(cdnScriptId) {
  return `${VERIFY_SCRIPT_BASE_URL}/${cdnScriptId}/script.js`;
}

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
}

/**
 * Fire a PostHog capture. Reads POSTHOG_API_KEY (required) and POSTHOG_HOST
 * (optional, defaults to https://us.i.posthog.com). No-op when the API key is
 * not configured — never throws, so a capture failure can't break the flow.
 * Awaited by the caller so the event is delivered before the worker responds
 * (this handler has no ctx.waitUntil available).
 */
async function capturePosthog(env, { event, distinctId, properties }) {
  try {
    const apiKey = (env.POSTHOG_API_KEY || '').trim();
    if (!apiKey || !distinctId || !event) return;
    const host = ((env.POSTHOG_HOST || '').trim()) || 'https://us.i.posthog.com';
    const url = `${host.replace(/\/+$/, '')}/capture/`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: distinctId,
        properties: properties || {},
        timestamp: new Date().toISOString(),
      }),
    }).catch((err) => console.warn('[SyncPlugin] posthog capture failed', err?.message));
  } catch (e) {
    console.warn('[SyncPlugin] capturePosthog threw (non-fatal)', e?.message);
  }
}

/** Returns the first site under this org that is NOT on a paid plan (no active/trialing subscription). */
async function findFreePlanSite(db, organizationId) {
  if (!organizationId) return null;
  const sites = await listSites(db, { organizationId });
  for (const site of sites || []) {
    const sub = await getSubscriptionBySiteId(db, site.id);
    if (!sub) return site;
  }
  return null;
}

/**
 * Derive Site.banner_type + Site.region_mode from the plugin's customization payload.
 * The plugin sends `compliance` (GDPR | CCPA | BOTH) and `isIab` (true/false) inside
 * customization.translations.en. Mapping rules:
 *   isIab=true        → banner_type='iab',  region_mode='gdpr'
 *   compliance=CCPA   → banner_type='ccpa', region_mode='ccpa'
 *   compliance=BOTH   → banner_type='gdpr', region_mode='both'
 *   otherwise/GDPR    → banner_type='gdpr', region_mode='gdpr'
 * Returns null if no signal is present (so the caller can skip updating the row).
 */
function deriveBannerTypeAndRegionMode(customization) {
  if (!customization || typeof customization !== 'object') return null;
  let en = customization.translations?.en;
  if (typeof en === 'string') {
    try { en = JSON.parse(en); } catch { en = null; }
  }
  if (!en || typeof en !== 'object') return null;

  const isIab = en.isIab === true || en.isIab === 'true' || en.isIab === 1 || en.isIab === '1';
  const compliance = String(en.compliance ?? '').toUpperCase();

  if (isIab) return { bannerType: 'iab', regionMode: 'gdpr' };
  if (compliance === 'CCPA') return { bannerType: 'ccpa', regionMode: 'ccpa' };
  if (compliance === 'BOTH') return { bannerType: 'gdpr', regionMode: 'both' };
  if (compliance === 'GDPR') return { bannerType: 'gdpr', regionMode: 'gdpr' };
  return null;
}

// Legacy/migrated customization stores `language` as an ISO code ("en"),
// but the live plugin's translations record is keyed by full names ("English").
// Map on read so old data renders correctly without rewriting the DB.
const LANG_CODE_TO_NAME = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  sv: 'Swedish',
  nl: 'Dutch',
  it: 'Italian',
  pt: 'Portuguese',
  pl: 'Polish',
};

function normalizeCustomizationLanguage(customization) {
  if (!customization || typeof customization !== 'object') return customization;
  const code = customization.language;
  if (typeof code !== 'string') return customization;
  const mapped = LANG_CODE_TO_NAME[code.toLowerCase()];
  if (!mapped || mapped === code) return customization;
  return { ...customization, language: mapped };
}

/** UPDATE Site SET banner_type, region_mode for an existing row. Silent on failure. */
async function updateSiteBannerType(db, siteId, derived) {
  if (!siteId || !derived) return;
  try {
    await db
      .prepare('UPDATE Site SET banner_type = ?1, region_mode = ?2, updatedAt = ?3 WHERE id = ?4')
      .bind(derived.bannerType, derived.regionMode, new Date().toISOString(), siteId)
      .run();
  } catch (e) {
    console.warn('[SyncPlugin] updateSiteBannerType failed (non-fatal)', e?.message);
  }
}

export async function handleSyncPlugin(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  const kv = env.AUTH_STORE_FRAMER;

  if (!db) {
    console.error('[SyncPlugin] CONSENT_WEBAPP DB binding missing');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }
  if (!kv) {
    console.error('[SyncPlugin] AUTH_STORE_FRAMER KV binding missing');
    return Response.json({ success: false, error: 'KV (AUTH_STORE_FRAMER) not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[SyncPlugin] invalid JSON body', err);
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body?.email || '').trim().toLowerCase();
  const rawDomain = (body?.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  const siteName = (body?.siteName || '').trim() || rawDomain;
  const platformSiteId = (body?.platformSiteId || '').trim();
  const customization = body?.customization && typeof body.customization === 'object' ? body.customization : null;

  if (!isValidEmail(email)) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (!rawDomain) {
    return Response.json({ success: false, error: 'domain is required' }, { status: 400 });
  }
  if (!platformSiteId) {
    return Response.json({ success: false, error: 'platformSiteId is required' }, { status: 400 });
  }

  // ── 0. Fast path: site already exists in DB (added via webApp earlier) ───
  //     Don't create a new user/org/site. Just establish the platformSiteId
  //     → webAppSiteId mapping in KV and return.
  try {
    const existingSite = await getSiteByDomain(db, rawDomain);
    if (existingSite && existingSite.id) {
      console.log('[SyncPlugin] domain already exists in DB — skipping create flow', {
        webAppSiteId: existingSite.id,
        domain: rawDomain,
      });

      // Resolve owner userId from the site's organization
      const siteOrgId = existingSite.organizationId ?? existingSite.organizationid ?? null;
      let ownerUserId = null;
      if (siteOrgId) {
        try {
          const orgRow = await db.prepare('SELECT ownerUserId FROM Organization WHERE id = ?1').bind(siteOrgId).first();
          ownerUserId = orgRow ? (orgRow.ownerUserId ?? orgRow.owneruserid ?? null) : null;
        } catch (e) {
          console.warn('[SyncPlugin] failed to resolve owner userId (non-fatal)', e?.message);
        }
      }

      // Determine plan ('free' if no active sub, else the tier)
      let plan = 'free';
      try {
        const sub = await getSubscriptionBySiteId(db, existingSite.id);
        if (sub) {
          let resolved = String(sub.planId ?? sub.planid ?? '').toLowerCase();
          if (!['basic', 'essential', 'growth'].includes(resolved)) {
            const priceId = sub.stripePriceId ?? sub.stripepriceid ?? null;
            const inferred = inferTierPlanIdFromStripePriceId(env, priceId);
            if (inferred) resolved = inferred;
          }
          plan = ['basic', 'essential', 'growth'].includes(resolved) ? resolved : 'free';
        }
      } catch (e) {
        console.warn('[SyncPlugin] plan lookup failed (non-fatal)', e?.message);
      }

      const cdnScriptId = existingSite.cdnScriptId ?? existingSite.cdnscriptid ?? null;

      // If customization specifies compliance / isIab, sync banner_type + region_mode on Site.
      const derivedExisting = deriveBannerTypeAndRegionMode(customization);
      if (derivedExisting) {
        await updateSiteBannerType(db, existingSite.id, derivedExisting);
      }

      // Merge into KV without disturbing existing fields
      try {
        let existingKv = null;
        try {
          existingKv = await kv.get(platformSiteId, { type: 'json' });
        } catch (e) {
          console.warn('[SyncPlugin] KV get failed (treating as empty)', e?.message);
        }
        const newFields = {
          userId: ownerUserId,
          webAppSiteId: existingSite.id,
          cdnScriptId,
          organizationId: siteOrgId,
          domain: rawDomain,
          platformSiteId,
          plan,
          paid: plan !== 'free',
          updatedAt: new Date().toISOString(),
        };
        const kvValue = existingKv && typeof existingKv === 'object'
          ? { ...existingKv, ...newFields }
          : newFields;
        await kv.put(platformSiteId, JSON.stringify(kvValue));
        console.log('[SyncPlugin] KV mapping written for existing site', { platformSiteId, mergedWithExisting: !!existingKv });
      } catch (e) {
        console.error('[SyncPlugin] KV put failed for existing site', e);
        return Response.json({ success: false, error: 'Failed to persist platform mapping' }, { status: 500 });
      }

      if (cdnScriptId) {
        try {
          await markSiteVerified(db, existingSite.id, buildVerifyScriptUrl(cdnScriptId));
        } catch (e) {
          console.warn('[SyncPlugin] markSiteVerified failed for existing site (non-fatal)', e?.message);
        }
      }

      return Response.json({
        success: true,
        existingSite: true,
        isNewUser: false,
        userId: ownerUserId,
        siteId: existingSite.id,
        cdnScriptId,
        organizationId: siteOrgId,
        plan,
        platformSiteId,
      }, { status: 200 });
    }
  } catch (e) {
    console.warn('[SyncPlugin] getSiteByDomain failed (continuing with normal flow)', e?.message);
  }

  // ── 1. Find or create user ───────────────────────────────────────────────
  let user = await getUserByEmail(db, email);
  const isNewUser = !user;
  if (!user) {
    user = await createUser(db, { email, name: null });
  }

  // ── 2. Resolve organization (one per user — created on demand) ───────────
  const orgName = user.name ? `${user.name}'s Organization` : 'My Organization';
  const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
  const organizationId = org?.id ?? org?.organizationId ?? null;
  if (!organizationId) {
    console.error('[SyncPlugin] could not resolve organization for user', user.id);
    return Response.json({ success: false, error: 'Could not resolve organization' }, { status: 500 });
  }
  // ── 3. Existing user: enforce one-free-site-per-account rule ─────────────
  if (!isNewUser) {
    const existingFreeSite = await findFreePlanSite(db, organizationId);
    if (existingFreeSite) {
      // If the existing free site is the SAME domain we're publishing, allow re-sync.
      const sameDomain = String(existingFreeSite.domain || '').toLowerCase() === rawDomain.toLowerCase();
      if (!sameDomain) {
        console.warn('[SyncPlugin] user already has a free site', { userId: user.id, existingSiteId: existingFreeSite.id, existingDomain: existingFreeSite.domain });
        return Response.json({
          success: false,
          code: 'FREE_SITE_LIMIT',
          error: 'You already have a free site in your account. Upgrade an existing site or remove the free one before adding another.',
          existingFreeSite: { id: existingFreeSite.id, domain: existingFreeSite.domain, name: existingFreeSite.name },
        }, { status: 409 });
      }
    }
  }

  // ── 4. Create or upsert the Site ─────────────────────────────────────────
  const embedOrigin = canonicalEmbedOrigin(request, env);
  const derivedNew = deriveBannerTypeAndRegionMode(customization);
  let site;
  try {
    site = await createSite(db, {
      organizationId,
      name: siteName,
      domain: rawDomain,
      origin: embedOrigin,
      bannerType: derivedNew?.bannerType ?? 'gdpr',
      regionMode: derivedNew?.regionMode ?? 'gdpr',
    });
  } catch (e) {
    if (e.code === 'DOMAIN_EXISTS') {
      return Response.json({
        success: false,
        code: 'DOMAIN_IN_USE',
        error: 'This domain is already registered to another active account.',
      }, { status: 409 });
    }
    console.error('[SyncPlugin] createSite failed', e);
    return Response.json({ success: false, error: 'Failed to create site' }, { status: 500 });
  }

  // ── 5. Save customization (always, new or existing) ──────────────────────
  if (customization) {
    try {
      await saveBannerCustomization(db, site.id, customization);
    } catch (e) {
      console.error('[SyncPlugin] saveBannerCustomization failed (non-fatal)', e);
    }
  }

  // ── 6. Persist mapping in KV keyed by platformSiteId ─────────────────────
  //     Merge with existing KV value so any fields stored by other flows
  //     (e.g. legacy framer plugin auth data) are preserved.
  try {
    let existingKv = null;
    try {
      existingKv = await kv.get(platformSiteId, { type: 'json' });
    } catch (e) {
      console.warn('[SyncPlugin] KV get failed (treating as empty)', e);
    }

    const cdnScriptId = site.cdnScriptId ?? site.cdnscriptid ?? null;
    const newFields = {
      userId: user.id,
      webAppSiteId: site.id,
      cdnScriptId,
      organizationId,
      email,
      domain: rawDomain,
      platformSiteId,
      plan: 'free',
      updatedAt: new Date().toISOString(),
    };
    const kvValue = existingKv && typeof existingKv === 'object'
      ? { ...existingKv, ...newFields }
      : newFields;

    await kv.put(platformSiteId, JSON.stringify(kvValue));
  } catch (e) {
    console.error('[SyncPlugin] KV put failed', e);
    return Response.json({ success: false, error: 'Failed to persist platform mapping' }, { status: 500 });
  }

  // ── 7. Done ──────────────────────────────────────────────────────────────
  const newCdnScriptId = site.cdnScriptId ?? site.cdnscriptid ?? null;
  if (newCdnScriptId) {
    try {
      await markSiteVerified(db, site.id, buildVerifyScriptUrl(newCdnScriptId));
    } catch (e) {
      console.warn('[SyncPlugin] markSiteVerified failed for new site (non-fatal)', e?.message);
    }
  }

  // Analytics: free plan selected — only fired here, after the site, customization,
  // KV mapping and verification have all completed successfully. Every failure path
  // above returns before this point, so the event never fires on error.
  await capturePosthog(env, {
    event: 'plan_selected',
    distinctId: email,
    properties: {
      plan_tier: 'free',
      billing_cycle: 'monthly',
      plan_price: 0,
      platform: 'framer',
      domain: rawDomain,
      siteId: site.id,
    },
  });

  return Response.json({
    success: true,
    isNewUser,
    userId: user.id,
    siteId: site.id,
    cdnScriptId: newCdnScriptId,
    organizationId,
    plan: 'free',
    platformSiteId,
  }, { status: isNewUser ? 201 : 200 });
}

// POST /api/sync-plugin-customization
//
// Called by the plugin on every publish AFTER the site has already been provisioned
// (i.e. AUTH_STORE_FRAMER already has an entry for this platformSiteId with cdnScriptId).
// This endpoint only updates the banner customization for the existing site.
//
// Body:
//   {
//     platformSiteId: string,
//     customization: object,
//   }
//
// Returns: { success: true, siteId, cdnScriptId, platformSiteId }
export async function handleSyncPluginCustomization(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;

  if (!db) {
    console.error('[SyncPluginCustomization] CONSENT_WEBAPP DB binding missing');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[SyncPluginCustomization] invalid JSON body', err);
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const webAppSiteId = (body?.webAppSiteId || '').trim();
  const customization = body?.customization && typeof body.customization === 'object' ? body.customization : null;

  if (!webAppSiteId) {
    return Response.json({ success: false, error: 'webAppSiteId is required' }, { status: 400 });
  }
  if (!customization) {
    return Response.json({ success: false, error: 'customization object is required' }, { status: 400 });
  }

  try {
    await saveBannerCustomization(db, webAppSiteId, customization);
  } catch (e) {
    console.error('[SyncPluginCustomization] saveBannerCustomization failed', e);
    return Response.json({ success: false, error: 'Failed to save customization' }, { status: 500 });
  }

  // Sync Site.banner_type + Site.region_mode from customization.translations.en
  // (compliance / isIab fields). No-op if neither field is present.
  const derivedFromCustomization = deriveBannerTypeAndRegionMode(customization);
  if (derivedFromCustomization) {
    await updateSiteBannerType(db, webAppSiteId, derivedFromCustomization);
  }

  return Response.json({
    success: true,
    siteId: webAppSiteId,
  }, { status: 200 });
}

// GET  /api/sync-plugin-data?webAppSiteId=...
// POST /api/sync-plugin-data       (body: { webAppSiteId })
//
// Fetches the banner customization row for the given webAppSiteId.
//
// Returns: { success: true, webAppSiteId, customization }
//   404 NOT_FOUND — no customization row for this site
export async function handleGetPluginData(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (!db) {
    console.error('[GetPluginData] CONSENT_WEBAPP DB binding missing');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  // Accept webAppSiteId from query (GET) or JSON body (POST)
  let webAppSiteId = '';
  if (request.method === 'GET') {
    const url = new URL(request.url);
    webAppSiteId = (url.searchParams.get('webAppSiteId') || '').trim();
  } else if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      console.error('[GetPluginData] invalid JSON body', err);
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    webAppSiteId = (body?.webAppSiteId || '').trim();
  } else {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  if (!webAppSiteId) {
    return Response.json({ success: false, error: 'webAppSiteId is required' }, { status: 400 });
  }

  let customization = null;
  try {
    customization = await getBannerCustomization(db, webAppSiteId);
  } catch (e) {
    console.error('[GetPluginData] getBannerCustomization failed', e);
    return Response.json({ success: false, error: 'Failed to fetch customization' }, { status: 500 });
  }

  if (!customization) {
    console.warn('[GetPluginData] no customization for webAppSiteId', webAppSiteId);
    return Response.json({
      success: false,
      code: 'NOT_FOUND',
      error: 'No customization data found for this site.',
    }, { status: 404 });
  }

  return Response.json({
    success: true,
    webAppSiteId,
    customization: normalizeCustomizationLanguage(customization),
  }, { status: 200 });
}

// GET  /api/sync-plugin-plan?webAppSiteId=...
// POST /api/sync-plugin-plan       (body: { webAppSiteId })
//
// Returns the plan tier for a given site:
//   - 'free'      → no active subscription on this site
//   - 'basic'     → tier subscription (active/trialing)
//   - 'essential' → tier subscription (active/trialing)
//   - 'growth'    → tier subscription (active/trialing)
//
// Response: { success: true, webAppSiteId, planId, status, subscription }
//   404 SITE_NOT_FOUND — webAppSiteId does not match any Site row
export async function handleGetPluginPlan(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) {
    console.error('[GetPluginPlan] CONSENT_WEBAPP DB binding missing');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  let webAppSiteId = '';
  if (request.method === 'GET') {
    const url = new URL(request.url);
    webAppSiteId = (url.searchParams.get('webAppSiteId') || '').trim();
  } else if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      console.error('[GetPluginPlan] invalid JSON body', err);
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    webAppSiteId = (body?.webAppSiteId || '').trim();
  } else {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  if (!webAppSiteId) {
    return Response.json({ success: false, error: 'webAppSiteId is required' }, { status: 400 });
  }

  // Single query — fetch the active/trialing subscription for this site.
  // We skip getSiteById entirely (it isn't needed for the plan answer and was
  // adding a second sequential D1 read).
  let sub = null;
  try {
    sub = await getSubscriptionBySiteId(db, webAppSiteId);
  } catch (e) {
    console.error('[GetPluginPlan] getSubscriptionBySiteId failed', e);
    return Response.json({ success: false, error: 'Failed to look up subscription' }, { status: 500 });
  }
  console.log('[GetPluginPlan] lookup result', { subFound: !!sub });

  let planId = 'free';
  let status = 'inactive';

  if (sub) {
    status = String(sub.status ?? 'active').toLowerCase();
    let resolved = String(sub.planId ?? sub.planid ?? '').toLowerCase();
    if (!['basic', 'essential', 'growth'].includes(resolved)) {
      // Fall back to inferring from Stripe price id when planId column is empty
      const priceId = sub.stripePriceId ?? sub.stripepriceid ?? null;
      const inferred = inferTierPlanIdFromStripePriceId(env, priceId);
      if (inferred) resolved = inferred;
    }
    planId = ['basic', 'essential', 'growth'].includes(resolved) ? resolved : 'free';
  }

  return Response.json({
    success: true,
    webAppSiteId,
    planId,
    status,
    subscription: sub
      ? {
          id: sub.id,
          stripeSubscriptionId: sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null,
          interval: sub.interval ?? null,
          currentPeriodEnd: sub.currentPeriodEnd ?? sub.currentperiodend ?? null,
          cancelAtPeriodEnd: Number(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend ?? 0) === 1 ? 1 : 0,
        }
      : null,
  }, { status: 200 });
}
