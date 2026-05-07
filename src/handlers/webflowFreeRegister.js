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
  // Accepts either X-Admin-Key (internal cb-server calls) or open access (direct from Webflow app)
  const adminKey = request.headers.get('X-Admin-Key') || request.headers.get('X-Internal-Secret');
  const expectedKey = env.ADMIN_KEY || env.INTERNAL_SECRET;
  const isAdminCall = expectedKey && adminKey === expectedKey;
  console.log(`${TAG} Auth: ${isAdminCall ? 'admin key verified' : 'open access (Webflow app direct call)'}`);

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

  // ── Short-circuit if already registered ──────────────────────────────────
  if (wfSiteId) {
    const kvRaw = await env.WEBFLOW_AUTHENTICATION?.get(wfSiteId);
    if (kvRaw) {
      const kvEntry = JSON.parse(kvRaw);
      if (kvEntry.webappSiteId && kvEntry.webappScriptUrl) {
        // Verify the site still exists in D1 — KV can be stale after data deletion
        const siteExists = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(kvEntry.webappSiteId).first();
        if (siteExists) {
          console.log(`${TAG} Already registered — webappSiteId=${kvEntry.webappSiteId} scriptUrl=${kvEntry.webappScriptUrl}`);
          return Response.json({
            success: true,
            alreadyRegistered: true,
            webappSiteId: kvEntry.webappSiteId,
            scriptUrl: kvEntry.webappScriptUrl,
            cdnScriptId: kvEntry.cdnScriptId,
          });
        }
        // Site was deleted — clear stale KV fields and fall through to re-register
        console.log(`${TAG} KV has webappSiteId=${kvEntry.webappSiteId} but Site not found in D1 — clearing stale KV and re-registering`);
        const cleanedKv = { ...kvEntry };
        delete cleanedKv.webappSiteId;
        delete cleanedKv.webappScriptUrl;
        delete cleanedKv.cdnScriptId;
        await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify(cleanedKv)).catch(() => {});
      }
    }
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

  // ── Step 7: Inject script into Webflow site head via Webflow REST API ────
  let injectedIntoHead = false;
  if (wfSiteId) {
    console.log(`${TAG} Step 7: Injecting script into Webflow site head for wfSiteId=${wfSiteId}`);
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

          // Persist the Webflow registered script ID back to D1 for future reuse
          if (result.webflowScriptId && result.webflowScriptId !== storedWebflowScriptId) {
            await db.prepare('UPDATE Site SET webflowScriptId = ?1, updatedAt = ?2 WHERE id = ?3')
              .bind(result.webflowScriptId, new Date().toISOString(), site.id).run().catch(() => {});
          }

          // Update KV with webappSiteId + scriptUrl
          const updatedKv = { ...kvEntry, webappSiteId: site.id, webappScriptUrl: scriptUrl, cdnScriptId: site.cdnScriptId, registeredThroughApp: true, isWebappMigrated: true };
          await env.WEBFLOW_AUTHENTICATION?.put(wfSiteId, JSON.stringify(updatedKv));
          console.log(`${TAG} Step 7: KV updated with webappSiteId=${site.id}`);
        }
      }
    } catch (err) {
      console.error(`${TAG} Step 7: Script injection error:`, err?.message || err);
    }
  }

  console.log(`${TAG} ── ACCOUNT CREATION COMPLETE ────────────────────`);
  console.log(`${TAG} userId=${user.id} orgId=${org.id} siteId=${site.id} cdnScriptId=${site.cdnScriptId} domain=${site.domain} scriptUrl=${scriptUrl} injectedIntoHead=${injectedIntoHead}`);

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

async function injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, TAG, storedWebflowScriptId = null) {
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
          console.log(`${TAG} Step 7: Reused existing script ${candidateId} — ${alreadyApplied ? 'already applied' : 're-applied'}`);
          return { success: true, webflowScriptId: candidateId };
        }
        console.log(`${TAG} Step 7: Stored script ${candidateId} has stale URL — registering new one`);
      }
    } catch { /* proceed to register new */ }
  }

  // 4. Register new inline script
  const displayName = `ConsentBitBanner${Date.now()}`;
  console.log(`${TAG} Step 7: Registering new inline script displayName=${displayName}`);
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
  console.log(`${TAG} Step 7: New inline script registered scriptId=${scriptId}`);

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

  console.log(`${TAG} Step 7: Script injected into Webflow site head ✓`);
  return { success: true, webflowScriptId: scriptId };
}
