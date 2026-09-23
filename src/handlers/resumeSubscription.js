// POST /api/subscriptions/resume
// Body: { stripeSubscriptionId } or { subscriptionId } — subscription ID is required.
//
// Undo a scheduled cancellation: clear cancel_at_period_end so the SAME subscription
// renews as normal. The customer keeps their plan, billing date and saved card — no new
// checkout. Before this existed the only way back was "Subscribe now", which started a
// SECOND subscription while the first was still paid up (the checkout's double-billing
// guard only catches an active plan, not a cancelled one), charging twice for the overlap.
//
// This is the webapp (session-cookie) twin of handleWebflowResumeSubscription in
// handlers/webflowBillingWf.js, which serves the Designer app off the Webflow ID token.
// Identity, owner-only gating and the legacy sync mirror handlers/cancelSubscription.js —
// resuming is the exact inverse of cancelling, so it must be available to exactly the
// same people.
//
// Stripe is the judge of whether it can still be resumed. A subscription whose period has
// already ended is fully `canceled` in Stripe and cannot be updated; that comes back as
// { ended: true } so the app can offer a fresh checkout instead.

import { getSessionById, getUserById, getSubscriptionByStripeId, getSubscriptionById, saveSubscription, getSiteById } from '../services/db.js';
import { syncSubscriptionUpdateToLegacy } from '../services/syncLegacy.js';
import { resolveBillingActor } from '../services/team.js';

