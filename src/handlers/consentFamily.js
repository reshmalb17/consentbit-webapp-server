// src/handlers/consentFamily.js
// GET  /api/sites/consent-family?siteId=…        → cross-domain consent dialog state for one site
// GET  /api/sites/consent-family?siteIds=a,b,c   → link badges for a list of sites
// POST /api/sites/consent-family                 → { siteId, siteIds: [...], direction: 'one_way' | 'two_way' }
//                                                  siteId = primary; empty siteIds = stop sharing.
//
// Cross-domain consent, Captain Compliance style: each subdomain is its OWN site in the
// account (own row, own script). The owner opens the dialog on one site (the primary);
// it lists the account's other sites on the same main domain as checkboxes. Linked sites
// form a "family". The banner script will later keep one shared choice in a cookie on
// the main domain (.example.com); the direction decides who may write it:
//   one_way — only the primary writes; linked sites read it and keep their own overrides
//   two_way — any linked site writes; the newest choice applies everywhere
// Subdomains of one main domain share one cookie on it. Sites on a DIFFERENT main domain
// (example.com / example-store.com) can be linked too (2026-11-24): browsers never let them
// read each other's cookies, so the banner hands the choice over on links between them
// (consentShareBridge.js xhosts; cdnTest only).
//
// Who can link: a site joins only if it belongs to the same account as the primary
// (its organisation shares an owner with the primary's) AND the caller is owner or site
// Admin of it. A site belongs to one family at most.
//
// Stored as three optional Site columns (added here on first use; nothing existing changes),
// written on EVERY family member including the primary:
//   consentSharePrimaryId (primary's Site.id; = own id on the primary), consentShareRoot,
//   consentShareDirection
// The banner settings are served with Cache-Control: no-store, so there is no cache to clear.

import {
  ensureSchema,
  getSessionById,
  getUserById,
  getSiteById,
  normalizeDomain,
} from '../services/db.js';
import { getSiteRole } from '../services/team.js';
import { resolveEffectivePlanId } from './bannerCustomization.js';

const DIRECTIONS = new Set(['one_way', 'two_way']);
// Cross-domain consent is a Growth feature (decided 2026-11-24, refined 2026-11-25):
//   one-way: the main domain must be on Growth; linked sites may be on any plan.
//   two-way: the main domain and every linked site must be on Growth.
//   main domain leaves Growth → sharing stops for the whole group (cdnTest serves no bridge).
//   a linked site leaves Growth under two-way → that site falls back to one-way (receive only).
// Stopping sharing is allowed on any plan.
export const CROSS_DOMAIN_PLANS = ['growth'];
const planOk = (planId) => CROSS_DOMAIN_PLANS.includes(String(planId || '').toLowerCase());
const MAX_LINKED = 10;
const MAX_BADGE_IDS = 200;

// Two-label public suffixes: the main domain of shop.example.co.uk is example.co.uk.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.za', 'org.za', 'gov.za', 'web.za',
  'com.sg', 'org.sg', 'edu.sg', 'gov.sg', 'net.sg',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.tr', 'org.tr', 'net.tr', 'gen.tr',
  'com.ar', 'org.ar', 'net.ar', 'gob.ar',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr',
  'com.my', 'org.my', 'net.my', 'gov.my',
  'com.ph', 'org.ph', 'net.ph', 'gov.ph',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.pk', 'org.pk', 'net.pk',
  'com.ng', 'org.ng', 'gov.ng',
  'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
  'com.tw', 'org.tw', 'net.tw', 'gov.tw',
  'com.vn', 'net.vn', 'org.vn',
  'com.co', 'net.co', 'org.co',
  'com.pe', 'org.pe', 'com.ec', 'com.uy', 'com.ve', 'com.bo', 'com.py',
  'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
  'com.eg', 'com.sa', 'com.qa', 'com.kw', 'com.bh', 'com.om', 'co.ae',
  'com.ua', 'org.ua', 'co.ke', 'or.ke', 'co.tz', 'co.ug',
  'com.es', 'org.es', 'nom.es', 'com.pt', 'com.pl', 'net.pl', 'org.pl',
  'co.at', 'or.at', 'gv.at', 'com.gr', 'com.cy', 'com.mt',
]);

