// src/handlers/adminDashboard/queries.js
//
// SQL logic for the admin dashboard, operating on the CONSENT_WEBAPP D1 binding.
// Pure functions — each takes the D1 database (env.CONSENT_WEBAPP) as first arg.
//
// The one exception is the cookie-checker data on the user detail, which lives
// in a separate database and is therefore passed in separately — see scans.js.

import {
  SITE_CHILD_TABLES,
  ORG_CHILD_TABLES,
  USER_CHILD_TABLES,
  EMAIL_KEYED_ROWS,
  normalizePlatform,
} from './schema.js';
import { listScansForEmail } from './scans.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

function derivePlatforms(concat) {
  if (!concat) return [];
  const set = new Set();
  for (const part of String(concat).split(',')) set.add(normalizePlatform(part.trim()));
  return [...set];
}

const KNOWN_TIERS = new Set(['free', 'basic', 'essential', 'growth']);

/** Distinct plan tiers from a GROUP_CONCAT of Subscription.planId. Empty → ['free']. */
function derivePlans(concat) {
  const set = new Set();
  if (concat) {
    for (const raw of String(concat).split(',')) {
      const v = raw.trim().toLowerCase();
      if (KNOWN_TIERS.has(v)) set.add(v);
    }
  }
  if (!set.size) set.add('free');
  return [...set];
}

/** Distinct subscription statuses; normalizes cancelled → canceled. */
function deriveStatuses(concat) {
  const set = new Set();
  if (concat) {
    for (const raw of String(concat).split(',')) {
      let v = raw.trim().toLowerCase();
      if (!v) continue;
      if (v === 'cancelled') v = 'canceled';
      set.add(v);
    }
  }
  return [...set];
}

/** "YYYY" / "MM" from a D1 datetime string like "2026-01-15 12:00:00". */
function yearOf(dt) {
  return dt ? String(dt).slice(0, 4) : '';
}
function monthOf(dt) {
  return dt ? String(dt).slice(5, 7) : '';
}

/** Internal (agency) email domains — these accounts are ours, not customers. */
const INTERNAL_DOMAINS = ['seattlenewmedia.com'];

/**
 * True when an email looks internal (agency domain) or like a test account.
 * Test heuristic: local-part is/starts-with "test", or contains a "+test" tag.
 */
export function isInternalOrTest(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e || !e.includes('@')) return false;
  const [local, domain] = e.split('@');
  if (INTERNAL_DOMAINS.includes(domain)) return true;
  if (local === 'test' || /^test[._+-]?/.test(local)) return true;
  if (local.includes('+test')) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* List users                                                         */
/* ------------------------------------------------------------------ */

