// src/handlers/bannerStatus.js
// GET  /api/sites/banner-status?siteIds=a,b,c  → { disabled: { [siteId]: disabledAt } } (only disabled sites)
// POST /api/sites/banner-status                → { siteId, enabled: true | false }
//
// "Banner display status" (Profile → Advanced settings), like CookieYes: the owner can switch
// a site's ConsentBit script off to test and debug. While disabled the script still loads but
// does nothing — no banner, no blocking — see cdnTest.js. Switching it back on restores it on
// the next page load.
//
// Stored as one optional Site column, added here on first use (nothing existing changes):
//   bannerDisabledAt — ISO time it was switched off; NULL = enabled.

import { ensureSchema, getSessionById, getUserById, getSiteById } from '../services/db.js';
import { getSiteRole } from '../services/team.js';

const MAX_IDS = 200;

let columnReady = false;
export async function ensureBannerStatusColumn(db) {
  if (columnReady) return;
  try {
    await db.prepare('ALTER TABLE Site ADD COLUMN bannerDisabledAt TEXT').run();
  } catch (_) { /* column already exists */ }
  columnReady = true;
}

/** Site row → true when the owner switched the banner off. */
export function siteBannerDisabled(site) {
  return !!(site?.bannerDisabledAt ?? site?.bannerdisabledat);
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

const isAdminRole = (r) => r === 'owner' || r === 'admin';
const json = (body, status = 200) => Response.json(body, { status });

export async function handleBannerStatus(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) return json({ success: false, error: 'Not authenticated' }, 401);
  const session = await getSessionById(db, sid);
  if (!session) return json({ success: false, error: 'Not authenticated' }, 401);
  const user = await getUserById(db, session.userId ?? session.user_id);
  if (!user) return json({ success: false, error: 'Not authenticated' }, 401);

  await ensureSchema(db);
  await ensureBannerStatusColumn(db);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const ids = [...new Set(String(url.searchParams.get('siteIds') || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
    const disabled = {};
    if (ids.length) {
      const marks = ids.map((_, i) => `?${i + 1}`).join(',');
      const { results = [] } = await db
        .prepare(`SELECT id, bannerDisabledAt FROM Site WHERE id IN (${marks}) AND bannerDisabledAt IS NOT NULL`)
        .bind(...ids)
        .all();
      for (const r of results) {
        if (!(await getSiteRole(db, user.id, String(r.id)).catch(() => null))) continue; // caller can't see it
        disabled[String(r.id)] = r.bannerDisabledAt ?? r.bannerdisabledat;
      }
    }
    return json({ success: true, disabled });
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ success: false, error: 'Invalid JSON body' }, 400);
  const siteId = String(body.siteId ?? '').trim();
  if (!siteId) return json({ success: false, error: 'siteId is required' }, 400);
  if (typeof body.enabled !== 'boolean') return json({ success: false, error: 'enabled must be true or false' }, 400);

  const site = await getSiteById(db, siteId);
  if (!site) return json({ success: false, error: 'Site not found' }, 404);
  if (!isAdminRole(await getSiteRole(db, user.id, siteId).catch(() => null))) {
    return json({ success: false, error: 'Only the account owner or a site Admin can change this.', code: 'NOT_ADMIN' }, 403);
  }

  const disabledAt = body.enabled ? null : (siteBannerDisabled(site) ? (site.bannerDisabledAt ?? site.bannerdisabledat) : new Date().toISOString());
  await db.prepare('UPDATE Site SET bannerDisabledAt = ?2 WHERE id = ?1').bind(siteId, disabledAt).run();
  console.log('[BannerStatus]', body.enabled ? 'enabled' : 'disabled', { siteId, by: user.id });
  return json({ success: true, siteId, enabled: !disabledAt, disabledAt });
}
