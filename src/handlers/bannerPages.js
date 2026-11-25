// src/handlers/bannerPages.js
// GET  /api/sites/banner-pages?siteId=…        → { paths, mode } for one site
// GET  /api/sites/banner-pages?siteIds=a,b,c   → { pages: { [siteId]: { paths, mode } } } (only sites with paths)
// POST /api/sites/banner-pages                 → { siteId, paths: ['/privacy', '/landing/*'], mode: 'hide' | 'off' }
//                                                empty paths = banner on every page again.
//
// "Disable banner on specific pages" (Profile → Advanced settings). Two behaviours:
//   hide — banner + floating button hidden on those pages; blocking still runs and a choice
//          the visitor already made still applies (compliant; e.g. the privacy policy page)
//   off  — the ConsentBit script stops before doing anything on those pages: no banner and
//          NOTHING blocked (trackers there run without consent; for pages the script breaks)
// The server cannot see the page path (cross-site script requests send only the origin), so
// the served script carries a small guard that checks location.pathname — data/skipPaths.js.
//
// Stored as optional Site columns (added here on first use; nothing existing changes):
//   bannerHiddenPaths (JSON array), bannerHiddenMode ('hide' | 'off'),
//   bannerHiddenPaused ('1' = switched off: pages kept but not applied; data/skipPaths.js)
// POST may carry `paused: true|false`; leaving it out keeps the current value.

import { ensureSchema, getSessionById, getUserById, getSiteById } from '../services/db.js';
import { getSiteRole } from '../services/team.js';
import { resolveEffectivePlanId } from './bannerCustomization.js';

export const BANNER_PAGE_MODES = new Set(['hide', 'off']);
export const BANNER_PAGES_PLANS = ['growth'];
const MAX_PATHS = 50;
const MAX_PATH_LEN = 200;
const MAX_IDS = 200;

let columnsReady = false;
export async function ensureBannerPageColumns(db) {
  if (columnsReady) return;
  for (const col of ['bannerHiddenPaths', 'bannerHiddenMode', 'bannerHiddenPaused']) {
    try {
      await db.prepare(`ALTER TABLE Site ADD COLUMN ${col} TEXT`).run();
    } catch (_) { /* column already exists */ }
  }
  columnsReady = true;
}

