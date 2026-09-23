// src/handlers/framerResumeSubscription.js
//
// Undo a scheduled cancellation for a FRAMER site — the ONE thing this file does.
//
//   POST /api/framer/resume-subscription   body { siteId }
//     → 200 { success:true, cancelAtPeriodEnd:false, status, currentPeriodEnd }
//     → 409 { success:false, ended:true,    error }  period already over in Stripe
//     → 404 { success:false, notFound:true, error }  D1 points at a sub Stripe cannot see
//
// WHY THIS EXISTS
//
// Clearing `cancel_at_period_end` keeps the SAME subscription renewing: same plan, same
// billing date, same saved card, no new checkout. Until now the only route back for a
// cancelled Framer site was the Profile tab's "Subscribe Now" link into a fresh checkout,
// which opens a SECOND subscription while the first is still paid up (the checkout's
// double-billing guard only catches an ACTIVE plan, not a cancelled one) — so the customer
// pays twice for the overlap. This is the Framer twin of the Webflow fix.
//
// RELATION TO THE WEBFLOW TWIN (handlers/webflowBillingWf.js → handleWebflowResumeSubscription)
//
// The Stripe call, the error classification and the D1 reconcile are ported from it
// verbatim, so both platforms behave identically and one bug fix applies to both. Two
// things differ, both on purpose:
//
//   1. AUTH. The Webflow route sits behind middleware/webflowIdentity.js (a Webflow ID
//      token, which Framer cannot mint). Here the gate is requireFramerAuth() — the same
//      JWT check the /api/framer/upgrade/* routes already use, imported from
//      framerUpgrade.js rather than copied, so there is only one JWT verifier to audit.
//      Note this makes resume STRICTER than its authless siblings /api/framer/billing and
//      /api/framer/cancel-subscription: it is a brand-new route with no existing callers,
//      so there was no back-compat reason to leave it open.
//
//   2. SUBSCRIPTION RESOLUTION. The Webflow twin falls back to the ORGANIZATION's newest
//      active subscription when the site has no row of its own. This file does not: it
//      resolves THIS SITE'S OWN row and nothing else. On a resume that fallback would aim
//      the write at a SIBLING site's subscription — the exact per-account-instead-of-
//      per-site class of bug that cdnM.js and the custom checkout were just fixed for.
//      A site with no subscription row of its own has nothing to resume and gets a 400.
//
// ADDITIVE ONLY: no existing handler, route or response shape is touched. The only other
// edits for this feature are the import + route case in index.js, its path in PUBLIC_PATHS
// (transport only — authorization is enforced below), and the `export` keyword added to
// requireFramerAuth in framerUpgrade.js.

import { requireFramerAuth } from './framerUpgrade.js';

const TAG = '[framer-resume]';

/** Stripe unix seconds → ISO string, or null. */
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

/** D1 rows come back camelCase or all-lowercase depending on the driver path. */
function pick(row, camel, snake) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

/**
 * Site row from a Framer platformSiteId OR an internal webapp Site.id — the plugin sends
 * whichever it has. Selects exactly the columns requireFramerAuth() needs to bind a token.
 */
async function resolveSite(db, siteId) {
  if (!siteId) return null;
  return db
    .prepare(
      `SELECT id, organizationId, platformSiteId FROM Site
        WHERE id = ?1 OR platformSiteId = ?1
        ORDER BY createdAt ASC LIMIT 1`,
    )
    .bind(siteId)
    .first()
    .catch((e) => {
      console.warn(`${TAG} site lookup failed`, e?.message);
      return null;
    });
}

/**
 * THIS SITE'S own subscription — never the organization's (see the header note).
 *
 * A site accumulates rows over time (cancel → resubscribe, tier changes), so order
 * deterministically: active/trialing first, then most recently touched. A subscription
 * that is merely SCHEDULED to cancel is still 'active' in Stripe, so the row this picks
 * is the one a resume should target.
 */
async function resolveOwnSubscription(db, site) {
  if (!site) return null;
  return db
    .prepare(
      `SELECT id, organizationId, siteId, planId, status, stripeSubscriptionId,
              interval, currentPeriodEnd, cancelAtPeriodEnd
         FROM Subscription WHERE siteId = ?1
        ORDER BY CASE WHEN lower(status) IN ('active','trialing') THEN 0 ELSE 1 END,
                 datetime(COALESCE(updatedAt, createdAt)) DESC
        LIMIT 1`,
    )
    .bind(site.id)
    .first()
    .catch((e) => {
      console.warn(`${TAG} subscription lookup failed`, e?.message);
      return null;
    });
}

/**
 * Stripe is the judge of whether a subscription can still be resumed — not our D1 copy,
 * which can hold a stale future currentPeriodEnd for a plan Stripe already deleted. So we
 * always attempt the update and classify Stripe's answer.
 */
