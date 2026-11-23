// src/services/retentionReminders.js
//
// Warns site owners before consent records leave their dashboard (user, 2026-10-17):
//
//   Free  — records are only VISIBLE for 3 months (consentViewCutoff, LAW_FIXES) and kept
//           up to 12 months. 11 days before a half-month of records starts to be hidden:
//           "upgrade to a Pro plan to keep them for 12 months".
//   Paid  — (Basic, Essential, Growth) the retention sweep REMOVES records past 12 months
//           (CCPA 24) on the 1st and 15th. 10 days before each sweep: "download a copy".
//
// Both are tied to the sweep days (SWEEP_DAYS_OF_MONTH = 1st and 15th):
//   Free  window k = records hidden on days [S_k, S_k+1), reminder on S_k − 11 days.
//         The windows tile, so every record is announced exactly once.
//   Paid  window k = records the sweep on S_k will move, reminder on S_k − 10 days.
//
// One email per site per window, to the account owner only, claimed in
// RetentionReminderSent before sending (same pattern as SentPaymentFailureEmail).
// The dashboard bell (GET /api/consent-retention-notice) shows the same notice live.
//
// Switch: RETENTION_REMINDERS = "off" | "dry-run" | "on". Test and production share one
// D1 and one claim table, so set it on ONE worker (production) — like the sweep.
// D1 records only: the pre-D1 stores (Webflow KV, Framer KV, R2) are not counted.

import {
  SWEEP_DAYS_OF_MONTH, FREE_RETENTION_DAYS, MOVE_GDPR_DAYS, MOVE_CCPA_DAYS,
  retentionMode, siteHasNoPaidPlan,
} from './consentRetention.js';
import { getOrgOwnerEmail } from './db.js';
import { sendRetentionReminderEmail } from './email.js';

export const FREE_NOTICE_DAYS = 11;
export const PAID_NOTICE_DAYS = 10;
const RUN_HOUR_UTC = 9;
const SITES_PER_TICK = 25;
const INDEX_NAME = 'idx_consent_site_created';

// ─── Dates (UTC, 'YYYY-MM-DD') ───────────────────────────────────────────────

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  return ymd(new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000));
}

function isSweepDay(dateStr) {
  return SWEEP_DAYS_OF_MONTH.includes(Number(dateStr.slice(8, 10)));
}

/** First sweep day strictly after dateStr. */
export function nextSweepAfter(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 32; i++) {
    d = addDays(d, 1);
    if (isSweepDay(d)) return d;
  }
  return d;
}

/**
 * A Free record is hidden once createdAt < (today − 91 days) as a bare date, i.e. from
 * day createdAt + 92. Records hidden on days [hideFrom, hideUntil) were created in
 * [hideFrom − 92, hideUntil − 92).
 */
export function freeWindow(sweepDate) {
  const next = nextSweepAfter(sweepDate);
  return {
    date: sweepDate,
    from: addDays(sweepDate, -(FREE_RETENTION_DAYS + 1)),
    until: addDays(next, -(FREE_RETENTION_DAYS + 1)), // exclusive
  };
}

/** The sweep on sweepDate moves createdAt < cutoff (non-CCPA) / < ccpaCutoff (CCPA). */
export function paidWindow(sweepDate) {
  return {
    date: sweepDate,
    cutoff: addDays(sweepDate, -MOVE_GDPR_DAYS),
    ccpaCutoff: addDays(sweepDate, -MOVE_CCPA_DAYS),
  };
}

// ─── Counts ──────────────────────────────────────────────────────────────────

export async function countFreeWindow(db, siteId, w) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM Consent WHERE siteId = ?1 AND createdAt >= ?2 AND createdAt < ?3')
    .bind(siteId, w.from, w.until)
    .first();
  return Number(row?.n || 0);
}

// Same rule as consentRetention.js EXPIRED.
export async function countPaidWindow(db, siteId, w) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM Consent WHERE siteId = ?1 AND createdAt < ?2
         AND (COALESCE(regulation, '') <> 'ccpa' OR createdAt < ?3)`,
    )
    .bind(siteId, w.cutoff, w.ccpaCutoff)
    .first();
  return Number(row?.n || 0);
}

/**
 * The notice for one site today, for the dashboard bell. null = nothing to show.
 * Free notices need LAW_FIXES (no hiding without it). Paid notices show whichever worker
 * serves the dashboard: the D1 is shared, so the sweep on the other worker is real.
 */
export async function getRetentionNotice(env, siteId, now = new Date()) {
  const db = env?.CONSENT_WEBAPP;
  if (!db || !siteId) return null;
  const today = ymd(now);
  const sweep = nextSweepAfter(today);
  const daysLeft = Math.round((Date.parse(sweep) - Date.parse(today)) / 86400000);

  const isFree = await siteHasNoPaidPlan(env, siteId);
  if (isFree === null) return null;

  if (isFree) {
    if (env.LAW_FIXES !== '1' || daysLeft > FREE_NOTICE_DAYS) return null;
    const w = freeWindow(sweep);
    const count = await countFreeWindow(db, siteId, w);
    return count > 0 ? { kind: 'free', count, date: w.date, from: w.from, until: addDays(w.until, -1) } : null;
  }
  if (daysLeft > PAID_NOTICE_DAYS) return null;
  const w = paidWindow(sweep);
  const count = await countPaidWindow(db, siteId, w);
  return count > 0 ? { kind: 'paid', count, date: w.date, cutoff: w.cutoff } : null;
}

// ─── Daily email pass ────────────────────────────────────────────────────────

function remindersMode(env) {
  const v = String(env?.RETENTION_REMINDERS || 'off').trim().toLowerCase();
  return v === 'on' || v === 'dry-run' ? v : 'off';
}

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS RetentionReminderSent (
         siteId TEXT NOT NULL, kind TEXT NOT NULL, windowDate TEXT NOT NULL,
         recipientEmail TEXT, recordCount INTEGER, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (siteId, kind, windowDate))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS RetentionReminderState (
         id INTEGER PRIMARY KEY, runDate TEXT, cursor TEXT, done INTEGER DEFAULT 0, updatedAt TEXT)`,
    ),
  ]);
  tablesReady = true;
}

