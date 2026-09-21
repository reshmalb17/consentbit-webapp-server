// src/middleware/teamSiteAccess.js
//
// Per-site gate for the web-app routes that key on a siteId but never checked who
// is asking (scan, cookies, scheduled scan, custom cookie rules, verify/mark-verified,
// banner customization). Needed now that a team member may see only some sites.
//
// SCOPE — deliberately narrow so nothing that works today changes:
//   • Only requests that carry a VALID web-app session (sid cookie) are checked.
//     No cookie → passes through exactly as before. That keeps the public callers
//     working: CDN scripts on customer sites, the Framer plugin, and the legacy
//     Webflow paths never send our sid cookie.
//   • Only when a siteId is present (query, or JSON body on writes).
//   • Unknown siteId → passes through, so the handler still returns its own 404.
//   • Applied at the router, not in the handlers: the /api/wf/* copies reuse the
//     same handlers with a Webflow ID token and must not see this check.
//
// This makes the dashboard enforce per-site access. It does not close the older
// gap that these routes answer anyone who omits the cookie — that is unchanged.

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

async function readSiteId(request) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get('siteId') || url.searchParams.get('site_id');
  if (fromQuery) return String(fromQuery).trim();
  if (['GET', 'HEAD'].includes(request.method)) return null;
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) return null;
  try {
    const body = await request.clone().json();
    const id = body?.siteId ?? body?.site_id;
    return id ? String(id).trim() : null;
  } catch (_) {
    return null;
  }
}

/** { ok: true } or { ok: false, status, error, code }. */
export async function requireTeamSiteAccess(request, env) {
  const db = env.CONSENT_WEBAPP;
  const sid = sidFromCookie(request);
  if (!db || !sid) return { ok: true };

  const siteId = await readSiteId(request);
  if (!siteId) return { ok: true };

  try {
    const session = await getSessionById(db, sid);
    const userId = session?.userId ?? session?.user_id;
    if (!userId) return { ok: true }; // expired/stale cookie — behave as before

    if (await getSiteRole(db, userId, siteId)) return { ok: true };

    const exists = await db.prepare('SELECT 1 FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
    if (!exists) return { ok: true };

    return {
      ok: false,
      status: 403,
      error: 'You do not have access to this site.',
      code: 'SITE_ACCESS_DENIED',
    };
  } catch (err) {
    // A failed lookup must not take the dashboard down; log and fall back to the
    // pre-team behaviour for this request.
    console.warn('[TeamSiteAccess] check failed, allowing:', err?.message);
    return { ok: true };
  }
}
