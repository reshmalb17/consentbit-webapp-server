// src/services/consentRetention.js
//
// Consent-record retention: how long a site's Consent rows are kept, and the job
// that deletes them once that period ends.
//
// The period is layered (decision D1, work-log Fri 11 Sep 2026):
//   law   → RETENTION_LEGAL_BOUNDS   the outer bounds nobody may go outside
//   plan  → RETENTION_PLAN_LIMITS    the range each plan offers, inside the law
//   site  → Site.consent_retention_days, the customer's pick inside the plan
// The generated policy must print the same number this job enforces.
//
// ─── STATUS: MECHANISM ONLY — THE NUMBERS BELOW ARE PLACEHOLDERS ────────────
// The plan ranges and legal bounds are not decided yet. Every value marked
// PLACEHOLDER is to be replaced once the plans and limits are agreed.
//
// ─── DELETION IS OFF BY DEFAULT ─────────────────────────────────────────────
// env.CONSENT_RETENTION_MODE:
//   unset / 'off'  nothing runs (the default — no wrangler var is set)
//   'dry-run'      counts what WOULD be deleted, logs it, deletes nothing
//   'on'           deletes
// The test and production workers bind the SAME D1. Turning this on for either
// one deletes production consent records. Enable deliberately, and only after
// the index below exists.
//
// ─── REQUIRED BEFORE ENABLING: create the index by hand ─────────────────────
//   CREATE INDEX IF NOT EXISTS idx_consent_site_created ON Consent (siteId, createdAt);
// Deliberately NOT created from code: building an index on a large table locks
// it against writes while it runs, which would stall live consent saves. The
// sweep checks for the index and refuses to run without it.
//
// ─── NOT COVERED HERE ───────────────────────────────────────────────────────
// ArchivedConsent (rows moved there by Admin-Dashboard-Server archiveSite.js
// when a site is archived) is kept forever today. How long to keep records of
// sites that have left is decision D3 — still open, so not implemented.

// ─── Placeholders — replace when D1 is decided ───────────────────────────────

/** Outer bounds from the law, in days. PLACEHOLDER. */
export const RETENTION_LEGAL_BOUNDS = {
  minDays: 365,   // PLACEHOLDER — long enough to prove consent; CCPA opt-out 12-month floor
  maxDays: 1825,  // PLACEHOLDER — 5 years
};

/** Range each plan offers, in days. PLACEHOLDER. Plan ids match ensureDefaultPlans. */
export const RETENTION_PLAN_LIMITS = {
  free:      { minDays: 365, maxDays: 365,  defaultDays: 365 }, // PLACEHOLDER
  basic:     { minDays: 365, maxDays: 1825, defaultDays: 365 }, // PLACEHOLDER
  essential: { minDays: 365, maxDays: 1825, defaultDays: 365 }, // PLACEHOLDER
  growth:    { minDays: 365, maxDays: 1825, defaultDays: 365 }, // PLACEHOLDER
};

/** Periods offered in the dashboard; filtered to the site's plan range. */
export const RETENTION_CHOICES_DAYS = [365, 730, 1095, 1825];

// ─── Sweep tuning ────────────────────────────────────────────────────────────

/** The sweep runs during this UTC hour, one slice per cron tick (cron is every minute). */
const SWEEP_HOUR_UTC = 3;
/** Sites looked at per tick. */
const SITES_PER_TICK = 25;
/** Rows deleted per statement, and statements per site per tick. */
const DELETE_BATCH = 500;
const MAX_BATCHES_PER_SITE = 5;
const INDEX_NAME = 'idx_consent_site_created';

// ─── Resolution ──────────────────────────────────────────────────────────────

/** 'off' | 'dry-run' | 'on'. Anything unrecognised is 'off'. */
export function retentionMode(env) {
  const raw = String(env?.CONSENT_RETENTION_MODE || '').trim().toLowerCase();
  if (raw === 'on') return 'on';
  if (raw === 'dry-run' || raw === 'dryrun') return 'dry-run';
  return 'off';
}

/** The plan's range, clamped inside the legal bounds. Unknown plans get free's range. */
export function getPlanRetentionLimits(planId) {
  const plan = RETENTION_PLAN_LIMITS[String(planId || '').toLowerCase()] || RETENTION_PLAN_LIMITS.free;
  const minDays = Math.max(plan.minDays, RETENTION_LEGAL_BOUNDS.minDays);
  const maxDays = Math.max(minDays, Math.min(plan.maxDays, RETENTION_LEGAL_BOUNDS.maxDays));
  const defaultDays = Math.min(maxDays, Math.max(minDays, plan.defaultDays));
  return { minDays, maxDays, defaultDays };
}

