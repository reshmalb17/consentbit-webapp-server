// POST /api/licenses/activate-webflow
// Activates an unassigned license key by assigning it to a domain.
// Dashboard path: session cookie + { licenseKey, domain, organizationId }
// Webflow app path: open access + { licenseKey, domain, wfSiteId, email }

import {
  getSessionById,
  getUserById,
  getLicenseActivation,
  activateLicense,
  createSite,
  normalizeDomain,
  buildEmbedScriptUrl,
  canonicalEmbedOrigin,
} from '../services/db.js';
import { syncLicenseActivateToLegacy } from '../services/syncLegacy.js';

const TAG = '[activate-license-webflow]';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function getLicenseKeysFromRow(row) {
  let raw = row?.licensekeys ?? row?.licenseKeys ?? row?.license_keys ?? null;
  if (!raw) {
    const k = Object.keys(row || {}).find((key) => key.toLowerCase() === 'licensekeys');
    if (k) raw = row[k];
  }
  if (!raw) return [];
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch (_) { return []; }
}

export async function handleActivateLicenseWebflow(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const licenseKey = (body.licenseKey || '').trim();
  const domain = (body.domain || '').trim();
  const wfSiteIdFromBody = (body.wfSiteId || '').trim() || null;
  const emailFromBody = (body.email || '').trim().toLowerCase() || null;

  if (!licenseKey || !domain) {
    return Response.json({ success: false, error: 'licenseKey and domain are required' }, { status: 400 });
  }

  const now = new Date().toISOString();

  // ── Auth: session cookie (dashboard) OR email (Webflow app) ─────────────
  let user = null;

  const sid = getSessionIdFromCookie(request);
  if (sid) {
    const session = await getSessionById(db, sid);
    if (!session) {
      return Response.json({ success: false, error: 'Login required' }, { status: 401 });
    }
    user = await getUserById(db, session.userId ?? session.user_id);
    if (!user) {
      return Response.json({ success: false, error: 'Login required' }, { status: 401 });
    }
  } else if (emailFromBody) {
    user = await db.prepare('SELECT * FROM User WHERE email = ?1').bind(emailFromBody).first();
    if (!user) {
      return Response.json({ success: false, error: 'No account found for this email' }, { status: 404 });
    }
  } else {
    return Response.json({ success: false, error: 'Authentication required' }, { status: 401 });
  }

  // ── Resolve org ───────────────────────────────────────────────────────────
  const org = await db.prepare(
    `SELECT o.* FROM Organization o
     JOIN OrganizationMember m ON m.organizationId = o.id
     WHERE m.userId = ?1
     ORDER BY o.createdAt ASC LIMIT 1`
  ).bind(user.id).first();

  if (!org) {
    return Response.json({ success: false, error: 'No organization found for this account' }, { status: 404 });
  }

  // Optional: verify organizationId hint from dashboard path
  const orgIdHint = (body.organizationId || '').trim();
  if (orgIdHint && orgIdHint !== org.id) {
    return Response.json({ success: false, error: 'Organization mismatch' }, { status: 403 });
  }

  // ── Guard: license already activated ─────────────────────────────────────
  const existingActivation = await getLicenseActivation(db, licenseKey);
  if (existingActivation) {
    return Response.json({ success: false, error: 'License key is already activated' }, { status: 400 });
  }

  // ── Find this license key in org's subscriptions ──────────────────────────
  const { results: orgSubs } = await db
    .prepare('SELECT * FROM Subscription WHERE organizationId = ?1')
    .bind(org.id)
    .all();

  const sub = (orgSubs || []).find((s) => {
    const key = s.licenseKey ?? s.licensekey;
    if (key === licenseKey) return true;
    return getLicenseKeysFromRow(s).includes(licenseKey);
  });

  if (!sub) {
    return Response.json({ success: false, error: 'License key not found for this organization' }, { status: 404 });
  }

  if (sub.siteId) {
    return Response.json({ success: false, error: 'License key is already assigned to a site' }, { status: 400 });
  }

  // ── Find or create Site ───────────────────────────────────────────────────
  const embedOrigin = canonicalEmbedOrigin(request, env);
  let site;
  try {
    site = await createSite(db, {
      organizationId: org.id,
      name: normalizeDomain(domain),
      domain,
      origin: embedOrigin || new URL(request.url).origin,
      bannerType: 'gdpr',
      regionMode: 'gdpr',
    });
  } catch (e) {
    if (e?.code === 'DOMAIN_EXISTS' || e?.status === 409) {
      site = await db.prepare('SELECT * FROM Site WHERE domain = ?1').bind(normalizeDomain(domain)).first();
      if (!site || String(site.organizationId) !== String(org.id)) {
        return Response.json({ success: false, error: 'Domain is already registered to another account' }, { status: 409 });
      }
    } else {
      console.error(`${TAG} createSite error:`, e?.message || e);
      return Response.json({ success: false, error: 'Failed to create site' }, { status: 500 });
    }
  }

  if (!site) {
    return Response.json({ success: false, error: 'Failed to resolve site' }, { status: 500 });
  }

  // ── Activate license (LicenseActivation + Subscription.siteId) ───────────
  const activated = await activateLicense(db, {
    licenseKey,
    siteId: site.id,
    organizationId: org.id,
    subscriptionId: sub.id,
  });

  if (!activated) {
    return Response.json({ success: false, error: 'Failed to activate license' }, { status: 500 });
  }

  // ── Resolve Webflow site ID ───────────────────────────────────────────────
  // Webflow app always sends wfSiteId. Dashboard path: best-effort HTML fetch.
  let resolvedWfSiteId = wfSiteIdFromBody;
  if (!resolvedWfSiteId) {
    try {
      const normalDom = normalizeDomain(domain);
      const res = await fetch(`https://${normalDom}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const html = await res.text();
        const m = html.match(/data-wf-site="([^"]+)"/);
        if (m) resolvedWfSiteId = m[1];
      }
    } catch { /* best-effort */ }
  }

  // ── Update Site with platform + platformSiteId ────────────────────────────
  if (resolvedWfSiteId) {
    await db
      .prepare(`UPDATE Site SET platform = 'webflow', platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3`)
      .bind(resolvedWfSiteId, now, site.id)
      .run();
    site.platformSiteId = resolvedWfSiteId;
  } else {
    await db
      .prepare(`UPDATE Site SET platform = 'webflow', updatedAt = ?1 WHERE id = ?2`)
      .bind(now, site.id)
      .run();
  }

  // ── Build script URL ──────────────────────────────────────────────────────
  const scriptUrl =
    site.embedScriptUrl ||
    buildEmbedScriptUrl(embedOrigin || new URL(request.url).origin, site.cdnScriptId) ||
    `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;

  // ── Write to WEBFLOW_AUTHENTICATION KV ───────────────────────────────────
  if (resolvedWfSiteId && env.WEBFLOW_AUTHENTICATION) {
    try {
      let existingKv = {};
      const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(resolvedWfSiteId);
      if (kvRaw) {
        try { existingKv = JSON.parse(kvRaw); } catch { existingKv = {}; }
      }

      const planId = sub.planId ?? sub.planid ?? null;
      const planToWrite = planId || 'basic';

      await env.WEBFLOW_AUTHENTICATION.put(resolvedWfSiteId, JSON.stringify({
        ...existingKv,
        webappSiteId: site.id,
        webappScriptUrl: scriptUrl,
        cdnScriptId: site.cdnScriptId,
        plan: existingKv?.plan || planToWrite,
        isWebappMigrated: true,
        activatedAt: now,
      }));
    } catch (kvErr) {
      console.warn(`${TAG} KV write failed (non-critical):`, kvErr?.message);
    }
  }

  // ── Outbound sync to legacy DB ────────────────────────────────────────────
  try {
    await syncLicenseActivateToLegacy(env, {
      email: user?.email || null,
      licenseKey,
      domain: normalizeDomain(domain),
      subscriptionId: sub?.stripeSubscriptionId ?? sub?.stripesubscriptionid ?? null,
      customerId: sub?.stripeCustomerId ?? sub?.stripecustomerid ?? null,
      platform: 'webflow',
    });
  } catch (syncErr) {
    console.warn(`${TAG} Legacy sync failed (non-critical):`, syncErr?.message);
  }

  return Response.json({
    success: true,
    message: 'License activated successfully',
    siteId: site.id,
    domain: normalizeDomain(domain),
    cdnScriptId: site.cdnScriptId,
    scriptUrl,
    platformSiteId: resolvedWfSiteId || null,
  });
}