export async function listUsers(
  db,
  { platform = 'all', search = '', plan = 'all', status = 'all', year = '', month = '', audience = 'all', billing = 'all' } = {}
) {
  const where = [];
  const params = [];

  if (search) {
    // Match on the user (email / name / id) OR any site they own (domain, custom
    // domain, staging URL, or site name).
    where.push(`(
      u.email LIKE ? OR u.name LIKE ? OR u.id = ?
      OR EXISTS (
        SELECT 1 FROM Site s
          JOIN Organization o ON s.organizationId = o.id
         WHERE o.ownerUserId = u.id
           AND (s.domain LIKE ? OR s.customDomain LIKE ? OR s.stagingUrl LIKE ? OR s.name LIKE ?)
      )
    )`);
    const like = `%${search}%`;
    params.push(like, like, search, like, like, like, like);
  }

  const sql = `
    SELECT
      u.id, u.email, u.name, u.createdAt, u.updatedAt,
      (SELECT COUNT(*) FROM Organization o WHERE o.ownerUserId = u.id) AS orgCount,
      (SELECT COUNT(*) FROM Site s
         JOIN Organization o ON s.organizationId = o.id
        WHERE o.ownerUserId = u.id) AS siteCount,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(NULLIF(s.platform,''),'webapp'))
         FROM Site s JOIN Organization o ON s.organizationId = o.id
        WHERE o.ownerUserId = u.id) AS platforms,
      (SELECT GROUP_CONCAT(DISTINCT sub.planId)
         FROM Subscription sub JOIN Organization o ON sub.organizationId = o.id
        WHERE o.ownerUserId = u.id) AS plans,
      (SELECT GROUP_CONCAT(DISTINCT sub.status)
         FROM Subscription sub JOIN Organization o ON sub.organizationId = o.id
        WHERE o.ownerUserId = u.id) AS statuses
    FROM User u
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY u.createdAt DESC
    LIMIT 2000
  `;

  const { results = [] } = await db.prepare(sql).bind(...params).all();

  let mapped = results.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    orgCount: Number(r.orgCount) || 0,
    siteCount: Number(r.siteCount) || 0,
    platforms: derivePlatforms(r.platforms),
    plans: derivePlans(r.plans),
    statuses: deriveStatuses(r.statuses),
    internal: isInternalOrTest(r.email),
  }));

  if (audience === 'external') {
    mapped = mapped.filter((u) => !u.internal);
  } else if (audience === 'internal') {
    mapped = mapped.filter((u) => u.internal);
  }

  if (platform && platform !== 'all') {
    if (platform === 'webapp') {
      // "webapp" bucket: users with a webapp site OR no sites at all (pure app signups).
      mapped = mapped.filter((u) => u.platforms.includes('webapp') || u.platforms.length === 0);
    } else {
      mapped = mapped.filter((u) => u.platforms.includes(platform));
    }
  }

  // Free vs paid. derivePlans() falls back to ['free'] when a user has no
  // subscription, so "paid" means at least one tier that isn't 'free'.
  if (billing === 'free') {
    mapped = mapped.filter((u) => !u.plans.some((p) => p !== 'free'));
  } else if (billing === 'paid') {
    mapped = mapped.filter((u) => u.plans.some((p) => p !== 'free'));
  }

  if (plan && plan !== 'all') {
    mapped = mapped.filter((u) => u.plans.includes(plan));
  }

  // `status` is a comma-separated list ("trialing,active"); a user matches if ANY
  // of their subscription statuses is in it. A single value still works, so old
  // links keep filtering the way they always did.
  const wantedStatuses = new Set(
    String(status || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== 'all')
      .map((s) => (s === 'cancelled' ? 'canceled' : s))
  );
  if (wantedStatuses.size) {
    mapped = mapped.filter((u) => u.statuses.some((s) => wantedStatuses.has(s)));
  }

  if (year) {
    mapped = mapped.filter((u) => yearOf(u.createdAt) === String(year));
  }

  if (month) {
    const mm = String(month).padStart(2, '0');
    mapped = mapped.filter((u) => monthOf(u.createdAt) === mm);
  }

  return mapped;
}

/* ------------------------------------------------------------------ */
/* List sites                                                         */
/* ------------------------------------------------------------------ */

/**
 * Which regulation a site's banner actually runs under.
 *
 * This CANNOT be read from banner_type alone. bannerCustomization.js writes the
 * pair, and "GDPR only" and "GDPR + CCPA" share banner_type='gdpr':
 *
 *   gdpr only        → banner_type='gdpr', region_mode='gdpr'
 *   gdpr + us        → banner_type='gdpr', region_mode='both'   (CDN routes by country)
 *   us only          → banner_type='ccpa', region_mode='ccpa'
 *   IAB TCF          → banner_type='iab'   (region_mode is still written, but the
 *                                           CDN short-circuits region routing for
 *                                           IAB — see cdnNm.js `if (!siteWantsIab)`)
 *
 * Precedence below mirrors that CDN logic exactly, so the dashboard never claims
 * a regulation the visitor would not actually be served.
 */
export function deriveRegulation(bannerType, regionMode) {
  const bt = String(bannerType || 'gdpr').toLowerCase();
  const rm = String(regionMode || 'gdpr').toLowerCase();
  if (bt === 'iab') return 'iab';
  if (rm === 'both') return 'both';
  if (rm === 'ccpa' || bt === 'ccpa') return 'ccpa';
  return 'gdpr';
}

