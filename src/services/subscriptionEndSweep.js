// src/services/subscriptionEndSweep.js
//
// What happens after a customer stops paying.
//
// Two distinct moments, which this module keeps apart because the business cares
// about both:
//
//   canceledAt  the customer pressed cancel. Written by the Stripe webhook.
//               They are STILL entitled to the banner until the period they paid
//               for runs out, so nothing is checked here.
//   endedAt     the paid period actually lapsed. There is no Stripe event for
//               this — `customer.subscription.deleted` fires at cancel time, not
//               at period end — so it has to be swept for. Stamped here, once.
//
// Once a subscription has ended we re-check the site: is the ConsentBit script
// still in the page? That splits lapsed customers into two groups an operator
// needs to treat differently — those who removed the banner (gone), and those
// still serving it without paying (worth a conversation).
//
// Runs from the cron in src/index.js. The cron fires every minute, so the work is
// strictly bounded: a handful of sites per tick, each re-checked at most daily.

import { ensureSchema } from './db.js';
import { checkScriptForSite } from './scriptPresence.js';

/** Sites fetched per cron tick. The cron runs every minute — this is plenty. */
const BATCH_SIZE = 5;

/** How long before a site is looked at again. */
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Consecutive UNREACHABLE checks before a site is called removed.
 *
 * A site that blocks our fetcher is indistinguishable from one that was taken
 * down, so a single failure proves nothing. Note this counter only covers
 * transport failures — a page that loads cleanly WITHOUT the script is a direct
 * answer and is marked removed on the first check.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

let schemaReady = false;

async function ensureOnce(db) {
  if (schemaReady) return;
  await ensureSchema(db);
  schemaReady = true;
}

/** Stripe statuses that mean the subscription is over, not merely winding down. */
const ENDED_STATUSES = ['canceled', 'cancelled', 'unpaid', 'incomplete_expired'];

/**
 * Stamp endedAt on every subscription whose paid period has now run out.
 *
 * The currentPeriodEnd comparison is done in JS rather than SQL on purpose: the
 * column holds ISO strings on some rows and sqlite datetimes on others, so
 * `currentPeriodEnd <= datetime('now')` silently misses rows. The same reasoning
 * is spelled out around the cancellation grace check in services/db.js.
 *
 * @returns {Promise<number>} how many were stamped
 */
export async function stampEndedSubscriptions(db) {
  const { results = [] } = await db
    .prepare(
      `SELECT id, status, cancelAtPeriodEnd, currentPeriodEnd
         FROM Subscription
        WHERE endedAt IS NULL
          AND currentPeriodEnd IS NOT NULL
          AND (LOWER(COALESCE(status,'')) IN (${ENDED_STATUSES.map(() => '?').join(',')})
               OR COALESCE(cancelAtPeriodEnd, 0) = 1)
        LIMIT 200`
    )
    .bind(...ENDED_STATUSES)
    .all();

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let stamped = 0;

  for (const row of results) {
    const raw = row.currentPeriodEnd ?? row.currentperiodend ?? null;
    if (!raw) continue;
    const endMs = Date.parse(String(raw).replace(' ', 'T'));
    if (!Number.isFinite(endMs) || endMs > now) continue; // still inside the paid period

    try {
      await db
        .prepare(`UPDATE Subscription SET endedAt = ?1, updatedAt = ?1 WHERE id = ?2 AND endedAt IS NULL`)
        .bind(nowIso, row.id)
        .run();
      stamped++;
    } catch (err) {
      console.error('[endSweep] could not stamp endedAt', row.id, err?.message || err);
    }
  }

  if (stamped) console.log(`[endSweep] ${stamped} subscription(s) reached period end`);
  return stamped;
}

/**
 * Sites whose subscription has lapsed and that are due a script check.
 *
 * Excluded: sites already concluded 'removed' (a terminal answer — there is
 * nothing left to watch), sites checked within the last day, and sites whose
 * organization has since taken out a live subscription again.
 */
