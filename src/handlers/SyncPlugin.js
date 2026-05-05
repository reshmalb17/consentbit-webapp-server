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
  canonicalEmbedOrigin,
} from '../services/db.js';

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
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

export async function handleSyncPlugin(request, env) {
  console.log('[SyncPlugin] >>> request received', { method: request.method, url: request.url });

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

  console.log('[SyncPlugin] normalized input', { email, rawDomain, siteName, platformSiteId, hasCustomization: !!customization });

  if (!isValidEmail(email)) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (!rawDomain) {
    return Response.json({ success: false, error: 'domain is required' }, { status: 400 });
  }
  if (!platformSiteId) {
    return Response.json({ success: false, error: 'platformSiteId is required' }, { status: 400 });
  }

  // ── 1. Find or create user ───────────────────────────────────────────────
  let user = await getUserByEmail(db, email);
  const isNewUser = !user;
  if (!user) {
    console.log('[SyncPlugin] creating new user for', email);
    user = await createUser(db, { email, name: null });
  } else {
    console.log('[SyncPlugin] existing user found', { userId: user.id });
  }

  // ── 2. Resolve organization (one per user — created on demand) ───────────
  const orgName = user.name ? `${user.name}'s Organization` : 'My Organization';
  const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
  const organizationId = org?.id ?? org?.organizationId ?? null;
  if (!organizationId) {
    console.error('[SyncPlugin] could not resolve organization for user', user.id);
    return Response.json({ success: false, error: 'Could not resolve organization' }, { status: 500 });
  }
  console.log('[SyncPlugin] organizationId', organizationId);

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
      console.log('[SyncPlugin] re-sync of same free-site domain — proceeding');
    }
  }

  // ── 4. Create or upsert the Site ─────────────────────────────────────────
  const embedOrigin = canonicalEmbedOrigin(request, env);
  let site;
  try {
    site = await createSite(db, {
      organizationId,
      name: siteName,
      domain: rawDomain,
      origin: embedOrigin,
      bannerType: 'gdpr',
      regionMode: 'gdpr',
    });
    console.log('[SyncPlugin] site upserted', { siteId: site.id, domain: site.domain });
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
      console.log('[SyncPlugin] customization saved for site', site.id);
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
    console.log('[SyncPlugin] KV (AUTH_STORE_FRAMER) updated for', platformSiteId, { mergedWithExisting: !!existingKv });
  } catch (e) {
    console.error('[SyncPlugin] KV put failed', e);
    return Response.json({ success: false, error: 'Failed to persist platform mapping' }, { status: 500 });
  }

  // ── 7. Done ──────────────────────────────────────────────────────────────
  return Response.json({
    success: true,
    isNewUser,
    userId: user.id,
    siteId: site.id,
    cdnScriptId: site.cdnScriptId ?? site.cdnscriptid ?? null,
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
  console.log('[SyncPluginCustomization] >>> request received', { method: request.method, url: request.url });

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  const kv = env.AUTH_STORE_FRAMER;

  if (!db) {
    console.error('[SyncPluginCustomization] CONSENT_WEBAPP DB binding missing');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }
  if (!kv) {
    console.error('[SyncPluginCustomization] AUTH_STORE_FRAMER KV binding missing');
    return Response.json({ success: false, error: 'KV (AUTH_STORE_FRAMER) not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[SyncPluginCustomization] invalid JSON body', err);
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const platformSiteId = (body?.platformSiteId || '').trim();
  const customization = body?.customization && typeof body.customization === 'object' ? body.customization : null;

  console.log('[SyncPluginCustomization] input', { platformSiteId, hasCustomization: !!customization });

  if (!platformSiteId) {
    return Response.json({ success: false, error: 'platformSiteId is required' }, { status: 400 });
  }
  if (!customization) {
    return Response.json({ success: false, error: 'customization object is required' }, { status: 400 });
  }

  // Look up the KV entry for this platformSiteId
  let kvEntry;
  try {
    kvEntry = await kv.get(platformSiteId, { type: 'json' });
  } catch (e) {
    console.error('[SyncPluginCustomization] KV get failed', e);
    return Response.json({ success: false, error: 'Failed to read platform mapping' }, { status: 500 });
  }

  if (!kvEntry || !kvEntry.webAppSiteId) {
    console.warn('[SyncPluginCustomization] no KV mapping for platformSiteId', platformSiteId);
    return Response.json({
      success: false,
      code: 'NOT_PROVISIONED',
      error: 'Site not yet provisioned. Call /api/sync-plugin first.',
    }, { status: 404 });
  }

  const webAppSiteId = kvEntry.webAppSiteId;
  const cdnScriptId = kvEntry.cdnScriptId ?? null;

  try {
    await saveBannerCustomization(db, webAppSiteId, customization);
    console.log('[SyncPluginCustomization] customization saved for site', webAppSiteId);
  } catch (e) {
    console.error('[SyncPluginCustomization] saveBannerCustomization failed', e);
    return Response.json({ success: false, error: 'Failed to save customization' }, { status: 500 });
  }

  // Bump KV updatedAt timestamp
  try {
    await kv.put(platformSiteId, JSON.stringify({ ...kvEntry, updatedAt: new Date().toISOString() }));
  } catch (e) {
    console.warn('[SyncPluginCustomization] KV updatedAt bump failed (non-fatal)', e);
  }

  return Response.json({
    success: true,
    siteId: webAppSiteId,
    cdnScriptId,
    platformSiteId,
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
  console.log('[GetPluginData] >>> request received', { method: request.method, url: request.url });

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

  console.log('[GetPluginData] input', { webAppSiteId });

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
    customization,
  }, { status: 200 });
}
