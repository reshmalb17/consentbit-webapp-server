// src/services/siteSubscriptionEnded.js
//
// "Has THIS site's own paid subscription ended?" — one answer, one place.
//
// The rule is judged on the site's own subscription and never the account's: a sibling
// site's live plan must not grant rights here. That is the same principle the banner gate
// and checkout follow, and the thing that went wrong when fomo.com was judged on
// flockler.com's healthy subscription.
//
// A FREE site is not ended. Free is a plan; "cancelled and expired" is not. A site with no
// subscription row at all has never had one, so there is nothing to have ended.
//
// Why status alone decides it, with no date check: a SCHEDULED cancellation keeps
// status 'active' with cancelAtPeriodEnd=1 (cancelSubscription.js), so a terminal status
// here always means Stripe has already ended the subscription. An immediate cancellation
// keeps the period it died inside, leaving a FUTURE currentPeriodEnd that is stale rather
// than owed — requiring the period to be over let exactly those rows keep their access.
//
// NOTE: handlers/bannerCustomization.js carries this same rule inline (added 2026-09-25).
// It is deliberately left alone here rather than refactored mid-incident; point it at this
// helper next time that file is touched, so the rule stops living in two places.

/** Stripe statuses a subscription can never come back from. */
export const TERMINAL_STATUSES = Object.freeze([
  'canceled',
  'cancelled',
  'deleted',
  'unpaid',
  'incomplete_expired',
]);

/**
 * @returns {Promise<{ended: boolean, status: string|null, periodEnd: string|null}>}
 *   `ended` is false whenever the question cannot be answered — no row, or the lookup
 *   failed. Refusing service on a failed read would punish the customer for our outage,
 *   so this fails OPEN by design. Callers that need certainty must check `status`.
 */
export async function getSiteSubscriptionEnded(db, siteId) {
  const none = { ended: false, status: null, periodEnd: null };
  if (!db || !siteId) return none;

  try {
    const row = await db
      .prepare(
        // A live row always outranks a dead one, however recently the dead one was
        // touched: a site that cancelled and then re-subscribed holds both, and ordering
        // by updatedAt alone would let a webhook replay or a reconcile write on the old
        // row make a PAYING site read as ended.
        `SELECT status, currentPeriodEnd FROM Subscription WHERE siteId = ?1
          ORDER BY CASE WHEN LOWER(status) IN ('active','trialing') THEN 0 ELSE 1 END,
                   datetime(COALESCE(updatedAt, createdAt)) DESC
          LIMIT 1`,
      )
      .bind(siteId)
      .first();

    if (!row) return none;

    const status = String(row.status ?? row.Status ?? '').trim().toLowerCase();
    return {
      ended: TERMINAL_STATUSES.includes(status),
      status: status || null,
      periodEnd: row.currentPeriodEnd ?? row.currentperiodend ?? null,
    };
  } catch (err) {
    console.warn('[siteSubscriptionEnded] lookup failed (failing open):', err?.message || err);
    return none;
  }
}

/** The refusal every caller should return, so the wording stays identical everywhere. */
export function subscriptionEndedResponse(action = 'run') {
  return Response.json(
    {
      success: false,
      code: 'SUBSCRIPTION_ENDED',
      error: `Your plan has ended, so scans can no longer be ${action}. Choose a plan to start again.`,
    },
    { status: 402 },
  );
}