/**
 * SQL for the same four buckets, so the regulation filter is applied before the
 * LIMIT rather than to an already-truncated page.
 */
const REGULATION_SQL = {
  iab: `lower(COALESCE(s.banner_type,'gdpr')) = 'iab'`,
  both: `lower(COALESCE(s.banner_type,'gdpr')) != 'iab'
         AND lower(COALESCE(s.region_mode,'gdpr')) = 'both'`,
  ccpa: `lower(COALESCE(s.banner_type,'gdpr')) != 'iab'
         AND lower(COALESCE(s.region_mode,'gdpr')) != 'both'
         AND (lower(COALESCE(s.region_mode,'gdpr')) = 'ccpa'
              OR lower(COALESCE(s.banner_type,'gdpr')) = 'ccpa')`,
  gdpr: `lower(COALESCE(s.banner_type,'gdpr')) NOT IN ('iab','ccpa')
         AND lower(COALESCE(s.region_mode,'gdpr')) NOT IN ('both','ccpa')`,
};

/**
 * Site-level list with the owning organization and user attached.
 *
 * `banner` filters on Site.verified — the script having been detected on the
 * live domain. That is deliberately stricter than "a BannerCustomization row
 * exists": Webflow free registration seeds a default customization row at
 * signup, so that row proves a banner was created, not that one is running.
 *
 *   banner: 'live'     verified = 1  — banner confirmed on the domain
 *           'not-live' verified = 0  — registered, never confirmed
 */
export async function listSites(
  db,
  {
    search = '', platform = 'all', banner = 'all', regulation = 'all',
    year = '', month = '', audience = 'all', limit,
  } = {}
) {
  const where = [];
  const params = [];

  if (regulation && regulation !== 'all' && REGULATION_SQL[regulation]) {
    where.push(`(${REGULATION_SQL[regulation]})`);
  }

  if (search) {
    where.push(`(s.domain LIKE ? OR s.name LIKE ? OR s.id = ? OR u.email LIKE ? OR o.name LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, search, like, like);
  }

  if (banner === 'live') {
    where.push('COALESCE(s.verified, 0) = 1');
  } else if (banner === 'not-live') {
    where.push('COALESCE(s.verified, 0) = 0');
  }

  // Sliced from the stored timestamp, matching yearOf()/monthOf(). Applied in
  // SQL so the LIMIT below caps the filtered set, not the other way round.
  if (year) {
    where.push('substr(s.createdAt, 1, 4) = ?');
    params.push(String(year));
  }
  if (month) {
    where.push('substr(s.createdAt, 6, 2) = ?');
    params.push(String(month).padStart(2, '0'));
  }

  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const sql = `
    SELECT
      s.id, s.name, s.domain, s.platform, s.verified, s.verified_at, s.createdAt,
      s.banner_type, s.region_mode,
      s.isLegacy, s.legacySource, s.organizationId,
      o.name AS orgName,
      u.id AS ownerId, u.email AS ownerEmail,
      EXISTS (SELECT 1 FROM BannerCustomization b WHERE b.siteId = s.id) AS hasCustomization
    FROM Site s
    LEFT JOIN Organization o ON s.organizationId = o.id
    LEFT JOIN User u ON o.ownerUserId = u.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.createdAt DESC
    LIMIT ${cap}
  `;

  const { results = [] } = await db.prepare(sql).bind(...params).all();

  let mapped = results.map((r) => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    platform: normalizePlatform(r.platform),
    rawPlatform: r.platform ?? null,
    verified: Number(r.verified) || 0,
    verifiedAt: r.verified_at ?? null,
    createdAt: r.createdAt,
    bannerType: r.banner_type ?? null,
    regionMode: r.region_mode ?? null,
    regulation: deriveRegulation(r.banner_type, r.region_mode),
    isLegacy: Number(r.isLegacy) || 0,
    legacySource: r.legacySource ?? null,
    organizationId: r.organizationId,
    orgName: r.orgName ?? null,
    ownerId: r.ownerId ?? null,
    ownerEmail: r.ownerEmail ?? null,
    hasCustomization: Number(r.hasCustomization) === 1,
    internal: isInternalOrTest(r.ownerEmail),
  }));

  // Platform is normalized in JS (a NULL/'' platform means webapp), so it can
  // only be filtered after mapping — same rule as listUsers.
  if (platform && platform !== 'all') {
    mapped = mapped.filter((s) => s.platform === platform);
  }
  if (audience === 'external') {
    mapped = mapped.filter((s) => !s.internal);
  } else if (audience === 'internal') {
    mapped = mapped.filter((s) => s.internal);
  }

  return mapped;
}

/** Counters + the years that actually contain sites, for the filter bar. */
export async function getSiteStats(db) {
  const [total, live, customized, years] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS c FROM Site`).first(),
    db.prepare(`SELECT COUNT(*) AS c FROM Site WHERE COALESCE(verified, 0) = 1`).first(),
    db.prepare(`SELECT COUNT(DISTINCT siteId) AS c FROM BannerCustomization`).first(),
    db
      .prepare(
        `SELECT DISTINCT substr(createdAt, 1, 4) AS y
           FROM Site
          WHERE createdAt IS NOT NULL AND length(createdAt) >= 4
          ORDER BY y DESC`
      )
      .all(),
  ]);

  return {
    totalSites: Number(total?.c) || 0,
    bannerLive: Number(live?.c) || 0,
    bannerConfigured: Number(customized?.c) || 0,
    years: (years?.results ?? []).map((r) => String(r.y)).filter((y) => /^\d{4}$/.test(y)),
  };
}

