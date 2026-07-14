// src/middleware/webflowIdentity.js
//
// Authentication for the Webflow Designer Extension API surface (/api/wf/*).
//
// The extension attaches, on every call:
//   • Authorization: Bearer <idToken>   — an ID token minted by the Designer API
//                                          (`await webflow.getIdToken()`).
//   • X-Webflow-Site-Id: <webflowSiteId>— the Webflow site the user is currently in.
//
// This middleware:
//   1. Reads the ID token and the Webflow site id.
//   2. Looks up THAT site's stored app (Data Client) OAuth token. Webflow's
//      "Resolve ID Token" endpoint only accepts the app token belonging to the
//      same site the ID token was minted for, so the site token is required.
//   3. Resolves the ID token — POST https://api.webflow.com/beta/token/resolve —
//      and ENFORCES that the resolved siteId equals the claimed Webflow site id.
//   4. Authorizes the request's DATA target (query/body siteId — which may be the
//      internal CONSENT_WEBAPP Site.id) by requiring it to belong to that Webflow
//      site (ownedSiteIds).
//
// Result: knowing a siteId is not enough. The ID token is signed by Webflow and
// bound to the user's live Designer session on that specific site; it cannot be
// forged, and it cannot be used to reach another installation's data.

import { resolveWebflowOAuthToken } from '../services/db.js';

const TAG = '[webflow-identity]';

const RESOLVE_URL = 'https://api.webflow.com/beta/token/resolve';

/** Pull the Bearer ID token out of the Authorization header (or null). */
function extractIdToken(request) {
  const h = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve the request's DATA target siteId. GET/HEAD/DELETE read the query string;
 * other methods read the JSON body from a CLONE (so the real handler still gets an
 * unconsumed body). Accepts the id field names used across endpoints.
 */
async function extractSiteId(request) {
  const url = new URL(request.url);
  const fromQuery =
    url.searchParams.get('siteId') ||
    url.searchParams.get('site_id') ||
    url.searchParams.get('wfSiteId') ||
    url.searchParams.get('platformId');
  if (fromQuery) return fromQuery;

  if (['GET', 'HEAD', 'DELETE'].includes(request.method)) return null;

  try {
    const body = await request.clone().json();
    return body?.siteId || body?.site_id || body?.wfSiteId || body?.platformId || null;
  } catch {
    return null;
  }
}

/**
 * Call Webflow's Resolve ID Token endpoint with the given app token. Returns the
 * resolved user { id, email, firstName, lastName, siteId } or null.
 */
async function resolveIdToken(appToken, idToken) {
  try {
    const res = await fetch(RESOLVE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      console.warn(`${TAG} resolve returned HTTP ${res.status}`);
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    console.warn(`${TAG} resolve fetch error (non-fatal)`, e?.message || e);
    return null;
  }
}

/**
 * The set of site ids the authenticated Webflow site "owns": the Webflow site id
 * itself PLUS every internal CONSENT_WEBAPP Site.id whose platformSiteId is that
 * Webflow site. Endpoints receive either form (launch/status use the Webflow id;
 * scan/consent/customization use the internal id), so a requested id is authorized
 * iff it is in this set.
 */
async function ownedSiteIds(env, webflowSiteId) {
  const set = new Set([String(webflowSiteId)]);
  try {
    const rows = await env.CONSENT_WEBAPP
      .prepare('SELECT id FROM Site WHERE platformSiteId = ?1')
      .bind(webflowSiteId)
      .all();
    for (const r of rows?.results || []) {
      if (r?.id != null) set.add(String(r.id));
    }
  } catch (e) {
    console.warn(`${TAG} ownedSiteIds lookup failed (non-fatal)`, e?.message || e);
  }
  return set;
}

/**
 * Gate a /api/wf/* request. Returns:
 *   { ok: true,  identity: { userId, email, webflowSiteId, siteId, unverified? } }
 *   { ok: false, status, code, error }
 *
 * opts.allowUnauthorizedSite — when true (used only by oauth/status), a site with
 * no stored OAuth token is allowed through as `unverified` instead of rejected, so
 * the status endpoint can still answer "authorized:false" for a not-yet-authorized
 * site. Such a site has no stored data, so nothing sensitive can leak.
 */
export async function requireWebflowIdentity(request, env, opts = {}) {
  const { allowUnauthorizedSite = false } = opts;
  const db = env.CONSENT_WEBAPP;

  const idToken = extractIdToken(request);
  if (!idToken) {
    return { ok: false, status: 401, code: 'MISSING_ID_TOKEN', error: 'Missing Webflow ID token.' };
  }

  // The Webflow site the user is in. Prefer the explicit header; fall back to the
  // request's siteId (the launch/status calls pass the Webflow id directly).
  const headerSiteId = request.headers.get('X-Webflow-Site-Id') || request.headers.get('x-webflow-site-id') || null;
  const requestSiteId = await extractSiteId(request);
  const webflowSiteId = headerSiteId || requestSiteId;
  if (!webflowSiteId) {
    return { ok: false, status: 400, code: 'MISSING_SITE_ID', error: 'Missing Webflow site id.' };
  }
  const target = requestSiteId || webflowSiteId;

  // The app token for THIS Webflow site — the only token Webflow will accept to
  // resolve an ID token minted for it.
  const row = await resolveWebflowOAuthToken(db, env.WEBFLOW_AUTHENTICATION, webflowSiteId);
  if (!row?.accessToken) {
    if (allowUnauthorizedSite) {
      // Not authorized yet → no data exists. Let status report authorized:false.
      return { ok: true, identity: { userId: null, email: null, webflowSiteId: String(webflowSiteId), siteId: String(target), unverified: true } };
    }
    console.warn(`${TAG} no app token for site ${webflowSiteId} — cannot authorize`);
    return { ok: false, status: 401, code: 'SITE_NOT_AUTHORIZED', error: 'Site is not authorized.' };
  }

  const resolved = await resolveIdToken(row.accessToken, idToken);
  if (!resolved?.siteId) {
    console.warn(`${TAG} ID token did not resolve for site ${webflowSiteId}`);
    return { ok: false, status: 401, code: 'INVALID_ID_TOKEN', error: 'Invalid or expired Webflow ID token.' };
  }

  // The ID token must have been minted for the site the caller claims to be in.
  if (String(resolved.siteId) !== String(webflowSiteId)) {
    console.warn(`${TAG} token/site mismatch: token=${resolved.siteId} claimed=${webflowSiteId} — denying`);
    return { ok: false, status: 403, code: 'SITE_FORBIDDEN', error: 'Not authorized for this site.' };
  }

  // The data target (may be an internal Site.id) must belong to that Webflow site.
  const owned = await ownedSiteIds(env, webflowSiteId);
  if (!owned.has(String(target))) {
    console.warn(`${TAG} target not owned: site=${webflowSiteId} target=${target} — denying`);
    return { ok: false, status: 403, code: 'SITE_FORBIDDEN', error: 'Not authorized for this resource.' };
  }

  console.log(`${TAG} ✓ authorized — webflowSite=${webflowSiteId} target=${target} user=${resolved.email || resolved.id || '?'}`);
  return {
    ok: true,
    identity: {
      userId: resolved.id || null,
      email: resolved.email ? String(resolved.email).trim().toLowerCase() : null,
      webflowSiteId: String(webflowSiteId),
      siteId: String(target),
    },
  };
}
