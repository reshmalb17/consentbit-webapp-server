// src/services/freeFallback.js
//
// What happens to a site when its paid plan ENDS (card failed through dunning, or a
// cancellation reached its period end): it moves to the Free plan — but only if no
// other site on the same account is already using the one Free site the account gets.
// Decided 2026-11-05 (Joseph): "Move to free account only if there is no other site
// using free account feature."
//
// Before this, an ended site was simply blocked: cdnM.js returned 402, the webapp read
// "No active plan", and the only way back was a new checkout. That stays the outcome
// when the Free slot is taken. When it is not, the site is marked here and every reader
// that used to treat a terminal subscription row as "ended" treats it as Free instead.
//
// The mark is ONE column on the Site row, `freeFallbackAt`, deliberately not a fake
// Subscription row: dozens of readers equate "a row in active/trialing" with "paid"
// (consentRetention, team.js, admin dashboard, reconcile…), and a $0 'active' row would
// have fooled every one of them. A Site stamp changes only the readers that decide
// "is this site's plan over?", which are listed in the handlers that import this file.
//
// What counts as "a site using the Free plan" (`findOtherFreeSite`):
//   • a site with no Subscription row at all — it has only ever been Free, or
//   • a site already moved here (freeFallbackAt set) whose plan has not been bought back.
// A site whose plan ended and was NOT moved (blocked, 402) is not using Free — it is
// using nothing — so it never blocks a sibling. A cancelled site still inside its paid
// period is still paid.
//
// Switch: env.FREE_FALLBACK — "on" moves sites, "dry-run" only logs what it would do,
// anything else is off (the pre-2026-11-05 behaviour). The decision itself is
// idempotent (`WHERE freeFallbackAt IS NULL`), so test and production — which share
// one D1 — can both run it.

import { flowLog } from '../utils/flowLog.js';

const TAG = '[FreeFallback]';

/** Stripe statuses a subscription never comes back from (same list as siteSubscriptionEnded.js). */
export const TERMINAL_STATUSES = Object.freeze(['canceled', 'cancelled', 'deleted', 'unpaid', 'incomplete_expired']);

/** 'canceled' keeps its plan until the stored period end; the rest are over on sight. */
const PERIOD_BOUND_STATUSES = Object.freeze(['canceled', 'cancelled']);

export function freeFallbackMode(env) {
  const v = String(env?.FREE_FALLBACK ?? '').trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true') return 'on';
  if (v === 'dry-run' || v === 'dryrun' || v === 'dry') return 'dry-run';
  return 'off';
}

/** Rows mix ISO strings and SQLite datetimes — normalise before parsing. */
function parseWhen(raw) {
  if (!raw) return NaN;
  return Date.parse(String(raw).replace(' ', 'T'));
}

const _columnEnsured = new WeakMap();

/**
 * Adds the Site columns this feature writes. Same idempotent ALTER-in-try pattern as
 * ensureSchema in db.js (which also carries these, so a worker that ran any other
 * route first already has them). Cached per D1 binding.
 */
export async function ensureFreeFallbackColumns(db) {
  if (!db) return;
  if (_columnEnsured.get(db)) return;
  for (const ddl of [
    `ALTER TABLE Site ADD COLUMN freeFallbackAt DATETIME`,
    `ALTER TABLE Site ADD COLUMN freeFallbackReason TEXT`,
  ]) {
    try { await db.prepare(ddl).run(); } catch (_) { /* exists */ }
  }
  _columnEnsured.set(db, true);
}

/**
 * The site's own CURRENT subscription row — a live row always outranks a dead one,
 * however recently the dead one was touched (same ordering as cdnM.js / siteSubscriptionEnded.js).
 */
async function ownCurrentRow(db, siteId) {
  return db
    .prepare(
      `SELECT id, planId, status, currentPeriodEnd, stripeSubscriptionId FROM Subscription WHERE siteId = ?1
        ORDER BY CASE WHEN LOWER(status) IN ('active','trialing') THEN 0 ELSE 1 END,
                 datetime(COALESCE(updatedAt, createdAt)) DESC
        LIMIT 1`,
    )
    .bind(siteId)
    .first();
}

