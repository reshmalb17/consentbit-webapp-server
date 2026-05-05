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
} from '../services/db.js';

const TAG = '[webflow-free-register][webapp]';

export async function handleWebflowFreeRegister(request, env) {
  const db = env.CONSENT_WEBAPP;

  console.log(`${TAG} ── REQUEST RECEIVED ──────────────────────────────`);
  console.log(`${TAG} method=${request.method} url=${request.url}`);

  if (request.method !== 'POST') {
    console.warn(`${TAG} Rejected: wrong method ${request.method}`);
    return new Response('Method Not Allowed', { status: 405 });
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const adminKey = request.headers.get('X-Admin-Key') || request.headers.get('X-Internal-Secret');
  const expectedKey = env.ADMIN_KEY || env.INTERNAL_SECRET;
  if (!expectedKey || adminKey !== expectedKey) {
    console.warn(`${TAG} Rejected: invalid or missing admin key`);
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  console.log(`${TAG} Auth: admin key verified`);

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

  console.log(`${TAG} Input: email=${email} domain=${domain} wfSiteId=${wfSiteId}`);

  if (!email || !domain) {
    console.warn(`${TAG} Rejected: missing email or domain`);
    return Response.json({ success: false, error: 'email and domain are required' }, { status: 400 });
  }

  const now = new Date().toISOString();

  // ── Step 1: Find or create user by email ─────────────────────────────────
  console.log(`${TAG} Step 1: Looking up user by email=${email}`);
  let user = await db.prepare('SELECT * FROM User WHERE email = ?1').bind(email).first();

  if (user) {
    console.log(`${TAG} Step 1: Existing user found id=${user.id}`);
  } else {
    console.log(`${TAG} Step 1: No existing user — creating new user`);
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
    console.log(`${TAG} Step 1: New user created id=${user?.id}`);
  }

  if (!user) {
    console.error(`${TAG} Step 1: FAILED — could not create user`);
    return Response.json({ success: false, error: 'Failed to create user account' }, { status: 500 });
  }

  // ── Step 2: Get or create organization ───────────────────────────────────
  console.log(`${TAG} Step 2: Getting or creating organization for userId=${user.id}`);
  const org = await getOrCreateOrganizationForUser(db, {
    userId: user.id,
    organizationName: `${email.split('@')[0]}'s Organization`,
  });
  if (!org?.id) {
    console.error(`${TAG} Step 2: FAILED — could not create organization`);
    return Response.json({ success: false, error: 'Failed to initialize organization' }, { status: 500 });
  }
  console.log(`${TAG} Step 2: Organization ready id=${org.id}`);

  // ── Step 3: Check free plan site limit (1 site per account) ──────────────
  console.log(`${TAG} Step 3: Checking existing sites for orgId=${org.id}`);
  const existingSites = await db
    .prepare('SELECT id, domain FROM Site WHERE organizationId = ?1 LIMIT 2')
    .bind(org.id)
    .all();

  const normalizedDomain = normalizeDomain(domain);
  const siteList = existingSites?.results || [];
  console.log(`${TAG} Step 3: Found ${siteList.length} existing site(s): ${siteList.map(s => s.domain).join(', ') || 'none'}`);
  console.log(`${TAG} Step 3: Normalized incoming domain=${normalizedDomain}`);

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
  if (existingSameDomain) {
    console.log(`${TAG} Step 3: Site already exists for this domain (id=${existingSameDomain.id}) — fetching full record`);
  }

  // ── Step 4: Create or find site ──────────────────────────────────────────
  console.log(`${TAG} Step 4: Creating site domain=${normalizedDomain} orgId=${org.id}`);
  const embedOrigin = canonicalEmbedOrigin(request, env);
  console.log(`${TAG} Step 4: embedOrigin=${embedOrigin}`);

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
    console.log(`${TAG} Step 4: Site created id=${site.id} cdnScriptId=${site.cdnScriptId}`);
  } catch (e) {
    if (e?.code === 'DOMAIN_EXISTS' || e?.status === 409) {
      console.log(`${TAG} Step 4: Domain already exists — looking up existing site`);
      site = await db.prepare('SELECT * FROM Site WHERE domain = ?1').bind(normalizedDomain).first();
      if (!site || String(site.organizationId) !== String(org.id)) {
        console.warn(`${TAG} Step 4: DOMAIN_EXISTS — owned by a different account`);
        return Response.json(
          { success: false, code: 'DOMAIN_EXISTS', error: 'This domain is already registered to another account.' },
          { status: 409 }
        );
      }
      console.log(`${TAG} Step 4: Existing site found for same org id=${site.id} cdnScriptId=${site.cdnScriptId}`);
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
  console.log(`${TAG} Step 5: Setting platform=webflow on siteId=${site.id}`);
  await db
    .prepare(`UPDATE Site SET platform = 'webflow', updatedAt = ?1 WHERE id = ?2`)
    .bind(now, site.id)
    .run();
  console.log(`${TAG} Step 5: platform=webflow set`);

  if (wfSiteId) {
    console.log(`${TAG} Step 5: Setting platformSiteId=${wfSiteId} on siteId=${site.id}`);
    await db
      .prepare(`UPDATE Site SET platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3`)
      .bind(wfSiteId, now, site.id)
      .run();
    console.log(`${TAG} Step 5: platformSiteId set`);
  }

  // ── Step 6: Build CDN script URL ─────────────────────────────────────────
  const scriptUrl =
    site.embedScriptUrl ||
    buildEmbedScriptUrl(embedOrigin || new URL(request.url).origin, site.cdnScriptId) ||
    `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;

  console.log(`${TAG} Step 6: CDN script URL (loaderWebflow will be served): ${scriptUrl}`);

  console.log(`${TAG} ── ACCOUNT CREATION COMPLETE ────────────────────`);
  console.log(`${TAG} userId=${user.id} orgId=${org.id} siteId=${site.id} cdnScriptId=${site.cdnScriptId} domain=${site.domain} scriptUrl=${scriptUrl}`);

  return Response.json({
    success: true,
    webappSiteId: site.id,
    cdnScriptId: site.cdnScriptId,
    scriptUrl,
    domain: site.domain,
    userId: user.id,
    organizationId: org.id,
  });
}