/* ------------------------------------------------------------------ */
/* Stats                                                              */
/* ------------------------------------------------------------------ */

export async function getStats(db) {
  const users = await listUsers(db, { platform: 'all' });
  const { results: siteAgg = [] } = await db
    .prepare(`SELECT COALESCE(NULLIF(platform,''),'webapp') AS p, COUNT(*) AS c FROM Site GROUP BY p`)
    .all();

  const usersByPlatform = { webflow: 0, framer: 0, webapp: 0 };
  for (const u of users) {
    if (u.platforms.includes('webflow')) usersByPlatform.webflow++;
    if (u.platforms.includes('framer')) usersByPlatform.framer++;
    if (u.platforms.includes('webapp') || u.platforms.length === 0) usersByPlatform.webapp++;
  }

  const sitesByPlatform = { webflow: 0, framer: 0, webapp: 0 };
  let totalSites = 0;
  for (const row of siteAgg) {
    const p = normalizePlatform(row.p);
    sitesByPlatform[p] = (sitesByPlatform[p] || 0) + Number(row.c);
    totalSites += Number(row.c);
  }

  return {
    totalUsers: users.length,
    totalSites,
    usersByPlatform,
    sitesByPlatform,
  };
}

/* ------------------------------------------------------------------ */
/* User detail                                                        */
/* ------------------------------------------------------------------ */

/**
 * billingEmail was added to User by a later ALTER, so a database that has not
 * run that migration would fail the whole detail view on an unknown column.
 * Fall back to the pre-migration shape rather than 500.
 */
async function selectUserRow(db, userId) {
  try {
    return await db
      .prepare(`SELECT id, email, name, billingEmail, createdAt, updatedAt FROM User WHERE id = ?`)
      .bind(userId)
      .first();
  } catch (_) {
    return await db
      .prepare(`SELECT id, email, name, createdAt, updatedAt FROM User WHERE id = ?`)
      .bind(userId)
      .first();
  }
}

/**
 * @param {D1Database}  db         consent-webapp
 * @param {string}      userId
 * @param {D1Database} [scannerDb] cookie-scanner-db, for claimed cookie-checker
 *                                 scans. A separate D1 instance, so this is a
 *                                 second query keyed on email, not a join.
 */
