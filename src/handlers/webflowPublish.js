// src/handlers/webflowPublish.js
//
// Publish a Webflow site on behalf of the app:
//
//   POST /api/webflow/publish
//     body: { siteId, publishToWebflowSubdomain?, customDomains? }
//
// The Webflow Designer Extension has no publish API, so the extension sends the
// site id here and we call Webflow's Data API with the stored OAuth token:
//   POST https://api.webflow.com/v2/sites/{siteId}/publish   (scope: sites:write)
//
// Token resolution mirrors the OAuth status handler: D1-first, KV fallback
// (resolveWebflowOAuthToken). The token is never exposed to the client.
//
// NOTE: the stored token must carry the `sites:write` scope. The default OAuth
// scopes do NOT include it — see DEFAULT_SCOPES in webflowOAuth.js. A token
// minted before sites:write was added will get HTTP 403 from Webflow; the user
// must re-authorize to mint a new token with the publish scope.

import { resolveWebflowOAuthToken } from '../services/db.js';

const TAG = '[webflow-publish]';
const PUBLISH_URL = (siteId) => `https://api.webflow.com/v2/sites/${siteId}/publish`;
const SITE_URL = (siteId) => `https://api.webflow.com/v2/sites/${siteId}`;

// ── List publish targets for a site ──────────────────────────────────────────
//
//   GET /api/webflow/domains?siteId=<id>
//
// Returns the Webflow staging subdomain (*.webflow.io) and the site's custom
// domains so the app can let the user choose where to publish. Each custom
// domain `id` is what the publish endpoint's `customDomains` array expects.
export async function handleWebflowDomains(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  }

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId') || url.searchParams.get('site_id');
  if (!siteId) {
    return Response.json({ success: false, error: 'Missing siteId' }, { status: 400 });
  }

  const row = await resolveWebflowOAuthToken(db, env.WEBFLOW_AUTHENTICATION, siteId);
  if (!row?.accessToken) {
    return Response.json(
      { success: false, error: 'Site not authorized', code: 'NOT_AUTHORIZED' },
      { status: 401 }
    );
  }

  let res, data;
  try {
    res = await fetch(SITE_URL(siteId), {
      headers: { Authorization: `Bearer ${row.accessToken}`, Accept: 'application/json' },
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`${TAG} site fetch failed`, e?.message || e);
    return Response.json({ success: false, error: 'Failed to load site' }, { status: 502 });
  }

  if (!res.ok) {
    const wfMsg = data?.message || data?.code || `HTTP ${res.status}`;
    return Response.json(
      { success: false, error: `Webflow site lookup failed: ${wfMsg}`, webflowStatus: res.status },
      { status: res.status === 403 ? 403 : 502 }
    );
  }

  const customDomains = Array.isArray(data.customDomains)
    ? data.customDomains.map((d) => ({ id: d.id, url: d.url, lastPublished: d.lastPublished || null }))
    : [];
  const subdomain = data.shortName ? `${data.shortName}.webflow.io` : null;

  return Response.json({ success: true, subdomain, customDomains });
}

export async function handleWebflowPublish(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    console.error(`${TAG} CONSENT_WEBAPP D1 binding is missing`);
    return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const siteId = body.siteId || body.site_id;
  if (!siteId) {
    return Response.json({ success: false, error: 'Missing siteId' }, { status: 400 });
  }

  // Webflow requires at least one publish target. Default to the Webflow
  // subdomain so the test button works without naming custom domains.
  const customDomains = Array.isArray(body.customDomains) ? body.customDomains : [];
  const publishToWebflowSubdomain =
    body.publishToWebflowSubdomain ?? customDomains.length === 0;

  // ── Resolve the stored OAuth token for this site ────────────────────────────
  const row = await resolveWebflowOAuthToken(db, env.WEBFLOW_AUTHENTICATION, siteId);
  if (!row?.accessToken) {
    console.log(`${TAG} ${siteId} not authorized (no token in D1 or KV)`);
    return Response.json(
      { success: false, error: 'Site not authorized', code: 'NOT_AUTHORIZED' },
      { status: 401 }
    );
  }

  // ── Call Webflow's publish endpoint ─────────────────────────────────────────
  const payload = { publishToWebflowSubdomain };
  if (customDomains.length) payload.customDomains = customDomains;

  console.log(`${TAG} publishing ${siteId}`, {
    publishToWebflowSubdomain,
    customDomains: customDomains.length,
    source: row.source,
  });

  let res, data;
  try {
    res = await fetch(PUBLISH_URL(siteId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${row.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`${TAG} publish request failed`, e?.message || e);
    return Response.json({ success: false, error: 'Publish request failed' }, { status: 502 });
  }

  if (!res.ok) {
    // Surface Webflow's reason. A 403 here almost always means the token lacks
    // the `sites:write` scope → user must re-authorize.
    const wfMsg = data?.message || data?.msg || data?.code || `HTTP ${res.status}`;
    const needsReauth = res.status === 403 || /scope/i.test(String(wfMsg));
    console.warn(`${TAG} Webflow publish failed (HTTP ${res.status})`, data);
    return Response.json(
      {
        success: false,
        error: `Webflow publish failed: ${wfMsg}`,
        code: needsReauth ? 'MISSING_PUBLISH_SCOPE' : 'PUBLISH_FAILED',
        ...(needsReauth
          ? { hint: 'Re-authorize the app — the stored token is missing the sites:write scope.' }
          : {}),
        webflowStatus: res.status,
      },
      { status: res.status === 403 ? 403 : 502 }
    );
  }

  console.log(`${TAG} ✓ publish accepted for ${siteId}`, { httpStatus: res.status });
  return Response.json({ success: true, result: data });
}