/** One entry as typed → '/path' or '/path/*' (lower-case, no trailing slash), or null + reason. */
export function cleanBannerPath(raw) {
  let s = String(raw || '').trim();
  if (!s) return { path: null, reason: 'empty' };
  // Full URL pasted → keep the path only.
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname || '/'; } catch { return { path: null, reason: 'invalid' }; }
  }
  s = s.split(/[?#]/)[0].toLowerCase();
  if (!s.startsWith('/')) s = '/' + s;
  const wildcard = s.endsWith('*');
  if (wildcard) s = s.slice(0, -1);
  if (s.includes('*')) return { path: null, reason: 'star' }; // only one trailing *
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (!/^\/[a-z0-9\-._~%/@!$&'()+,;=:]*$/.test(s)) return { path: null, reason: 'invalid' };
  if (wildcard && s === '/') return { path: null, reason: 'all' }; // every page = no banner at all
  const path = wildcard ? `${s}/*` : s;
  if (path.length > MAX_PATH_LEN) return { path: null, reason: 'long' };
  return { path, reason: null };
}

/** Site row → { paths, mode } (empty paths when unset or unreadable). */
export function bannerPagesOf(site) {
  let paths = [];
  try {
    const v = JSON.parse(site?.bannerHiddenPaths ?? site?.bannerhiddenpaths ?? 'null');
    if (Array.isArray(v)) paths = [...new Set(v.map((p) => cleanBannerPath(p).path).filter(Boolean))].slice(0, MAX_PATHS);
  } catch (_) { /* bad JSON → none */ }
  const m = site?.bannerHiddenMode ?? site?.bannerhiddenmode;
  const paused = paths.length > 0 && String(site?.bannerHiddenPaused ?? site?.bannerhiddenpaused ?? '') === '1';
  return { paths, mode: BANNER_PAGE_MODES.has(m) ? m : 'hide', paused };
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

const isAdminRole = (r) => r === 'owner' || r === 'admin';
const json = (body, status = 200) => Response.json(body, { status });

export async function handleBannerPages(request, env) {
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
  await ensureBannerPageColumns(db);

  const url = new URL(request.url);

  // ── GET summary for a list of sites (only those with paths) ───────────────
  if (request.method === 'GET' && url.searchParams.has('siteIds')) {
    const ids = [...new Set(String(url.searchParams.get('siteIds') || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
    const pages = {};
    if (ids.length) {
      const marks = ids.map((_, i) => `?${i + 1}`).join(',');
      const { results = [] } = await db
        .prepare(`SELECT id, bannerHiddenPaths, bannerHiddenMode, bannerHiddenPaused FROM Site WHERE id IN (${marks}) AND bannerHiddenPaths IS NOT NULL`)
        .bind(...ids)
        .all();
      for (const r of results) {
        const v = bannerPagesOf(r);
        if (!v.paths.length) continue;
        if (!(await getSiteRole(db, user.id, String(r.id)).catch(() => null))) continue; // caller can't see it
        pages[String(r.id)] = v;
      }
    }
    return json({ success: true, pages });
  }

  const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
  const siteId = String(request.method === 'POST' ? body?.siteId ?? '' : url.searchParams.get('siteId') ?? '').trim();
  if (!siteId) return json({ success: false, error: 'siteId is required' }, 400);
  const site = await getSiteById(db, siteId);
  if (!site) return json({ success: false, error: 'Site not found' }, 404);
  if (!isAdminRole(await getSiteRole(db, user.id, siteId).catch(() => null))) {
    return json({ success: false, error: 'Only the account owner or a site Admin can change this.', code: 'NOT_ADMIN' }, 403);
  }

  // Growth feature (decided 2026-11-24). Clearing the list is allowed on any plan.
  const plan = (await resolveEffectivePlanId(db, env, siteId).catch(() => null)) || 'free';
  const planOk = BANNER_PAGES_PLANS.includes(plan);

  if (request.method === 'GET') return json({ success: true, siteId, ...bannerPagesOf(site), plan, planOk, requiredPlan: 'growth' });

  // ── POST: save ────────────────────────────────────────────────────────────
  if (!body) return json({ success: false, error: 'Invalid JSON body' }, 400);
  const mode = String(body.mode || 'hide');
  if (!BANNER_PAGE_MODES.has(mode)) {
    return json({ success: false, code: 'BAD_MODE', error: 'mode must be hide or off' }, 400);
  }
  const raw = (Array.isArray(body.paths) ? body.paths : []).map((p) => String(p || '').trim()).filter(Boolean);
  const bad = [];
  const paths = [];
  for (const r of raw) {
    const { path, reason } = cleanBannerPath(r);
    if (!path) bad.push({ path: r, reason });
    else if (!paths.includes(path)) paths.push(path);
  }
  if (bad.length) {
    return json({
      success: false,
      code: 'INVALID_PATHS',
      error: bad.some((b) => b.reason === 'all')
        ? '/* would hide the banner on every page. List the pages instead, for example /privacy-policy or /landing/*.'
        : `Not a valid page path: ${bad.map((b) => b.path).join(', ')}. Use a path like /privacy-policy or /landing/*.`,
      problems: bad,
    }, 400);
  }
  // paused: true/false sets it; absent keeps what is stored. No pages → nothing to pause.
  const paused = paths.length > 0 && (typeof body.paused === 'boolean' ? body.paused : bannerPagesOf(site).paused);
  // Pausing (switching the section off) is allowed on any plan, like clearing.
  if (paths.length && !paused && !planOk) {
    return json({
      success: false,
      code: 'PLAN_REQUIRED',
      requiredPlan: 'growth',
      error: `Disabling the banner on specific pages is available on the Growth plan. This site is on ${plan}.`,
    }, 403);
  }
  if (paths.length > MAX_PATHS) {
    return json({ success: false, code: 'TOO_MANY', error: `You can add up to ${MAX_PATHS} pages.` }, 400);
  }

  await db
    .prepare(`UPDATE Site SET bannerHiddenPaths = ?2, bannerHiddenMode = ?3, bannerHiddenPaused = ?4 WHERE id = ?1`)
    .bind(siteId, paths.length ? JSON.stringify(paths) : null, paths.length ? mode : null, paused ? '1' : null)
    .run();
  console.log('[BannerPages] saved', { siteId, mode, paused, paths: paths.length, by: user.id });
  return json({ success: true, siteId, ...bannerPagesOf(await getSiteById(db, siteId)), plan, planOk, requiredPlan: 'growth' });
}