// Builder / hosting domains where every customer gets a subdomain. Browsers treat these as
// public suffixes too, so foo.webflow.io and bar.webflow.io can never share a cookie.
const PLATFORM_SUFFIXES = [
  'webflow.io', 'framer.website', 'framer.app', 'framer.media', 'framer.ai', 'framercanvas.com',
  'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'github.io', 'gitlab.io',
  'herokuapp.com', 'onrender.com', 'fly.dev', 'web.app', 'firebaseapp.com',
  'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amplifyapp.com',
  'wixsite.com', 'wixstudio.io', 'myshopify.com', 'squarespace.com', 'wordpress.com',
  'wpengine.com', 'wpenginepowered.com', 'blogspot.com', 'hs-sites.com', 'hubspotpagebuilder.com',
  'webnode.page', 'carrd.co', 'glitch.me', 'repl.co', 'replit.app', 'surge.sh', 'ngrok.io', 'ngrok-free.app',
  'myftpupload.com', 'godaddysites.com', 'weebly.com', 'jimdosite.com', 'strikingly.com', 'notion.site',
];

/** Host → { root } for its main domain, or { root: null, reason } when it can't share. */
export function mainDomainOf(rawHost) {
  const host = normalizeDomain(rawHost);
  if (!host || !host.includes('.')) return { host, root: null, reason: 'invalid' };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return { host, root: null, reason: 'ip' };
  for (const sfx of PLATFORM_SUFFIXES) {
    if (host === sfx || host.endsWith(`.${sfx}`)) return { host, root: null, reason: 'platform', platform: sfx };
  }
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return { host, root: null, reason: 'invalid' };
  return { host, root: labels.slice(-take).join('.') };
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

let columnsReady = false;
async function ensureShareColumns(db) {
  if (columnsReady) return;
  // consentShareNotice ('0' = off; anything else = on) and consentShareListUrl live on the primary.
  for (const col of ['consentSharePrimaryId', 'consentShareRoot', 'consentShareDirection', 'consentShareNotice', 'consentShareListUrl']) {
    try {
      await db.prepare(`ALTER TABLE Site ADD COLUMN ${col} TEXT`).run();
    } catch (_) { /* column already exists */ }
  }
  columnsReady = true;
}

const primaryOf = (s) => String(s?.consentSharePrimaryId ?? s?.consentshareprimaryid ?? '') || null;
const directionOf = (s) => {
  const d = s?.consentShareDirection ?? s?.consentsharedirection;
  return DIRECTIONS.has(d) ? d : 'one_way';
};
const isAdminRole = (r) => r === 'owner' || r === 'admin';
const noticeOf = (s) => String(s?.consentShareNotice ?? s?.consentsharenotice ?? '') !== '0';
const listUrlOf = (s) => {
  const u = String(s?.consentShareListUrl ?? s?.consentsharelisturl ?? '').trim();
  return /^https:\/\/[^\s"<>]+\.[^\s"<>]+$/i.test(u) && u.length <= 500 ? u : '';
};

/**
 * Every site in the same account as `site`: sites whose organisation shares an owner
 * (OrganizationMember) with the site's organisation. Most accounts have one organisation
 * per site, so "same organisation" alone would find nothing.
 */
async function accountSites(db, site) {
  const { results = [] } = await db
    .prepare(
      `SELECT s.id, s.domain, s.name, s.consentSharePrimaryId, s.consentShareDirection
         FROM Site s
        WHERE s.organizationId IN (
                SELECT om2.organizationId FROM OrganizationMember om2
                 WHERE om2.userId IN (SELECT om.userId FROM OrganizationMember om WHERE om.organizationId = ?1)
              )
          AND s.id != ?2`,
    )
    .bind(String(site.organizationId ?? site.organizationid ?? ''), String(site.id))
    .all();
  return results;
}

/** Ids of sites that other sites point to as their primary. */
async function primaryIdsIn(db, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results = [] } = await db
    .prepare(`SELECT DISTINCT consentSharePrimaryId AS p FROM Site WHERE consentSharePrimaryId IN (${marks}) AND id != consentSharePrimaryId`)
    .bind(...ids)
    .all();
  return new Set(results.map((r) => String(r.p ?? r.P ?? '')));
}

/**
 * "Last sync" for a linked site: when a visitor's choice was last carried over to it (the bridge
 * logs those as consentMethod 'shared'). Looks only at the site's newest 5000 records so a busy
 * site never scans its whole history (uses idx_consent_site_created). Null when none / on error.
 */