export async function getUserDetail(db, userId, scannerDb = null) {
  const user = await selectUserRow(db, userId);
  if (!user) return null;

  const { results: orgs = [] } = await db
    .prepare(`SELECT id, name, createdAt FROM Organization WHERE ownerUserId = ? ORDER BY createdAt DESC`)
    .bind(userId)
    .all();

  const organizations = [];
  const allPlatforms = new Set();
  let siteCount = 0;

  for (const org of orgs) {
    const { results: sites = [] } = await db
      .prepare(
        `SELECT id, name, domain, platform, verified, isLegacy, legacySource, createdAt,
                banner_type, region_mode
           FROM Site WHERE organizationId = ? ORDER BY createdAt DESC`
      )
      .bind(org.id)
      .all();

    const siteRows = sites.map((s) => {
      const p = normalizePlatform(s.platform);
      allPlatforms.add(p);
      return {
        id: s.id,
        name: s.name,
        domain: s.domain,
        platform: p,
        rawPlatform: s.platform ?? null,
        verified: Number(s.verified) || 0,
        isLegacy: Number(s.isLegacy) || 0,
        legacySource: s.legacySource ?? null,
        createdAt: s.createdAt,
        bannerType: s.banner_type ?? null,
        regionMode: s.region_mode ?? null,
        regulation: deriveRegulation(s.banner_type, s.region_mode),
      };
    });
    siteCount += siteRows.length;

    const { results: subscriptions = [] } = await db
      .prepare(
        `SELECT id, stripeSubscriptionId, planType, interval, status,
                currentPeriodEnd, cancelAtPeriodEnd, amountCents, licenseKey, createdAt
           FROM Subscription WHERE organizationId = ? ORDER BY createdAt DESC`
      )
      .bind(org.id)
      .all();

    organizations.push({
      id: org.id,
      name: org.name,
      createdAt: org.createdAt,
      sites: siteRows,
      subscriptions,
    });
  }

  const { results: memberOf = [] } = await db
    .prepare(`SELECT organizationId, role, joinedAt FROM OrganizationMember WHERE userId = ?`)
    .bind(userId)
    .all();

  const sessionRow = await db
    .prepare(`SELECT COUNT(*) AS c FROM Session WHERE userId = ?`)
    .bind(userId)
    .first();

  let feedback = [];
  try {
    const r = await db
      .prepare(`SELECT id, message, createdAt FROM Feedback WHERE userId = ? ORDER BY createdAt DESC LIMIT 50`)
      .bind(userId)
      .all();
    feedback = r.results ?? [];
  } catch (_) {
    feedback = [];
  }

  // Cookie-checker scans this person claimed by verifying their email. Empty
  // for anyone who never came in through the scanner landing page, and for every
  // scan run before claim capture shipped.
  const scans = scannerDb ? await listScansForEmail(scannerDb, user.email) : [];

  return {
    id: user.id,
    email: user.email,
    // Null when the customer never set one — Stripe then bills the account email.
    billingEmail: user.billingEmail ?? null,
    scans,
    name: user.name,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    orgCount: orgs.length,
    siteCount,
    platforms: [...allPlatforms],
    organizations,
    memberOf,
    sessionCount: Number(sessionRow?.c) || 0,
    feedback,
  };
}

/* ------------------------------------------------------------------ */
/* Update user                                                        */
/* ------------------------------------------------------------------ */