async function claim(db, siteId, kind, windowDate, email, count) {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO RetentionReminderSent (siteId, kind, windowDate, recipientEmail, recordCount)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(siteId, kind, windowDate, email || null, count)
    .run();
  return (r?.meta?.changes || 0) > 0;
}

/**
 * Called on every cron tick. Works only on a reminder day (a sweep day is 11 days ahead
 * for Free or 10 days ahead for paid), from RUN_HOUR_UTC, a slice of sites per tick,
 * with a cursor in RetentionReminderState so the day's pass resumes where it stopped.
 */
export async function runRetentionReminders(env, ctx, { now = new Date() } = {}) {
  const mode = remindersMode(env);
  if (mode === 'off') return { skipped: 'off' };
  if (now.getUTCHours() < RUN_HOUR_UTC) return { skipped: 'before-hour' };

  const today = ymd(now);
  const freeSweep = env.LAW_FIXES === '1' && isSweepDay(addDays(today, FREE_NOTICE_DAYS))
    ? addDays(today, FREE_NOTICE_DAYS) : null;
  // Only warn of removals that will happen: the sweep must be on for this worker.
  const paidSweep = retentionMode(env) === 'on' && isSweepDay(addDays(today, PAID_NOTICE_DAYS))
    ? addDays(today, PAID_NOTICE_DAYS) : null;
  if (!freeSweep && !paidSweep) return { skipped: 'not-a-reminder-day' };

  const db = env?.CONSENT_WEBAPP;
  if (!db) return { skipped: 'no-db' };
  const idx = await db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ?1 LIMIT 1")
    .bind(INDEX_NAME)
    .first()
    .catch(() => null);
  if (!idx?.ok) return { skipped: 'no-index' };

  await ensureTables(db);
  let state = await db
    .prepare('SELECT runDate, cursor, done FROM RetentionReminderState WHERE id = 1')
    .first()
    .catch(() => null);
  if (!state || state.runDate !== today) state = { runDate: today, cursor: '', done: 0 };
  if (Number(state.done) === 1) return { skipped: 'done-today' };

  const { results: sites } = await db
    .prepare(`SELECT id, domain, organizationId FROM Site WHERE id > ?1 ORDER BY id LIMIT ${SITES_PER_TICK}`)
    .bind(state.cursor || '')
    .all();

  const fw = freeSweep ? freeWindow(freeSweep) : null;
  const pw = paidSweep ? paidWindow(paidSweep) : null;
  let cursor = state.cursor || '';
  let sent = 0;

  for (const site of sites || []) {
    const siteId = String(site.id);
    cursor = siteId;
    try {
      if (!site.organizationId) continue;
      const isFree = await siteHasNoPaidPlan(env, siteId);
      if (isFree === null) continue;
      const kind = isFree ? 'free' : 'paid';
      const w = isFree ? fw : pw;
      if (!w) continue;
      const count = isFree ? await countFreeWindow(db, siteId, w) : await countPaidWindow(db, siteId, w);
      if (count <= 0) continue;

      const owner = await getOrgOwnerEmail(db, site.organizationId);
      if (mode === 'dry-run') {
        console.log('[RetentionReminders] dry-run', { siteId, kind, count, date: w.date, to: owner?.email || null });
        continue;
      }
      if (!owner?.email) continue;
      if (!(await claim(db, siteId, kind, w.date, owner.email, count))) continue;
      sendRetentionReminderEmail(env, ctx, {
        to: owner.email,
        name: owner.name,
        domain: site.domain,
        kind,
        count,
        date: w.date,
        from: w.from,
        until: w.until ? addDays(w.until, -1) : undefined,
        cutoff: w.cutoff,
      });
      sent++;
    } catch (err) {
      console.warn(`[RetentionReminders] site ${siteId} failed:`, err?.message);
    }
  }

  const done = (sites || []).length < SITES_PER_TICK ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO RetentionReminderState (id, runDate, cursor, done, updatedAt) VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET runDate = ?1, cursor = ?2, done = ?3, updatedAt = ?4`,
    )
    .bind(today, cursor, done, now.toISOString())
    .run();

  return { mode, sent, cursor, done: !!done };
}