/**
 * The period actually enforced: the customer's pick if set, clamped into the plan's
 * range. A downgrade therefore shortens retention automatically on the next sweep.
 */
export function resolveRetentionDays(planId, chosenDays) {
  const { minDays, maxDays, defaultDays } = getPlanRetentionLimits(planId);
  const n = Number(chosenDays);
  if (!Number.isFinite(n) || n <= 0) return defaultDays;
  return Math.min(maxDays, Math.max(minDays, Math.round(n)));
}

/** Choices to show for a plan: the fixed list, filtered to the range, plus the bounds. */
export function retentionChoicesForPlan(planId) {
  const { minDays, maxDays } = getPlanRetentionLimits(planId);
  const set = new Set(RETENTION_CHOICES_DAYS.filter((d) => d >= minDays && d <= maxDays));
  set.add(minDays);
  set.add(maxDays);
  return [...set].sort((a, b) => a - b);
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/**
 * Site.consent_retention_days — NULL means "plan default". Added lazily here rather
 * than in ensureSchema, so nothing on the request hot path changes. ADD COLUMN is a
 * metadata-only change in SQLite and safe on a live table.
 */
const _columnReady = new WeakSet();
export async function ensureRetentionColumn(db) {
  if (!db || _columnReady.has(db)) return;
  try {
    await db.prepare('ALTER TABLE Site ADD COLUMN consent_retention_days INTEGER').run();
    _columnReady.add(db);
  } catch (err) {
    // "duplicate column" = already added, the normal case after the first call.
    // Anything else (a transient D1 error) is NOT cached, so the next call retries
    // instead of every later read/write failing on a column that was never added.
    if (/duplicate column/i.test(String(err?.message || ''))) _columnReady.add(db);
  }
}

/** Evidence that deletion happened, without keeping the deleted rows (tombstones). */
async function ensureRetentionTables(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ConsentRetentionLog (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       siteId TEXT NOT NULL,
       runAt TEXT NOT NULL,
       mode TEXT NOT NULL,
       retentionDays INTEGER NOT NULL,
       cutoffDate TEXT NOT NULL,
       affectedCount INTEGER NOT NULL
     )`,
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ConsentRetentionState (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       runDate TEXT,
       cursor TEXT,
       done INTEGER DEFAULT 0,
       updatedAt TEXT
     )`,
  ).run();
}