export async function updateUser(db, userId, fields) {
  const existing = await db.prepare(`SELECT id FROM User WHERE id = ?`).bind(userId).first();
  if (!existing) return { ok: false, error: 'User not found' };

  if (fields.email !== undefined) {
    const email = String(fields.email).trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, error: 'Invalid email address' };
    }
    const clash = await db
      .prepare(`SELECT id FROM User WHERE email = ? AND id != ?`)
      .bind(email, userId)
      .first();
    if (clash) return { ok: false, error: 'Another user already uses that email' };
  }

  const sets = [];
  const params = [];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    params.push(fields.name);
  }
  if (fields.email !== undefined) {
    sets.push('email = ?');
    params.push(String(fields.email).trim().toLowerCase());
  }
  if (!sets.length) return { ok: true };

  sets.push('updatedAt = CURRENT_TIMESTAMP');
  params.push(userId);
  await db.prepare(`UPDATE User SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Delete user everywhere (cascade)                                   */
/* ------------------------------------------------------------------ */

export async function deleteUserEverywhere(db, userId) {
  const deleted = {};
  const errors = [];
  const bump = (t, n) => (deleted[t] = (deleted[t] || 0) + n);
  const fail = (m) => errors.push(m);

  const user = await db.prepare(`SELECT id, email FROM User WHERE id = ?`).bind(userId).first();
  if (!user) return { ok: false, deleted, error: 'User not found' };

  // 1. Collect owned organizations and their sites.
  const { results: orgs = [] } = await db
    .prepare(`SELECT id FROM Organization WHERE ownerUserId = ?`)
    .bind(userId)
    .all();
  const orgIds = orgs.map((o) => o.id);

  let siteIds = [];
  if (orgIds.length) {
    const { results: sites = [] } = await db
      .prepare(`SELECT id FROM Site WHERE organizationId IN (${placeholders(orgIds)})`)
      .bind(...orgIds)
      .all();
    siteIds = sites.map((s) => s.id);
  }

  // 2. Site children (deepest first), then the sites.
  if (siteIds.length) {
    for (const table of SITE_CHILD_TABLES) {
      bump(table, await delIn(db, table, 'siteId', siteIds, fail));
    }
    await deleteWebflowOAuthForSites(db, siteIds, bump, fail);
    bump('Site', await delIn(db, 'Site', 'id', siteIds, fail));
  }

  // 3. Organization children + orgs themselves.
  if (orgIds.length) {
    for (const table of ORG_CHILD_TABLES) {
      bump(table, await delIn(db, table, 'organizationId', orgIds, fail));
    }
    bump('Organization', await delIn(db, 'Organization', 'id', orgIds, fail));
  }

  // 4. Memberships where this user is a MEMBER of someone else's org.
  bump('OrganizationMember', await delEq(db, 'OrganizationMember', 'userId', userId, fail));

  // 5. Direct user children.
  for (const table of USER_CHILD_TABLES) {
    bump(table, await delEq(db, table, 'userId', userId, fail));
  }

  // 6. Email-keyed rows (the User row still exists, so user.email is valid here).
  if (user.email) {
    for (const { table, columns } of EMAIL_KEYED_ROWS) {
      for (const column of columns) {
        bump(table, await delEq(db, table, column, user.email, fail));
      }
    }
  }

  // 7. The user itself — last, so every referencing row is gone first.
  bump('User', await delEq(db, 'User', 'id', userId, fail));

  // 8. Prove it. Foreign keys are enforced in D1, so a row still pointing at this
  //    user would make the delete above fail; never report success on a user that
  //    is still in the table.
  const survivor = await db.prepare(`SELECT id FROM User WHERE id = ?`).bind(userId).first();
  if (survivor) {
    return {
      ok: false,
      deleted,
      errors,
      error:
        `Related data was removed, but the user record could not be deleted` +
        (errors.length ? `: ${errors[0]}` : '. Another table still references this user.'),
    };
  }

  return { ok: true, deleted, errors };
}

/**
 * Remove the Webflow OAuth records tied to the given sites.
 *
 * WebflowOAuthSite is keyed by siteId; the access token itself lives in
 * WebflowOAuthToken keyed by the *Webflow* user id (userKey), which several sites
 * can share. So a token row is dropped only once no WebflowOAuthSite row still
 * points at it — never yanking credentials out from under someone else's site.
 */
async function deleteWebflowOAuthForSites(db, siteIds, bump, onError) {
  if (!siteIds.length) return;

  let userKeys = [];
  try {
    const { results = [] } = await db
      .prepare(
        `SELECT DISTINCT userKey FROM WebflowOAuthSite
          WHERE siteId IN (${placeholders(siteIds)}) AND userKey IS NOT NULL`
      )
      .bind(...siteIds)
      .all();
    userKeys = results.map((r) => r.userKey).filter(Boolean);
  } catch (_) {
    return; // table absent in this DB
  }

  bump('WebflowOAuthSite', await delIn(db, 'WebflowOAuthSite', 'siteId', siteIds, onError));

  for (const key of userKeys) {
    try {
      const stillUsed = await db
        .prepare(`SELECT COUNT(*) AS c FROM WebflowOAuthSite WHERE userKey = ?`)
        .bind(key)
        .first();
      if ((Number(stillUsed?.c) || 0) > 0) continue;
      bump('WebflowOAuthToken', await delEq(db, 'WebflowOAuthToken', 'userKey', key, onError));
    } catch (_) {
      /* leave the token in place if we can't prove it's orphaned */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Delete specific sites (and their child rows)                       */
/* ------------------------------------------------------------------ */

export async function deleteSites(db, siteIds) {
  const deleted = {};
  const errors = [];
  const bump = (t, n) => (deleted[t] = (deleted[t] || 0) + n);
  const fail = (m) => errors.push(m);

  const ids = (siteIds || []).map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) return { ok: false, deleted, error: 'No site ids provided' };

  // Only touch sites that actually exist; report which ones.
  const { results = [] } = await db
    .prepare(`SELECT id, domain, name FROM Site WHERE id IN (${placeholders(ids)})`)
    .bind(...ids)
    .all();
  const validIds = results.map((r) => r.id);
  if (!validIds.length) return { ok: false, deleted, error: 'No matching sites found' };

  // Child rows first, then the Site rows. Subscriptions/Organizations are left
  // intact — deleting a site does NOT cancel org-level billing.
  for (const table of SITE_CHILD_TABLES) {
    bump(table, await delIn(db, table, 'siteId', validIds, fail));
  }
  await deleteWebflowOAuthForSites(db, validIds, bump, fail);
  bump('Site', await delIn(db, 'Site', 'id', validIds, fail));

  const survivors = await db
    .prepare(`SELECT COUNT(*) AS c FROM Site WHERE id IN (${placeholders(validIds)})`)
    .bind(...validIds)
    .first();
  if ((Number(survivors?.c) || 0) > 0) {
    return {
      ok: false,
      deleted,
      errors,
      sites: results,
      error:
        `Child data was removed, but ${survivors.c} site row(s) could not be deleted` +
        (errors.length ? `: ${errors[0]}` : '.'),
    };
  }

  return { ok: true, deleted, errors, sites: results };
}

/* ---- delete helpers ------------------------------------------------ */
//
// Counts come from D1's meta.changes, i.e. rows ACTUALLY deleted — never from a
// pre-flight COUNT(*), which would report success for a delete that then failed.
// A missing table is ignored (databases differ); any other failure is recorded
// via onError so the caller can report it instead of silently swallowing it.

function isMissingTable(err) {
  return /no such table/i.test(String(err?.message || err));
}

async function delIn(db, table, col, ids, onError) {
  if (!ids.length) return 0;
  try {
    const res = await db
      .prepare(`DELETE FROM ${table} WHERE ${col} IN (${placeholders(ids)})`)
      .bind(...ids)
      .run();
    return Number(res?.meta?.changes) || 0;
  } catch (err) {
    if (!isMissingTable(err)) onError?.(`${table}.${col}: ${err?.message || err}`);
    return 0;
  }
}

async function delEq(db, table, col, val, onError) {
  try {
    const res = await db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).bind(val).run();
    return Number(res?.meta?.changes) || 0;
  } catch (err) {
    if (!isMissingTable(err)) onError?.(`${table}.${col}: ${err?.message || err}`);
    return 0;
  }
}