const TAG = '[ResumeSubscription]';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleResumeSubscription(request, env, ctx) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const stripeSubscriptionId = (body.stripeSubscriptionId || body.stripe_subscription_id || '').trim() || null;
  const subscriptionId = (body.subscriptionId || body.subscription_id || '').trim() || null;

  if (!env.STRIPE_SECRET_KEY) {
    console.error(`${TAG} STRIPE_SECRET_KEY not set`);
    return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });
  }

  let sub = null;
  if (stripeSubscriptionId) {
    sub = await getSubscriptionByStripeId(db, stripeSubscriptionId);
  }
  if (!sub && subscriptionId) {
    sub = await getSubscriptionById(db, subscriptionId);
  }
  if (!sub) {
    console.warn(`${TAG} no subscription found for stripeSubId:`, stripeSubscriptionId, '| subscriptionId:', subscriptionId);
    return Response.json({ success: false, error: 'No subscription found for this account.' }, { status: 400 });
  }

  // Same gate as cancel: a team Admin can't decide the account keeps paying, that's the
  // owner's call.
  {
    const orgIdForActor = sub.organizationId ?? sub.organizationid;
    const actor = orgIdForActor
      ? await resolveBillingActor(db, user.id, orgIdForActor, sub.siteId ?? sub.siteid ?? null)
      : null;
    if (actor?.admin) {
      return Response.json(
        { success: false, error: 'Only the account owner can resume this subscription.', code: 'OWNER_ONLY' },
        { status: 403 },
      );
    }
  }

  const subStripeId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null;
  if (!subStripeId) {
    return Response.json({ success: false, error: 'Subscription has no Stripe ID' }, { status: 400 });
  }

  const params = new URLSearchParams();
  params.set('cancel_at_period_end', 'false');
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();

  if (data.error) {
    const errMsg = String(data.error?.message || '');

    // Not found for this Stripe key — NOT the same as ended. The D1 row points at a
    // subscription this key can't see (e.g. created under a different key/mode). Telling
    // the customer it "ended" would be wrong, and so would sending them to a new checkout
    // while their plan may still be running — so this needs a human, not a button.
    if (data.error?.code === 'resource_missing') {
      console.warn(`${TAG} resume refused — subscription not found in Stripe`, { subStripeId });
      return Response.json(
        { success: false, notFound: true, error: "We couldn't find this subscription in billing, so it can't be resumed here. Please contact support." },
        { status: 404 },
      );
    }

    // Fully ended in Stripe (period over) → can't be resumed; a new subscription via
    // checkout is the only way back.
    const ended =
      /canceled subscription can only update/i.test(errMsg) ||
      data.error?.code === 'subscription_already_canceled';
    if (ended) {
      console.warn(`${TAG} resume refused — subscription has ended`, { subStripeId, code: data.error?.code });
      // Reconcile D1 with what Stripe just told us. A subscription cancelled IMMEDIATELY
      // (Stripe DELETE — e.g. checkout replacing an old plan) leaves D1 holding the old
      // FUTURE currentPeriodEnd, which is indistinguishable from "cancelled, still running
      // until <date>". That is why the app offered Resume on a plan that was already gone,
      // and kept saying "will end on <date>" next to this error. Take the real end date
      // from Stripe so every screen reads it as ended from now on.
      try {
        const liveRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const live = await liveRes.json();
        if (!live.error && String(live.status || '').toLowerCase() === 'canceled') {
          const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
          const endedAtISO = iso(live.ended_at) || iso(live.canceled_at) || new Date().toISOString();
          await db
            .prepare(
              `UPDATE Subscription
                  SET status = 'canceled', cancelAtPeriodEnd = 0,
                      canceledAt = COALESCE(?1, canceledAt), endedAt = COALESCE(?2, endedAt),
                      currentPeriodEnd = ?2, updatedAt = ?3
                WHERE stripeSubscriptionId = ?4`,
            )
            .bind(iso(live.canceled_at), endedAtISO, new Date().toISOString(), subStripeId)
            .run();
          console.warn(`${TAG} D1 reconciled — subscription ended at ${endedAtISO}`, { subStripeId });
        }
      } catch (e) {
        // Non-fatal: the customer still gets the correct message below.
        console.warn(`${TAG} D1 reconcile after ended-resume failed (non-fatal)`, e?.message);
      }
      return Response.json(
        { success: false, ended: true, error: 'This subscription has already ended and can no longer be resumed. Choose a plan to start a new one.' },
        { status: 409 },
      );
    }

    console.error(`${TAG} Stripe error:`, data.error);
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
  }

  // Update DB immediately (the webhook also updates, but this ensures we don't wait).
  // Mirrors the cancel path's write so the two stay symmetrical.
  const planType = String(sub.planType ?? sub.plantype ?? 'single').toLowerCase();
  await saveSubscription(db, {
    id: sub.id,
    organizationId: sub.organizationId ?? sub.organizationid,
    siteId: sub.siteId ?? sub.siteid,
    stripeSubscriptionId: subStripeId,
    stripeCustomerId: sub.stripeCustomerId ?? sub.stripecustomerid,
    stripePriceId: sub.stripePriceId ?? sub.stripepriceid,
    // Passed through deliberately: saveSubscription's ON CONFLICT clause assigns
    // `planId = ?8` unconditionally, so omitting it (as the cancel path does) writes NULL
    // and strips the customer's tier. Resuming must not cost them their plan.
    planId: sub.planId ?? sub.planid ?? null,
    planType,
    interval: sub.interval ?? 'monthly',
    status: 'active',
    currentPeriodStart: sub.currentPeriodStart ?? sub.currentperiodstart,
    currentPeriodEnd: data.current_period_end
      ? new Date(data.current_period_end * 1000).toISOString()
      : (sub.currentPeriodEnd ?? sub.currentperiodend),
    cancelAtPeriodEnd: 0,
    licenseKey: sub.licenseKey ?? sub.licensekey,
    licenseKeys: sub.licenseKeys ?? sub.licensekeys,
    quantity: sub.quantity ?? sub.Quantity,
  });

  // Outbound sync → LEGACY_DB + KV (fire-and-forget, must not block response)
  try {
    const siteId = sub.siteId ?? sub.siteid;
    const site = siteId ? await getSiteById(db, siteId) : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: user?.email || null,
      domain: site?.domain || null,
      subscriptionId: subStripeId,
      customerId: sub.stripeCustomerId ?? sub.stripecustomerid,
      status: 'active',
      cancelAtPeriodEnd: false,
      // See changeTier.js — legacySource alone misses non-legacy Webflow/Framer plugin sites.
      platform: site?.legacySource || site?.platform || null,
      interval: sub.interval ?? 'monthly',
    });
  } catch (syncErr) {
    console.warn(`${TAG} Legacy sync failed (non-critical):`, syncErr?.message);
  }

  return Response.json({
    success: true,
    cancelAtPeriodEnd: false,
    status: data.status || 'active',
    currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end * 1000).toISOString() : null,
    message: 'Your subscription is active again and will renew as normal.',
  });
}