async function findSitesDueForCheck(db, limit) {
  const cutoff = new Date(Date.now() - RECHECK_AFTER_MS).toISOString();
  const { results = [] } = await db
    .prepare(
      `SELECT s.id, s.name, s.domain, s.customDomain, s.cdnScriptId, s.organizationId,
              s.scriptStatus, s.scriptCheckedAt, COALESCE(s.scriptCheckFailures, 0) AS failures
         FROM Site s
        WHERE COALESCE(s.scriptStatus, '') <> 'removed'
          AND (s.scriptCheckedAt IS NULL OR s.scriptCheckedAt < ?1)
          AND EXISTS (
                SELECT 1 FROM Subscription sub
                 WHERE sub.endedAt IS NOT NULL
                   AND (sub.siteId = s.id
                        OR (sub.siteId IS NULL AND sub.organizationId = s.organizationId))
              )
          AND NOT EXISTS (
                SELECT 1 FROM Subscription live
                 WHERE (live.siteId = s.id
                        OR (live.siteId IS NULL AND live.organizationId = s.organizationId))
                   AND LOWER(COALESCE(live.status, '')) IN ('active', 'trialing')
              )
        ORDER BY COALESCE(s.scriptCheckedAt, '') ASC
        LIMIT ?2`
    )
    .bind(cutoff, limit)
    .all();
  return results;
}

/**
 * Turn one check result into the row update.
 * Exported for the sake of being testable without a network or a database.
 */
export function decideStatus(result, previousFailures) {
  if (result.ok) {
    return result.found
      ? { status: 'present', failures: 0 }
      : { status: 'removed', failures: 0, reason: 'page loaded, no ConsentBit script' };
  }

  const failures = (Number(previousFailures) || 0) + 1;
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    return {
      status: 'removed',
      failures,
      reason: `unreachable ${failures}x (${result.error || 'no response'})`,
    };
  }
  return { status: 'unknown', failures, reason: result.error || 'unreachable' };
}

async function applyResult(db, site, result) {
  const decision = decideStatus(result, site.failures);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `UPDATE Site
          SET scriptStatus = ?1,
              scriptCheckedAt = ?2,
              scriptCheckFailures = ?3,
              -- First time we concluded it was gone; left alone on later checks
              -- so the date keeps meaning "when it disappeared".
              scriptRemovedAt = CASE WHEN ?1 = 'removed' THEN COALESCE(scriptRemovedAt, ?2)
                                     ELSE scriptRemovedAt END
        WHERE id = ?4`
    )
    .bind(decision.status, nowIso, decision.failures, site.id)
    .run();

  console.log(
    `[endSweep] ${site.domain || site.id} → ${decision.status}` +
      (decision.reason ? ` (${decision.reason})` : '') +
      (result.how ? ` [${result.how}]` : '')
  );
  return decision.status;
}

/**
 * Check the next batch of lapsed sites.
 * @returns {Promise<number>} how many were checked
 */
export async function runDueScriptChecks(db, limit = BATCH_SIZE) {
  const sites = await findSitesDueForCheck(db, limit);
  if (!sites.length) return 0;

  await Promise.all(
    sites.map(async (site) => {
      try {
        const result = await checkScriptForSite(site);
        await applyResult(db, site, result);
      } catch (err) {
        console.error('[endSweep] check failed', site.domain || site.id, err?.message || err);
      }
    })
  );
  return sites.length;
}

/**
 * Cron entry point. Never throws — a failure here must not take down the other
 * scheduled jobs sharing the tick.
 */
export async function processSubscriptionEndSweep(env) {
  const db = env?.CONSENT_WEBAPP;
  if (!db) return;

  try {
    await ensureOnce(db);
    await stampEndedSubscriptions(db);
    await runDueScriptChecks(db);
  } catch (err) {
    console.error('[endSweep] sweep failed', err?.message || err);
  }
}