async function lastSharedAt(db, siteId) {
  try {
    const row = await db
      .prepare(
        `SELECT MAX(createdAt) AS t FROM (
           SELECT createdAt, consentMethod FROM Consent WHERE siteId = ?1 ORDER BY createdAt DESC LIMIT 5000
         ) WHERE consentMethod = 'shared'`,
      )
      .bind(siteId)
      .first();
    return row?.t ?? null;
  } catch (_) {
    return null;
  }
}

/** Dialog state for the site the dialog is opened on. */
async function buildState(db, userId, site, env) {
  const { host, root, reason, platform } = mainDomainOf(site.domain);
  const siteId = String(site.id);
  const myPrimary = primaryOf(site);
  const sitePlan = (await resolveEffectivePlanId(db, env, siteId).catch(() => null)) || 'free';
  const base = {
    success: true,
    requiredPlan: 'growth',
    site: { id: siteId, domain: site.domain, host, plan: sitePlan, planOk: planOk(sitePlan) },
    mainDomain: root,
    supported: !!root,
    reason: root ? null : reason,
    platform: platform || null,
    memberOf: null,
    direction: myPrimary === siteId ? directionOf(site) : null,
    showList: noticeOf(site),
    listUrl: listUrlOf(site),
    candidates: [],
  };

  // Linked to another site's family: changes are made from that site.
  if (myPrimary && myPrimary !== siteId) {
    const p = await getSiteById(db, myPrimary);
    base.memberOf = p ? { id: String(p.id), domain: p.domain, direction: directionOf(p) } : { id: myPrimary, domain: null };
    return base;
  }
  if (!root) return base;

  // Subdomains (same main domain: share one cookie) AND other domains (different main domain:
  // consent travels with the visitor on links between them, see consentShareBridge.js xhosts).
  const same = (await accountSites(db, site)).filter((s) => {
    const m = mainDomainOf(s.domain);
    return !!m.root && m.host !== host;
  });
  const primaries = await primaryIdsIn(db, same.map((s) => String(s.id)));
  const byId = new Map(same.map((s) => [String(s.id), s]));

  const candidates = [];
  for (const s of same) {
    const id = String(s.id);
    const p = primaryOf(s);
    const role = await getSiteRole(db, userId, id).catch(() => null);
    const plan = (await resolveEffectivePlanId(db, env, id).catch(() => null)) || 'free';
    const m = mainDomainOf(s.domain);
    let linkedElsewhere = null;
    if (p && p !== siteId) {
      linkedElsewhere = p === id ? 'primary' : byId.get(p)?.domain || 'another site';
    } else if (!p && primaries.has(id)) {
      linkedElsewhere = 'primary';
    }
    candidates.push({
      id,
      domain: s.domain,
      name: s.name || null,
      host: normalizeDomain(s.domain),
      root: m.root,
      sameRoot: m.root === root,
      linked: p === siteId,
      linkedElsewhere, // 'primary' = it has its own family; a domain = linked to that site
      canAdmin: isAdminRole(role),
      plan,
      planOk: planOk(plan),
      lastSharedAt: p === siteId ? await lastSharedAt(db, id) : null,
    });
  }
  candidates.sort((a, b) => (a.sameRoot === b.sameRoot ? a.host.localeCompare(b.host) : a.sameRoot ? -1 : 1));
  base.candidates = candidates;
  return base;
}

/**
 * What the banner script needs to share consent (cdnTest.js → consentShareBridge.js), or null
 * when the site is in no family. Cheap for the common case: no query unless the site row
 * already points at a primary.
 */
export async function consentShareForBanner(db, site) {
  const p = primaryOf(site);
  const root = site?.consentShareRoot ?? site?.consentshareroot;
  if (!p || !root) return null;
  const { results = [] } = await db
    .prepare(`SELECT * FROM Site WHERE consentSharePrimaryId = ?1`) // * : notice columns may not exist yet
    .bind(p)
    .all();
  const primary = results.find((r) => String(r.id) === p);
  if (!primary || results.length < 2) return null; // half-written or emptied family
  const myRoot = String(root).toLowerCase();
  return {
    primaryId: p,
    primary, // row, so cdnTest can check the main domain's plan for linked sites
    isPrimary: String(site.id) === p,
    root: myRoot,
    direction: directionOf(primary),
    showList: noticeOf(primary),
    listUrl: listUrlOf(primary),
    hosts: results.map((r) => normalizeDomain(r.domain)).filter(Boolean),
    // Family members on a DIFFERENT main domain: no shared cookie reaches them, so the bridge
    // hands the choice over on links to these hosts (cdnTest only).
    xhosts: results
      .filter((r) => String(r.consentShareRoot ?? r.consentshareroot ?? '').toLowerCase() !== myRoot)
      .map((r) => normalizeDomain(r.domain))
      .filter(Boolean),
  };
}

