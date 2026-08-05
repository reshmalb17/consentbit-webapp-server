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
  { platform = 'all', search = '', plan = 'all', status = 'all', year = '', month = '', audience = 'all', billing = 'all', legacy = 'all' } = {}
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
      COALESCE(u.isLegacy, 0) AS isLegacy,
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
    // Migrated off the old Webflow/Framer system, as opposed to signing up in the
    // current app. Distinct from `internal`, which is about OUR own test accounts.
    isLegacy: Number(r.isLegacy) || 0,
    internal: isInternalOrTest(r.email),
  }));

  if (legacy === 'legacy') {
    mapped = mapped.filter((u) => u.isLegacy === 1);
  } else if (legacy === 'new') {
    mapped = mapped.filter((u) => u.isLegacy !== 1);
  }

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

  /**
   * `plan` and `status` are comma-separated lists ("basic,growth"); a user
   * matches if ANY of their values is in the list. A single value still works,
   * so old links keep filtering the way they always did.
   */
  function wanted(raw, normalize) {
    return new Set(
      String(raw || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && s !== 'all')
        .map(normalize || ((s) => s))
    );
  }

  const wantedPlans = wanted(plan);
  if (wantedPlans.size) {
    mapped = mapped.filter((u) => u.plans.some((p) => wantedPlans.has(p)));
  }

  const wantedStatuses = wanted(status, (s) => (s === 'cancelled' ? 'canceled' : s));
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
    year = '', month = '', audience = 'all', plan = 'all', legacy = 'all', limit,
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

  // Applied in SQL, like the other stored-column filters, so the LIMIT caps the
  // filtered set rather than filtering an already-truncated page.
  if (legacy === 'legacy') {
    where.push('COALESCE(s.isLegacy, 0) = 1');
  } else if (legacy === 'new') {
    where.push('COALESCE(s.isLegacy, 0) = 0');
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
      EXISTS (SELECT 1 FROM BannerCustomization b WHERE b.siteId = s.id) AS hasCustomization,
      -- The subscription currently governing THIS site: one pinned to it by
      -- siteId wins, otherwise the organization's, preferring a live status over
      -- a cancelled one and the newest row as the tie-break. Tier and status come
      -- back as one packed value so they can never be read off different rows.
      (SELECT COALESCE(sub.planId, '') || '|' || COALESCE(sub.status, '')
         FROM Subscription sub
        WHERE sub.organizationId = s.organizationId
          AND (sub.siteId IS NULL OR sub.siteId = '' OR sub.siteId = s.id)
        ORDER BY
          -- "Pinned to this site" expressed with inner columns only: SQLite
          -- rejects an outer reference (s.id) inside a subquery's ORDER BY. The
          -- WHERE above already limits siteId to NULL/''/s.id, so "siteId is set"
          -- means exactly "pinned to this site".
          CASE WHEN sub.siteId IS NULL OR sub.siteId = '' THEN 1 ELSE 0 END,
          CASE LOWER(COALESCE(sub.status, ''))
            WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
          sub.createdAt DESC
        LIMIT 1) AS planCurrent
    FROM Site s
    LEFT JOIN Organization o ON s.organizationId = o.id
    LEFT JOIN User u ON o.ownerUserId = u.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.createdAt DESC
    LIMIT ${cap}
  `;

  const { results = [] } = await db.prepare(sql).bind(...params).all();

  let mapped = results.map((r) => {
    // "tier|status" from the subquery above. No subscription row at all means the
    // site is on the free plan, which is the same fallback derivePlans() uses.
    const [rawPlan = '', rawStatus = ''] = String(r.planCurrent || '').split('|');
    const tier = rawPlan.trim().toLowerCase();
    return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    plan: KNOWN_TIERS.has(tier) ? tier : 'free',
    planStatus: rawStatus.trim().toLowerCase() === 'cancelled'
      ? 'canceled'
      : (rawStatus.trim().toLowerCase() || null),
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
    };
  });

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

  // Comma-separated list, matching the users page — plan is derived above, so
  // like platform it can only be filtered after mapping.
  const wantedPlans = new Set(
    String(plan || '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => p && p !== 'all')
  );
  if (wantedPlans.size) {
    mapped = mapped.filter((s) => wantedPlans.has(s.plan));
  }

  return mapped;
}

/* ------------------------------------------------------------------ */
/* Usage tracking                                                     */
/* ------------------------------------------------------------------ */
//
// Two metered resources, both counted per site per calendar month (UTC):
//   ScanUsage(siteId, yearMonth, scanCount)
//   PageviewUsage(siteId, yearMonth, pageviewCount)
//
// The allowance comes from the Plan row for the site's tier — the SAME source
// handlers/billing.js reads, so what the operator sees here matches what the
// customer sees in the app. A site with no subscription is on 'free', and the
// free fallbacks (100 scans / 7,500 pageviews) mirror the literals in
// billing.js, scanSite.js and pageview.js for the case where the Plan row is
// somehow missing.
//
// Site.scanLimitNotifiedMonth is set by the scheduled-scan job when it emails a
// site's owner about the scan cap; equal to the month being viewed, it means
// "we have already warned them this month".

const FREE_FALLBACK = { scans: 100, pageviews: 7500 };

/** Current calendar month as YYYY-MM, matching db.js's usage getters (UTC). */
export function currentYearMonth(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** tier -> { scans, pageviews } from the Plan table, with the free fallback. */
async function planAllowances(db) {
  const out = new Map();
  try {
    const { results = [] } = await db
      .prepare(`SELECT id, scansIncluded, pageviewsIncluded FROM Plan`)
      .all();
    for (const p of results) {
      out.set(String(p.id).toLowerCase(), {
        scans: Number(p.scansIncluded ?? 0),
        pageviews: Number(p.pageviewsIncluded ?? 0),
      });
    }
  } catch (_) {
    /* table missing — every tier falls back below */
  }
  if (!out.has('free')) out.set('free', { ...FREE_FALLBACK });
  return out;
}

/** Percentage used, capped for display. A zero/absent limit reads as unlimited. */
function pct(used, limit) {
  if (!limit || limit <= 0) return null;
  return Math.round((used / limit) * 100);
}

export async function listUsage(
  db,
  {
    search = '', platform = 'all', plan = 'all', legacy = 'all', audience = 'all',
    state = 'all', month = '', limit,
  } = {}
) {
  const yearMonth = /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : currentYearMonth();

  const where = [];
  const params = [yearMonth, yearMonth];

  if (search) {
    where.push(`(s.domain LIKE ? OR s.name LIKE ? OR s.id = ? OR u.email LIKE ? OR o.name LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, search, like, like);
  }
  if (legacy === 'legacy') where.push('COALESCE(s.isLegacy, 0) = 1');
  else if (legacy === 'new') where.push('COALESCE(s.isLegacy, 0) = 0');

  const cap = Math.min(Math.max(Number(limit) || 1000, 1), 5000);

  // ScanUsage / PageviewUsage are UNIQUE(siteId, yearMonth), so each join adds at
  // most one row and no fan-out is possible.
  const sql = `
    SELECT
      s.id, s.name, s.domain, s.platform, s.isLegacy, s.verified,
      s.scanLimitNotifiedMonth, s.organizationId,
      o.name AS orgName,
      u.id AS ownerId, u.email AS ownerEmail,
      COALESCE(su.scanCount, 0) AS scansUsed,
      COALESCE(pu.pageviewCount, 0) AS pageviewsUsed,
      (SELECT COALESCE(sub.planId, '') || '|' || COALESCE(sub.status, '')
         FROM Subscription sub
        WHERE sub.organizationId = s.organizationId
          AND (sub.siteId IS NULL OR sub.siteId = '' OR sub.siteId = s.id)
        ORDER BY
          CASE WHEN sub.siteId IS NULL OR sub.siteId = '' THEN 1 ELSE 0 END,
          CASE LOWER(COALESCE(sub.status, ''))
            WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
          sub.createdAt DESC
        LIMIT 1) AS planCurrent
    FROM Site s
    LEFT JOIN Organization o ON s.organizationId = o.id
    LEFT JOIN User u ON o.ownerUserId = u.id
    LEFT JOIN ScanUsage su ON su.siteId = s.id AND su.yearMonth = ?
    LEFT JOIN PageviewUsage pu ON pu.siteId = s.id AND pu.yearMonth = ?
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    LIMIT ${cap}
  `;

  const [{ results = [] }, allowances] = await Promise.all([
    db.prepare(sql).bind(...params).all(),
    planAllowances(db),
  ]);

  let mapped = results.map((r) => {
    const [rawPlan = ''] = String(r.planCurrent || '').split('|');
    const tier = rawPlan.trim().toLowerCase();
    const planId = KNOWN_TIERS.has(tier) ? tier : 'free';
    const allow = allowances.get(planId) || allowances.get('free') || { ...FREE_FALLBACK };

    const scansUsed = Number(r.scansUsed) || 0;
    const pageviewsUsed = Number(r.pageviewsUsed) || 0;

    return {
      siteId: r.id,
      name: r.name,
      domain: r.domain,
      platform: normalizePlatform(r.platform),
      rawPlatform: r.platform ?? null,
      isLegacy: Number(r.isLegacy) || 0,
      verified: Number(r.verified) || 0,
      organizationId: r.organizationId,
      orgName: r.orgName ?? null,
      ownerId: r.ownerId ?? null,
      ownerEmail: r.ownerEmail ?? null,
      plan: planId,
      yearMonth,
      scansUsed,
      scansLimit: allow.scans,
      scansPct: pct(scansUsed, allow.scans),
      scansOver: allow.scans > 0 && scansUsed >= allow.scans,
      pageviewsUsed,
      pageviewsLimit: allow.pageviews,
      pageviewsPct: pct(pageviewsUsed, allow.pageviews),
      pageviewsOver: allow.pageviews > 0 && pageviewsUsed >= allow.pageviews,
      // The owner has already had the scan-cap email for the month on screen.
      scanLimitNotified: Boolean(
        r.scanLimitNotifiedMonth && String(r.scanLimitNotifiedMonth) === yearMonth
      ),
      internal: isInternalOrTest(r.ownerEmail),
    };
  });

  // Derived in JS, so these filters run after mapping — same rule as listSites.
  if (platform && platform !== 'all') {
    mapped = mapped.filter((s) => s.platform === platform);
  }
  if (audience === 'external') mapped = mapped.filter((s) => !s.internal);
  else if (audience === 'internal') mapped = mapped.filter((s) => s.internal);

  const wantedPlans = new Set(
    String(plan || '').split(',').map((p) => p.trim().toLowerCase()).filter((p) => p && p !== 'all')
  );
  if (wantedPlans.size) mapped = mapped.filter((s) => wantedPlans.has(s.plan));

  if (state === 'over') {
    mapped = mapped.filter((s) => s.scansOver || s.pageviewsOver);
  } else if (state === 'near') {
    // 80% of either allowance, but not yet over — the "about to be a problem" list.
    mapped = mapped.filter(
      (s) =>
        !s.scansOver && !s.pageviewsOver &&
        ((s.scansPct !== null && s.scansPct >= 80) || (s.pageviewsPct !== null && s.pageviewsPct >= 80))
    );
  } else if (state === 'active') {
    mapped = mapped.filter((s) => s.scansUsed > 0 || s.pageviewsUsed > 0);
  } else if (state === 'idle') {
    mapped = mapped.filter((s) => s.scansUsed === 0 && s.pageviewsUsed === 0);
  }

  // Busiest first — whichever allowance a site is furthest through leads, so the
  // sites closest to trouble are on page one.
  mapped.sort((a, b) => {
    const worst = (s) => Math.max(s.scansPct ?? 0, s.pageviewsPct ?? 0);
    return worst(b) - worst(a) || b.scansUsed - a.scansUsed || b.pageviewsUsed - a.pageviewsUsed;
  });

  const totals = mapped.reduce(
    (acc, s) => {
      acc.scans += s.scansUsed;
      acc.pageviews += s.pageviewsUsed;
      if (s.scansOver) acc.scansOver += 1;
      if (s.pageviewsOver) acc.pageviewsOver += 1;
      return acc;
    },
    { scans: 0, pageviews: 0, scansOver: 0, pageviewsOver: 0 }
  );

  return { yearMonth, rows: mapped, totals, months: await usageMonths(db) };
}