/** Site.freeFallbackAt, or null when unset / column missing / read failed. */
export async function getSiteFreeFallbackAt(db, siteId) {
  if (!db || !siteId) return null;
  try {
    const row = await db.prepare('SELECT freeFallbackAt FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
    return row?.freeFallbackAt ?? row?.freefallbackat ?? null;
  } catch (_) {
    return null; // column not there yet — nobody has been moved
  }
}

/**
 * Which of four states a site is in, judged on ITS OWN subscription rows only:
 *   paid           active / trialing, or cancelled but still inside the paid period
 *   free           never had a subscription row
 *   free-fallback  plan ended, site was moved to Free (Site.freeFallbackAt set)
 *   lapsed         plan ended, NOT moved — blocked (402) until a plan is bought
 *
 * `row` is the subscription row the verdict was based on (null for 'free').
 * Fails to 'paid' on a read error, so an outage never moves or blocks anyone.
 */
export async function classifySiteEntitlement(db, siteId, { freeFallbackAt } = {}) {
  if (!db || !siteId) return { kind: 'paid', row: null, error: 'no-db-or-site' };
  try {
    const row = await ownCurrentRow(db, siteId);
    if (!row) return { kind: 'free', row: null };
    const status = String(row.status ?? '').trim().toLowerCase();
    if (status === 'active' || status === 'trialing') return { kind: 'paid', row };
    if (!TERMINAL_STATUSES.includes(status)) {
      // 'inactive' (superseded / reassigned), 'past_due', 'incomplete'… — not ended by
      // this rule; leave those sites exactly as every other reader treats them.
      return { kind: 'paid', row };
    }
    if (PERIOD_BOUND_STATUSES.includes(status)) {
      const endMs = parseWhen(row.currentPeriodEnd ?? row.currentperiodend);
      if (Number.isFinite(endMs) && endMs > Date.now()) return { kind: 'paid', row, inPeriodUntil: endMs };
    }
    const fallbackAt = freeFallbackAt !== undefined ? freeFallbackAt : await getSiteFreeFallbackAt(db, siteId);
    return fallbackAt ? { kind: 'free-fallback', row, freeFallbackAt: fallbackAt } : { kind: 'lapsed', row };
  } catch (err) {
    console.warn(`${TAG} classify failed (treating as paid):`, err?.message || err);
    return { kind: 'paid', row: null, error: err?.message || String(err) };
  }
}

/** True when the site is served as Free because its paid plan ended and it was moved here. */
export async function siteIsOnFreeFallback(db, siteId) {
  const r = await classifySiteEntitlement(db, siteId);
  return r.kind === 'free-fallback';
}

/**
 * The first OTHER site in the account that is using the Free plan, or null.
 * `excludeSiteId` is the site being judged — it must never block itself.
 * Returns { id, domain, name, kind }.
 */
export async function findOtherFreeSite(db, organizationId, excludeSiteId = null) {
  if (!db || !organizationId) return null;
  let sites = [];
  try {
    const { results } = await db
      .prepare('SELECT id, domain, name FROM Site WHERE organizationId = ?1 ORDER BY createdAt ASC')
      .bind(organizationId)
      .all();
    sites = results || [];
  } catch (err) {
    console.warn(`${TAG} site list failed:`, err?.message || err);
    return null;
  }
  for (const site of sites) {
    if (excludeSiteId && String(site.id) === String(excludeSiteId)) continue;
    const r = await classifySiteEntitlement(db, site.id);
    if (r.kind === 'free' || r.kind === 'free-fallback') {
      return { id: site.id, domain: site.domain ?? null, name: site.name ?? null, kind: r.kind };
    }
  }
  return null;
}

/**
 * Move a site whose paid plan has ended onto the Free plan — if the account's Free slot
 * is open. Safe to call from any path, any number of times:
 *
 *   outcome          meaning
 *   'moved'          stamped now (or would be, in dry-run → 'dry-run')
 *   'already'        already on the Free fallback — nothing to do
 *   'entitled'       site is paid (live, or cancelled with time left) — nothing to do
 *   'free'           site never had a plan — it IS the free site already
 *   'blocked'        another site uses Free; this one stays blocked. `blockedBy` says which
 *   'off'            FREE_FALLBACK not enabled
 *   'error'          lookup failed; nothing written
 *
 * @param {object} opts  { siteId, organizationId?, trigger }  trigger is free text for the log
 */
export async function moveSiteToFreeIfAllowed(db, env, { siteId, organizationId = null, trigger = 'unknown' } = {}) {
  const mode = freeFallbackMode(env);
  if (!db || !siteId) return { outcome: 'error', reason: 'no-db-or-site' };
  if (mode === 'off') return { outcome: 'off' };

  let orgId = organizationId;
  let domain = null;
  try {
    const site = await db.prepare('SELECT id, organizationId, domain FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
    if (!site) return { outcome: 'error', reason: 'site-not-found' };
    orgId = orgId || site.organizationId || site.organizationid || null;
    domain = site.domain ?? null;
  } catch (err) {
    return { outcome: 'error', reason: err?.message || String(err) };
  }

  const state = await classifySiteEntitlement(db, siteId);
  if (state.error) return { outcome: 'error', reason: state.error };
  if (state.kind === 'paid') return { outcome: 'entitled', status: state.row?.status ?? null };
  if (state.kind === 'free') return { outcome: 'free' };
  if (state.kind === 'free-fallback') return { outcome: 'already', freeFallbackAt: state.freeFallbackAt };

  // 'lapsed' — the only state with a decision to make.
  const other = orgId ? await findOtherFreeSite(db, orgId, siteId) : null;
  if (other) {
    console.log(`${TAG} blocked — ${domain || siteId} stays inactive, Free already used by ${other.domain || other.id} (${trigger})`);
    flowLog(env, 'free-fallback', 'blocked', { siteId, domain, organizationId: orgId, blockedBy: other.domain || other.id, trigger });
    return { outcome: 'blocked', blockedBy: other };
  }

  if (mode === 'dry-run') {
    console.log(`${TAG} dry-run — would move ${domain || siteId} to Free (${trigger})`);
    flowLog(env, 'free-fallback', 'dry-run', { siteId, domain, organizationId: orgId, trigger });
    return { outcome: 'dry-run' };
  }

  try {
    await ensureFreeFallbackColumns(db);
    const now = new Date().toISOString();
    const res = await db
      .prepare(`UPDATE Site SET freeFallbackAt = ?1, freeFallbackReason = ?2, updatedAt = ?1 WHERE id = ?3 AND freeFallbackAt IS NULL`)
      .bind(now, String(trigger).slice(0, 120), siteId)
      .run();
    const changed = Number(res?.meta?.changes) || 0;
    if (!changed) return { outcome: 'already' }; // raced with the other worker — fine
    console.log(`${TAG} moved ${domain || siteId} to Free (${trigger})`);
    flowLog(env, 'free-fallback', 'moved', { siteId, domain, organizationId: orgId, trigger, at: now });
    return { outcome: 'moved', freeFallbackAt: now };
  } catch (err) {
    console.warn(`${TAG} move failed (non-fatal):`, err?.message || err);
    return { outcome: 'error', reason: err?.message || String(err) };
  }
}

/**
 * The site bought a plan again → it is no longer "the free site". Called from
 * saveSubscription (db.js) whenever a live tier subscription is written for a site, so
 * that when THAT plan ends later the rule is judged afresh against the account's
 * sites at that time, instead of an old stamp quietly making two sites Free.
 * Guarded and silent: a missing column or a failed write changes nothing else.
 */
export async function clearFreeFallbackForSite(db, siteId) {
  if (!db || !siteId) return false;
  try {
    const res = await db
      .prepare(`UPDATE Site SET freeFallbackAt = NULL, freeFallbackReason = NULL WHERE id = ?1 AND freeFallbackAt IS NOT NULL`)
      .bind(siteId)
      .run();
    const changed = Number(res?.meta?.changes) || 0;
    if (changed) console.log(`${TAG} cleared — ${siteId} has a live plan again`);
    return changed > 0;
  } catch (_) {
    return false; // column not there yet — nothing to clear
  }
}

/**
 * What a billing / dashboard response should say about this site. Additive fields:
 *   freeFallback     true when the site is served as Free after its plan ended
 *   freeFallbackAt   when that happened
 *   freeBlockedBy    { id, domain, name } of the site holding the Free slot — only for a
 *                    LAPSED site, so the UI can explain why this one did not move
 * Never throws; a failed read returns the empty shape.
 */
export async function freeFallbackFieldsForSite(db, siteId, organizationId = null) {
  const none = { freeFallback: false, freeFallbackAt: null, freeBlockedBy: null };
  if (!db || !siteId) return none;
  try {
    const state = await classifySiteEntitlement(db, siteId);
    if (state.kind === 'free-fallback') {
      return { freeFallback: true, freeFallbackAt: state.freeFallbackAt ?? null, freeBlockedBy: null };
    }
    if (state.kind !== 'lapsed') return none;
    let orgId = organizationId;
    if (!orgId) {
      const s = await db.prepare('SELECT organizationId FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
      orgId = s?.organizationId ?? s?.organizationid ?? null;
    }
    const other = orgId ? await findOtherFreeSite(db, orgId, siteId) : null;
    return { freeFallback: false, freeFallbackAt: null, freeBlockedBy: other ? { id: other.id, domain: other.domain, name: other.name } : null };
  } catch (err) {
    console.warn(`${TAG} fields lookup failed:`, err?.message || err);
    return none;
  }
}

/** Customer-facing sentence for a lapsed site that could not move to Free. */
export function freeBlockedMessage(blockedBy) {
  const who = blockedBy?.domain || blockedBy?.name || 'another site on your account';
  return `This site stayed inactive because ${who} already uses the one Free site included with your account. Choose a plan to turn the banner back on.`;
}