/** Badges for the site list: { [siteId]: { role, primaryId, primaryDomain, direction, linkedCount } }. */
async function buildBadges(db, userId, ids) {
  const links = {};
  if (!ids.length) return links;
  const marks = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results: rows = [] } = await db
    .prepare(`SELECT id, domain, consentSharePrimaryId, consentShareDirection FROM Site WHERE id IN (${marks}) AND consentSharePrimaryId IS NOT NULL`)
    .bind(...ids)
    .all();
  if (!rows.length) return links;

  const primaryIds = [...new Set(rows.map(primaryOf).filter(Boolean))];
  const pm = primaryIds.map((_, i) => `?${i + 1}`).join(',');
  const { results: fam = [] } = await db
    .prepare(`SELECT id, domain, consentSharePrimaryId, consentShareDirection FROM Site WHERE consentSharePrimaryId IN (${pm})`)
    .bind(...primaryIds)
    .all();
  const primaryRow = new Map(fam.filter((r) => String(r.id) === primaryOf(r)).map((r) => [String(r.id), r]));
  const count = new Map();
  for (const r of fam) if (String(r.id) !== primaryOf(r)) count.set(primaryOf(r), (count.get(primaryOf(r)) || 0) + 1);

  for (const r of rows) {
    const id = String(r.id);
    if (!(await getSiteRole(db, userId, id).catch(() => null))) continue; // caller can't see it
    const p = primaryOf(r);
    const pr = primaryRow.get(p);
    if (!pr || !count.get(p)) continue; // half-written family: show nothing
    links[id] = {
      role: id === p ? 'primary' : 'member',
      primaryId: p,
      primaryDomain: pr.domain,
      direction: directionOf(pr),
      linkedCount: count.get(p),
    };
  }
  return links;
}

const json = (body, status = 200) => Response.json(body, { status });

