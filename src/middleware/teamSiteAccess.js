// src/middleware/teamSiteAccess.js
//
// Per-site gate for the web-app routes that key on a siteId but never checked who
// is asking (scan, cookies, scheduled scan, custom cookie rules, verify/mark-verified,
// banner customization).
//
// Who calls these routes, and how each is treated:
//   • Web app — through its server proxy, always with our sid cookie. Checked: the
//     session must be valid and the user must have a role on EVERY site the request
//     names. An expired session or a failed lookup is refused (it used to pass).
//   • Framer plugin — calls scan / cookies / scheduled-scan / custom-cookie-rules with
//     no cookie and no token. So a request WITHOUT a cookie is allowed only when every
//     site it names is a Framer site. Webflow and web-app sites need a login. (Framer
//     sites stay reachable without one until the plugin sends its JWT here.)
//   • Webflow Designer apps — use the /api/wf/* copies, which never reach this gate.
//   • cb-server (legacy Webflow backend) — calls /api/banner-customization server-to-
//     server with no auth, so that path keeps the old behaviour (LEGACY_OPEN_PATHS).
//
// Every siteId in the request is checked — query AND body, whatever the Content-Type
// (the handlers parse JSON regardless of it) — and delete-by-id calls are resolved to
// the site that owns the row, so neither can be used to slip past the check.
// Unknown siteIds pass through so the handler still returns its own 404.

import { getSessionById } from '../services/db.js';
import { getSiteRole, sidFromCookie } from '../services/team.js';

/** Routes that take a siteId and had no session/ownership check of their own. */
export const TEAM_GATED_PATHS = new Set([
  '/api/banner-customization',
  '/api/scan-site',
  '/api/scan-site-consented',
  '/api/scheduled-scan',
  '/api/scan-history',
  '/api/cookies',
  '/api/custom-cookie-rules',
  '/api/mark-verified',
  '/api/verify-script',
]);

/** Still answer cookie-less callers for any site (cb-server). Signed-in users are checked. */
const LEGACY_OPEN_PATHS = new Set(['/api/banner-customization']);

/** Every siteId the request names (query + body), plus the site behind a delete-by-id. */
async function readSiteIds(request, db) {
  const url = new URL(request.url);
  const ids = new Set();
  const add = (v) => { const s = v == null ? '' : String(v).trim(); if (s) ids.add(s); };
  add(url.searchParams.get('siteId'));
  add(url.searchParams.get('site_id'));

  let body = null;
  if (!['GET', 'HEAD'].includes(request.method)) {
    try { body = await request.clone().json(); } catch (_) { body = null; }
    add(body?.siteId);
    add(body?.site_id);
  }

  // Deletes name a row, not a site: DELETE ?id= (custom-cookie-rules, scheduled-scan)
  // and POST { action: 'delete', id } (custom-cookie-rules).
  const rowId = url.searchParams.get('id') || (body?.action === 'delete' ? body?.id : null);
  if (rowId && db) {
    const table = url.pathname === '/api/custom-cookie-rules' ? 'CustomCookieRule'
      : url.pathname === '/api/scheduled-scan' ? 'ScheduledScan' : null;
    if (table) {
      const row = await db.prepare(`SELECT siteId FROM ${table} WHERE id = ?1 LIMIT 1`).bind(String(rowId)).first();
      add(row?.siteId);
    }
  }
  return [...ids];
}

function deny(status, error, code) {
  return { ok: false, status, error, code };
}

/** { ok: true } or { ok: false, status, error, code }. */
export async function requireTeamSiteAccess(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return { ok: true };
  const pathname = new URL(request.url).pathname;
  const sid = sidFromCookie(request);

  // Old behaviour for the legacy-open path when there's no cookie.
  if (!sid && LEGACY_OPEN_PATHS.has(pathname)) return { ok: true };

  try {
    const siteIds = await readSiteIds(request, db);
    if (siteIds.length === 0) return { ok: true };

    if (sid) {
      const session = await getSessionById(db, sid);
      const userId = session?.userId ?? session?.user_id;
      if (!userId) return deny(401, 'Your session has expired. Please log in again.', 'LOGIN_REQUIRED');
      for (const siteId of siteIds) {
        if (await getSiteRole(db, userId, siteId)) continue;
        const exists = await db.prepare('SELECT 1 FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
        if (exists) return deny(403, 'You do not have access to this site.', 'SITE_ACCESS_DENIED');
      }
      return { ok: true };
    }

    // No cookie: only the Framer plugin calls these routes this way, and only for
    // Framer sites. legacySource || platform — platform alone can be demoted.
    for (const siteId of siteIds) {
      const site = await db
        .prepare('SELECT platform, legacySource FROM Site WHERE id = ?1 LIMIT 1')
        .bind(siteId)
        .first();
      if (!site) continue;
      const origin = String(site.legacySource || site.platform || '').toLowerCase();
      const isFramer = origin === 'framer' || String(site.platform || '').toLowerCase() === 'framer';
      if (!isFramer) {
        console.warn('[TeamSiteAccess] refused cookie-less request for a non-Framer site', { pathname, siteId });
        return deny(401, 'Please log in to manage this site.', 'LOGIN_REQUIRED');
      }
    }
    return { ok: true };
  } catch (err) {
    // Fail closed: allowing on error let any lookup failure bypass the check.
    console.warn('[TeamSiteAccess] check failed, refusing:', err?.message);
    return deny(503, 'Could not verify access to this site. Please try again.', 'ACCESS_CHECK_FAILED');
  }
}