/** Months that actually have usage recorded, newest first, for the month picker. */
async function usageMonths(db) {
  try {
    const { results = [] } = await db
      .prepare(
        `SELECT yearMonth FROM ScanUsage
         UNION SELECT yearMonth FROM PageviewUsage
         ORDER BY yearMonth DESC LIMIT 36`
      )
      .all();
    const months = results.map((r) => r.yearMonth).filter(Boolean);
    const now = currentYearMonth();
    return months.includes(now) ? months : [now, ...months];
  } catch (_) {
    return [currentYearMonth()];
  }
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
      .prepare(`SELECT id, email, name, billingEmail, isLegacy, createdAt, updatedAt FROM User WHERE id = ?`)
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
        `SELECT id, name, domain, customDomain, stagingUrl, platform, verified,
                isLegacy, legacySource, createdAt, banner_type, region_mode
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
        customDomain: s.customDomain ?? null,
        stagingUrl: s.stagingUrl ?? null,
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
        `SELECT id, stripeSubscriptionId, planId, planType, interval, status,
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
    // Migrated off the old Webflow/Framer system. No live Stripe webhook writes
    // to these rows, which is what makes editing their plan stick.
    isLegacy: Number(user.isLegacy) || 0,
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
/* Edit user / organization / site                                    */
/* ------------------------------------------------------------------ */
//
// What an admin may edit, and what stays read-only:
//
//   editable   User.name / .email / .billingEmail
//              Organization.name
//              Site.name / .domain / .customDomain / .stagingUrl / .platform
//                   / .banner_type / .region_mode / .verified
//
//   read-only  Everything Stripe owns — stripeSubscriptionId, stripeCustomerId,
//              stripePriceId, and the whole Subscription row (status, interval,
//              amount, period). Those are mirrors of Stripe's state; editing the
//              mirror desynchronises it and the next webhook overwrites the edit
//              anyway. Change them in Stripe.
//              Also read-only: primary keys, apiKey / cdnScriptId (the embed
//              would stop resolving), licenseKey, and createdAt.
//
// "Cascading" here means the follow-on writes a rename implies. The schema keys
// nearly everything by userId / organizationId / siteId, so a rename mostly
// needs no fan-out at all — the short list of genuine duplicates is handled in
// cascadeEmailRename() below, and what is deliberately NOT rewritten is
// documented there.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Matches services/db.js — protocol and trailing slash off, lower-cased. */
function normalizeDomain(raw) {
  return String(raw || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
}

/** Runs one cascade statement, tolerating a table this database doesn't have. */
async function runCounted(db, sql, binds, onError, label) {
  try {
    const res = await db.prepare(sql).bind(...binds).run();
    return Number(res?.meta?.changes) || 0;
  } catch (err) {
    if (!isMissingTable(err)) onError?.(`${label}: ${err?.message || err}`);
    return 0;
  }
}

/**
 * Follow-on writes for an account-email rename.
 *
 * Rewritten — these are live copies of "the address this account uses":
 *   User.billingEmail, Site.billingEmail, but ONLY where they still hold the old
 *   address. This is checked against the value already in the row, after the
 *   main UPDATE, so a billing address the admin deliberately set to something
 *   else in the same request is left alone whichever order the fields arrived in.
 *
 * Revoked rather than re-pointed — re-pointing would let a credential delivered
 * to the old inbox act on the new address:
 *   EmailVerificationCode (pending login codes), OwnershipTransfer (a transfer
 *   still in flight, whose authorization link went to the old inbox)
 *
 * Deliberately untouched — records of what was true when they were written, so
 * rewriting them would falsify a compliance or delivery log:
 *   Consent.domain, SentPaymentFailureEmail.recipientEmail, and completed or
 *   already-cancelled OwnershipTransfer rows.
 *
 * Stripe is not touched at all: the customer's billing email lives in Stripe and
 * is changed there.
 */
async function cascadeEmailRename(db, userId, oldEmail, newEmail) {
  const changed = {};
  const errors = [];
  const onError = (m) => errors.push(m);
  const bump = (k, n) => { if (n) changed[k] = n; };

  bump('User.billingEmail', await runCounted(
    db,
    `UPDATE User SET billingEmail = ?1, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?2 AND LOWER(billingEmail) = ?3`,
    [newEmail, userId, oldEmail],
    onError, 'User.billingEmail'
  ));

  bump('Site.billingEmail', await runCounted(
    db,
    `UPDATE Site SET billingEmail = ?1, updatedAt = CURRENT_TIMESTAMP
      WHERE LOWER(billingEmail) = ?2
        AND organizationId IN (SELECT id FROM Organization WHERE ownerUserId = ?3)`,
    [newEmail, oldEmail, userId],
    onError, 'Site.billingEmail'
  ));

  bump('EmailVerificationCode.revoked', await runCounted(
    db,
    `DELETE FROM EmailVerificationCode WHERE LOWER(email) = ?1`,
    [oldEmail],
    onError, 'EmailVerificationCode'
  ));

  bump('OwnershipTransfer.cancelled', await runCounted(
    db,
    `UPDATE OwnershipTransfer SET status = 'cancelled' WHERE userId = ?1 AND status = 'pending'`,
    [userId],
    onError, 'OwnershipTransfer'
  ));

  return { changed, errors };
}

export async function updateUser(db, userId, fields) {
  const existing = await db
    .prepare(`SELECT id, email, billingEmail FROM User WHERE id = ?`)
    .bind(userId)
    .first();
  if (!existing) return { ok: false, error: 'User not found' };

  const oldEmail = String(existing.email || '').trim().toLowerCase();

  let newEmail;
  if (fields.email !== undefined) {
    newEmail = String(fields.email).trim().toLowerCase();
    if (!newEmail || !EMAIL_RE.test(newEmail)) {
      return { ok: false, error: 'Invalid email address' };
    }
    const clash = await db
      .prepare(`SELECT id FROM User WHERE LOWER(email) = ? AND id != ?`)
      .bind(newEmail, userId)
      .first();
    if (clash) return { ok: false, error: 'Another user already uses that email' };
  }

  // Empty clears it — Stripe then bills the account email.
  let billingEmail;
  if (fields.billingEmail !== undefined) {
    const b = String(fields.billingEmail ?? '').trim().toLowerCase();
    if (b && !EMAIL_RE.test(b)) return { ok: false, error: 'Invalid billing email address' };
    billingEmail = b || null;
  }

  const sets = [];
  const params = [];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    params.push(fields.name);
  }
  if (newEmail !== undefined) {
    sets.push('email = ?');
    params.push(newEmail);
  }
  if (billingEmail !== undefined) {
    sets.push('billingEmail = ?');
    params.push(billingEmail);
  }
  if (!sets.length) return { ok: true, cascade: {}, errors: [] };

  sets.push('updatedAt = CURRENT_TIMESTAMP');
  params.push(userId);
  await db.prepare(`UPDATE User SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  if (newEmail === undefined || newEmail === oldEmail) {
    return { ok: true, cascade: {}, errors: [] };
  }
  const { changed, errors } = await cascadeEmailRename(db, userId, oldEmail, newEmail);
  return { ok: true, cascade: changed, errors };
}

export async function updateOrganization(db, orgId, fields) {
  const org = await db
    .prepare(`SELECT id, name FROM Organization WHERE id = ?`)
    .bind(orgId)
    .first();
  if (!org) return { ok: false, error: 'Organization not found' };

  if (fields.name === undefined) return { ok: true, before: org };
  const name = String(fields.name ?? '').trim();
  if (!name) return { ok: false, error: 'Organization name cannot be empty' };

  // updatedAt only exists on databases that ran the later migration.
  try {
    await db
      .prepare(`UPDATE Organization SET name = ?1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?2`)
      .bind(name, orgId)
      .run();
  } catch (_) {
    await db.prepare(`UPDATE Organization SET name = ?1 WHERE id = ?2`).bind(name, orgId).run();
  }
  return { ok: true, before: org };
}

/** Columns updateSite will write, and how each value is cleaned up first. */
const SITE_EDITABLE = {
  name: (v) => String(v ?? '').trim(),
  customDomain: (v) => normalizeDomain(v) || null,
  stagingUrl: (v) => normalizeDomain(v) || null,
  platform: (v) => (String(v ?? '').trim().toLowerCase() || null),
  banner_type: (v) => (String(v ?? '').trim().toLowerCase() || null),
  region_mode: (v) => (String(v ?? '').trim().toLowerCase() || null),
  verified: (v) => (v ? 1 : 0),
};

export async function updateSite(db, siteId, fields) {
  const site = await db
    .prepare(
      `SELECT id, organizationId, name, domain, customDomain, stagingUrl, platform,
              banner_type, region_mode, verified
         FROM Site WHERE id = ?`
    )
    .bind(siteId)
    .first();
  if (!site) return { ok: false, error: 'Site not found' };

  const sets = [];
  const params = [];

  // domain is UNIQUE and is also the CDN's authorization check (cdn.js compares
  // the requesting page's host against it), so it gets its own validation.
  if (fields.domain !== undefined) {
    const domain = normalizeDomain(fields.domain);
    if (!domain) return { ok: false, error: 'Domain cannot be empty' };
    if (/[\s/]/.test(domain)) return { ok: false, error: 'Domain must be a bare host, e.g. example.com' };
    if (domain !== normalizeDomain(site.domain)) {
      const clash = await db
        .prepare(`SELECT id FROM Site WHERE LOWER(domain) = ? AND id != ?`)
        .bind(domain, siteId)
        .first();
      if (clash) return { ok: false, error: 'Another site already uses that domain' };
    }
    sets.push('domain = ?');
    params.push(domain);
  }

  for (const [col, clean] of Object.entries(SITE_EDITABLE)) {
    if (fields[col] === undefined) continue;
    const value = clean(fields[col]);
    if (col === 'name' && !value) return { ok: false, error: 'Site name cannot be empty' };
    sets.push(`${col} = ?`);
    params.push(value);
  }

  if (!sets.length) return { ok: true, before: site };

  // Flipping verified on stamps the time it happened, matching the verify flow.
  if (fields.verified !== undefined && !site.verified && fields.verified) {
    sets.push('verified_at = CURRENT_TIMESTAMP');
  }

  sets.push('updatedAt = CURRENT_TIMESTAMP');
  params.push(siteId);
  await db.prepare(`UPDATE Site SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return { ok: true, before: site };
}

/* ---- subscription ---------------------------------------------------- */
//
// These columns mirror Stripe. Editing them here is a LOCAL OVERRIDE: the next
// webhook Stripe sends for this subscription rewrites status, interval, amount
// and period from Stripe's own copy. Use it to correct a row that drifted out of
// sync or to fix up a migrated legacy record — not to change what a customer is
// billed, which only Stripe can do.
//
// The three Stripe identifiers are not editable at all: they are the join keys
// the webhook handler uses to find this row, so a wrong value silently detaches
// the subscription from its Stripe counterpart forever.

const SUB_ENUMS = {
  // The tier — this is what the Plan / Status filters and the badges read.
  planId: ['free', 'basic', 'essential', 'growth'],
  // The billing shape, which is a different axis from the tier.
  planType: ['single', 'tier', 'bulk', 'quantity', 'free', 'subscription'],
  interval: ['monthly', 'yearly'],
  status: ['active', 'trialing', 'past_due', 'canceled', 'unpaid',
           'incomplete', 'incomplete_expired', 'paused', 'pending'],
};

export async function updateSubscription(db, subId, fields) {
  const sub = await db
    .prepare(
      `SELECT id, organizationId, planId, planType, interval, status, amountCents,
              currentPeriodEnd, cancelAtPeriodEnd, licenseKey
         FROM Subscription WHERE id = ?`
    )
    .bind(subId)
    .first();
  if (!sub) return { ok: false, error: 'Subscription not found' };

  const sets = [];
  const params = [];

  for (const [col, allowed] of Object.entries(SUB_ENUMS)) {
    if (fields[col] === undefined) continue;
    const v = String(fields[col] ?? '').trim().toLowerCase();
    if (!allowed.includes(v)) {
      return { ok: false, error: `${col} must be one of: ${allowed.join(', ')}` };
    }
    sets.push(`${col} = ?`);
    params.push(v);
  }

  if (fields.amountCents !== undefined) {
    const raw = fields.amountCents;
    if (raw === null || raw === '') {
      sets.push('amountCents = ?');
      params.push(null);
    } else {
      const cents = Number(raw);
      if (!Number.isInteger(cents) || cents < 0) {
        return { ok: false, error: 'Amount must be a whole number of cents, 0 or more' };
      }
      sets.push('amountCents = ?');
      params.push(cents);
    }
  }

  if (fields.currentPeriodEnd !== undefined) {
    const raw = String(fields.currentPeriodEnd ?? '').trim();
    if (!raw) {
      sets.push('currentPeriodEnd = ?');
      params.push(null);
    } else {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return { ok: false, error: 'Renewal date is not a valid date' };
      sets.push('currentPeriodEnd = ?');
      params.push(d.toISOString());
    }
  }

  if (fields.cancelAtPeriodEnd !== undefined) {
    sets.push('cancelAtPeriodEnd = ?');
    params.push(fields.cancelAtPeriodEnd ? 1 : 0);
  }

  if (fields.licenseKey !== undefined) {
    const key = String(fields.licenseKey ?? '').trim();
    sets.push('licenseKey = ?');
    params.push(key || null);
  }

  if (!sets.length) return { ok: true, before: sub };

  sets.push('updatedAt = CURRENT_TIMESTAMP');
  params.push(subId);
  await db
    .prepare(`UPDATE Subscription SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params)
    .run();
  return { ok: true, before: sub };
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