export async function handleFramerResumeSubscription(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const siteId = String(body?.siteId || '').trim();
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  // Resolve the site FIRST — the auth gate binds the caller's token to this site row.
  const site = await resolveSite(db, siteId);
  const auth = await requireFramerAuth(request, env, site);
  if (!auth.ok) return auth.res;

  const sub = await resolveOwnSubscription(db, site);
  const stripeSubscriptionId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  if (!stripeSubscriptionId) {
    return Response.json(
      { success: false, error: 'No subscription found for this site.' },
      { status: 400 },
    );
  }

  const params = new URLSearchParams();
  params.set('cancel_at_period_end', 'false');
  let data;
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    data = await res.json();
  } catch (e) {
    // Stripe unreachable — nothing was changed, so this is safe to retry.
    console.error(`${TAG} Stripe request failed`, e?.message || e);
    return Response.json(
      { success: false, error: 'Could not reach billing. Please try again in a moment.' },
      { status: 502 },
    );
  }

  if (data.error) {
    const errMsg = String(data.error?.message || '');

    // Not found for THIS Stripe key — NOT the same as ended. The D1 row points at a
    // subscription this key cannot see (created under a different key/mode). Telling the
    // customer it "ended" would be wrong, and so would sending them to a new checkout
    // while their plan may still be running — this needs a human, not a button.
    if (data.error?.code === 'resource_missing') {
      console.warn(`${TAG} resume refused — subscription not found in Stripe`, { siteId, stripeSubscriptionId });
      return Response.json(
        {
          success: false,
          notFound: true,
          error: "We couldn't find this subscription in billing, so it can't be resumed here. Please contact support.",
        },
        { status: 404 },
      );
    }

    // Fully ended in Stripe (the paid period is over) → not resumable; a new subscription
    // via checkout is the only way back.
    const ended =
      /canceled subscription can only update/i.test(errMsg) ||
      data.error?.code === 'subscription_already_canceled';
    if (ended) {
      console.warn(`${TAG} resume refused — subscription has ended`, { siteId, stripeSubscriptionId, code: data.error?.code });
      // Reconcile D1 with what Stripe just told us. A subscription cancelled IMMEDIATELY
      // (Stripe DELETE — e.g. a checkout replacing an old plan) leaves D1 holding the old
      // FUTURE currentPeriodEnd, which is indistinguishable from "cancelled, still running
      // until <date>". That is what makes an app offer Resume on a plan that is already
      // gone, then keep saying "ends on <date>" next to this error. Take the real end date
      // from Stripe so every screen reads it as ended from now on.
      try {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const live = await subRes.json();
        if (!live.error && String(live.status || '').toLowerCase() === 'canceled') {
          const endedAtISO = iso(live.ended_at) || iso(live.canceled_at) || new Date().toISOString();
          await db
            .prepare(
              `UPDATE Subscription
                  SET status = 'canceled', cancelAtPeriodEnd = 0,
                      canceledAt = COALESCE(?1, canceledAt), endedAt = COALESCE(?2, endedAt),
                      currentPeriodEnd = ?2, updatedAt = ?3
                WHERE stripeSubscriptionId = ?4`,
            )
            .bind(iso(live.canceled_at), endedAtISO, new Date().toISOString(), stripeSubscriptionId)
            .run();
          console.warn(`${TAG} D1 reconciled — subscription ended at ${endedAtISO}`, { stripeSubscriptionId });
        }
      } catch (e) {
        // Non-fatal: the customer still gets the correct message below.
        console.warn(`${TAG} D1 reconcile after ended-resume failed (non-fatal)`, e?.message);
      }
      return Response.json(
        {
          success: false,
          ended: true,
          error: 'This subscription has already ended and can no longer be resumed. Choose a plan to start a new one.',
        },
        { status: 409 },
      );
    }

    console.error(`${TAG} Stripe resume error`, data.error?.message);
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
  }

  // Stripe accepted: its status is the truth. D1 can still say 'canceled' for a
  // subscription that was only SCHEDULED to cancel, which would keep the site reading as
  // cancelled — so write the live status back along with the cleared flag.
  const liveStatus = String(data.status || '').toLowerCase() || null;
  try {
    await db
      .prepare(
        `UPDATE Subscription
            SET cancelAtPeriodEnd = 0,
                canceledAt = NULL,
                status = COALESCE(?1, status),
                updatedAt = ?2
          WHERE stripeSubscriptionId = ?3`,
      )
      .bind(liveStatus, new Date().toISOString(), stripeSubscriptionId)
      .run();
  } catch (e) {
    // Non-fatal: the customer.subscription.updated webhook re-syncs this row.
    console.warn(`${TAG} D1 update after resume failed (non-fatal)`, e?.message);
  }

  console.warn(`${TAG} resumed`, { siteId, stripeSubscriptionId, status: liveStatus });
  return Response.json({
    success: true,
    cancelAtPeriodEnd: false,
    status: liveStatus,
    currentPeriodEnd: iso(data.current_period_end),
  });
}