export async function handleConsentFamily(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) return json({ success: false, error: 'Not authenticated' }, 401);
  const session = await getSessionById(db, sid);
  if (!session) return json({ success: false, error: 'Not authenticated' }, 401);
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) return json({ success: false, error: 'Not authenticated' }, 401);

  await ensureSchema(db);
  await ensureShareColumns(db);

  const url = new URL(request.url);

  // ── GET badges for a list of sites ────────────────────────────────────────
  if (request.method === 'GET' && url.searchParams.has('siteIds')) {
    const ids = [...new Set(String(url.searchParams.get('siteIds') || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_BADGE_IDS);
    return json({ success: true, links: await buildBadges(db, user.id, ids) });
  }

  const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
  const siteId = String(request.method === 'POST' ? body?.siteId ?? '' : url.searchParams.get('siteId') ?? '').trim();
  if (!siteId) return json({ success: false, error: 'siteId is required' }, 400);

  const site = await getSiteById(db, siteId);
  if (!site) return json({ success: false, error: 'Site not found' }, 404);
  if (!isAdminRole(await getSiteRole(db, user.id, siteId).catch(() => null))) {
    return json({ success: false, error: 'Only the account owner or a site Admin can change cross-domain consent.', code: 'NOT_ADMIN' }, 403);
  }

  if (request.method === 'GET') return json(await buildState(db, user.id, site, env));

  // ── POST: save or stop sharing (siteId is the primary) ────────────────────
  if (!body) return json({ success: false, error: 'Invalid JSON body' }, 400);
  const direction = String(body.direction || 'one_way');
  if (!DIRECTIONS.has(direction)) {
    return json({ success: false, error: 'direction must be one_way or two_way', code: 'BAD_DIRECTION' }, 400);
  }
  // Section 4 settings (optional in the body; omitted = keep what is stored).
  if (body.listUrl != null && String(body.listUrl).trim() && !listUrlOf({ consentShareListUrl: body.listUrl })) {
    return json({ success: false, code: 'BAD_LIST_URL', error: 'Enter a full link starting with https://' }, 400);
  }
  const noticeUpd = [];
  if (typeof body.showList === 'boolean') noticeUpd.push(['consentShareNotice', body.showList ? '1' : '0']);
  if (body.listUrl != null) noticeUpd.push(['consentShareListUrl', listUrlOf({ consentShareListUrl: body.listUrl }) || null]);
  const saveNotice = noticeUpd.length
    ? db
        .prepare(`UPDATE Site SET ${noticeUpd.map(([c], i) => `${c} = ?${i + 2}`).join(', ')} WHERE id = ?1`)
        .bind(siteId, ...noticeUpd.map(([, v]) => v))
    : null;
  const wanted = [...new Set((Array.isArray(body.siteIds) ? body.siteIds : []).map((s) => String(s || '').trim()).filter(Boolean))];

  const myPrimary = primaryOf(site);
  if (myPrimary && myPrimary !== siteId) {
    return json({ success: false, code: 'IS_MEMBER', error: 'This site is linked to another site. Change the link from that site.' }, 409);
  }

  const clearOthers = db
    .prepare(`UPDATE Site SET consentSharePrimaryId = NULL, consentShareRoot = NULL, consentShareDirection = NULL WHERE consentSharePrimaryId = ?1`)
    .bind(siteId);

  if (!wanted.length) {
    await clearOthers.run();
    if (saveNotice) await saveNotice.run();
    console.log('[ConsentShare] stopped', { siteId, by: user.id });
    return json(await buildState(db, user.id, await getSiteById(db, siteId), env));
  }
  if (wanted.length > MAX_LINKED) {
    return json({ success: false, code: 'TOO_MANY', error: `You can link up to ${MAX_LINKED} domains.` }, 400);
  }

  const state = await buildState(db, user.id, site, env);
  if (!state.supported) {
    return json({
      success: false,
      code: 'UNSUPPORTED_DOMAIN',
      error: state.reason === 'platform'
        ? 'Sites on a builder address (for example webflow.io or framer.app) cannot share consent. Use a custom domain.'
        : 'This site’s address cannot share consent.',
    }, 400);
  }
  if (!state.site.planOk) {
    return json({
      success: false,
      code: 'PLAN_REQUIRED',
      requiredPlan: 'growth',
      error: `Cross-domain consent is available on the Growth plan. ${state.site.host} is on ${state.site.plan}.`,
    }, 403);
  }
  const cand = new Map(state.candidates.map((c) => [c.id, c]));
  const problems = [];
  for (const id of wanted) {
    const c = cand.get(id);
    if (!c) problems.push({ id, message: `${id} is not a site in this account` });
    else if (c.linkedElsewhere === 'primary') problems.push({ id, message: `${c.host} has its own linked domains` });
    else if (c.linkedElsewhere) problems.push({ id, message: `${c.host} is already linked to ${c.linkedElsewhere}` });
    else if (!c.canAdmin) problems.push({ id, message: `you are not an Admin of ${c.host}` });
    // Plan rule (2026-11-25): one-way → only the main domain needs Growth, linked sites any plan;
    // two-way → every linked site needs Growth too (it writes the shared choice).
    else if (direction === 'two_way' && !c.planOk) problems.push({ id, message: `${c.host} needs the Growth plan for two-way sharing (it is on ${c.plan})` });
  }
  if (problems.length) {
    return json({ success: false, code: 'INVALID_SITES', error: problems.map((p) => p.message).join('. ') + '.', problems }, 400);
  }

  // consentShareRoot = each member's OWN main domain (the cookie lives there); for a subdomain
  // that is the primary's, for an "other domain" its own.
  const setRow = (id, rowRoot) =>
    db
      .prepare(`UPDATE Site SET consentSharePrimaryId = ?2, consentShareRoot = ?3, consentShareDirection = ?4 WHERE id = ?1`)
      .bind(id, siteId, rowRoot, direction);
  await db.batch([
    clearOthers,
    ...(saveNotice ? [saveNotice] : []),
    setRow(siteId, state.mainDomain),
    ...wanted.map((id) => setRow(id, cand.get(id).root || state.mainDomain)),
  ]);

  console.log('[ConsentShare] saved', { siteId, root: state.mainDomain, direction, linked: wanted.length, by: user.id });
  return json(await buildState(db, user.id, await getSiteById(db, siteId), env));
}