export async function readSiteRetentionDays(db, siteId) {
  await ensureRetentionColumn(db);
  const row = await db
    .prepare('SELECT consent_retention_days AS days FROM Site WHERE id = ?1 LIMIT 1')
    .bind(siteId)
    .first();
  const n = Number(row?.days);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Persist the customer's pick. `days` must already be validated against the plan. */
export async function writeSiteRetentionDays(db, siteId, days) {
  await ensureRetentionColumn(db);
  await db
    .prepare('UPDATE Site SET consent_retention_days = ?1 WHERE id = ?2')
    .bind(days == null ? null : Math.round(days), siteId)
    .run();
}

// ─── Sweep ───────────────────────────────────────────────────────────────────

/** YYYY-MM-DD, `days` before `now`. Date-only on purpose — see purgeSite. */
function cutoffDateFor(now, days) {
  const d = new Date(now.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Delete (or, in dry-run, count) one site's Consent rows older than its period.
 *
 * The cutoff is a bare date ('2025-09-11'). createdAt holds two formats — ISO
 * strings written by consent.js ('2025-09-10T14:02:11.000Z') and SQLite's default
 * ('2025-09-10 14:02:11'). Both sort correctly against a bare date, which a full
 * timestamp would not (the 'T' and the space differ at the same position).
 *
 * Returns { affected, more } — `more` means rows remain past the batch cap.
 */
async function purgeSite(db, siteId, cutoffDate, mode) {
  if (mode === 'dry-run') {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM Consent WHERE siteId = ?1 AND createdAt < ?2')
      .bind(siteId, cutoffDate)
      .first();
    return { affected: Number(row?.n || 0), more: false };
  }

  let affected = 0;
  for (let i = 0; i < MAX_BATCHES_PER_SITE; i++) {
    const res = await db
      .prepare(
        `DELETE FROM Consent WHERE id IN (
           SELECT id FROM Consent WHERE siteId = ?1 AND createdAt < ?2 LIMIT ${DELETE_BATCH}
         )`,
      )
      .bind(siteId, cutoffDate)
      .run();
    const changed = Number(res?.meta?.changes || 0);
    affected += changed;
    if (changed < DELETE_BATCH) return { affected, more: false };
  }
  return { affected, more: true };
}

async function indexExists(db) {
  const row = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?1 LIMIT 1")
    .bind(INDEX_NAME)
    .first()
    .catch(() => null);
  return !!row?.ok;
}

/**
 * Called from the worker's scheduled() handler on every cron tick. Does nothing
 * unless CONSENT_RETENTION_MODE is set, and only works during SWEEP_HOUR_UTC.
 * Walks the Site table in id order, a slice per tick, with a cursor in
 * ConsentRetentionState so a day's sweep resumes where the last tick stopped.
 *
 * `resolvePlanId(db, env, siteId)` returns a plan id, or null when resolution
 * failed. A site with an unknown plan is SKIPPED — never delete on a guess.
 */
export async function runConsentRetentionSweep(env, { now = new Date(), resolvePlanId } = {}) {
  const mode = retentionMode(env);
  if (mode === 'off') return { skipped: 'off' };
  if (now.getUTCHours() !== SWEEP_HOUR_UTC) return { skipped: 'outside-window' };

  const db = env?.CONSENT_WEBAPP;
  if (!db || typeof resolvePlanId !== 'function') return { skipped: 'no-db' };

  if (!(await indexExists(db))) {
    console.warn(
      `[ConsentRetention] ${INDEX_NAME} is missing — sweep refused. Create it by hand first ` +
        '(see the header of services/consentRetention.js).',
    );
    return { skipped: 'no-index' };
  }

  await ensureRetentionColumn(db);
  await ensureRetentionTables(db);

  const today = now.toISOString().slice(0, 10);
  let state = await db
    .prepare('SELECT runDate, cursor, done FROM ConsentRetentionState WHERE id = 1')
    .first()
    .catch(() => null);
  if (!state || state.runDate !== today) {
    state = { runDate: today, cursor: '', done: 0 };
  }
  if (Number(state.done) === 1) return { skipped: 'done-today' };

  const { results: sites } = await db
    .prepare(
      `SELECT id, consent_retention_days AS days FROM Site
       WHERE id > ?1 ORDER BY id LIMIT ${SITES_PER_TICK}`,
    )
    .bind(state.cursor || '')
    .all();

  let cursor = state.cursor || '';
  let processed = 0;
  let totalAffected = 0;

  for (const site of sites || []) {
    const siteId = String(site.id);
    let planId = null;
    try {
      planId = await resolvePlanId(db, env, siteId);
    } catch (_) {
      planId = null;
    }

    if (planId === null) {
      console.warn(`[ConsentRetention] plan unknown for site ${siteId} — skipped`);
      cursor = siteId;
      continue;
    }

    const days = resolveRetentionDays(planId, site.days);
    const cutoffDate = cutoffDateFor(now, days);
    let result;
    try {
      result = await purgeSite(db, siteId, cutoffDate, mode);
    } catch (err) {
      console.warn(`[ConsentRetention] site ${siteId} failed:`, err?.message);
      cursor = siteId;
      continue;
    }

    if (result.affected > 0) {
      totalAffected += result.affected;
      await db
        .prepare(
          `INSERT INTO ConsentRetentionLog (siteId, runAt, mode, retentionDays, cutoffDate, affectedCount)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(siteId, now.toISOString(), mode, days, cutoffDate, result.affected)
        .run()
        .catch(() => {});
    }

    processed++;
    // Rows left past the batch cap: stop here WITHOUT advancing past this site, so
    // the next tick carries on with it.
    if (result.more) break;
    cursor = siteId;
  }

  // Done for today when this slice reached the end of the Site table AND every site
  // in it was finished (a `more` break leaves the cursor short of the last id).
  const list = sites || [];
  const reachedEnd = list.length < SITES_PER_TICK;
  const finishedSlice = list.length === 0 || cursor === String(list[list.length - 1].id);
  const done = reachedEnd && finishedSlice ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO ConsentRetentionState (id, runDate, cursor, done, updatedAt)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET runDate = ?1, cursor = ?2, done = ?3, updatedAt = ?4`,
    )
    .bind(today, cursor, done, now.toISOString())
    .run();

  return { mode, processed, totalAffected, cursor, done: !!done };
}
