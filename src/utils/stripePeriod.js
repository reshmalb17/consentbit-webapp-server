// src/utils/stripePeriod.js
//
// Read a Stripe subscription's billing period regardless of API version.
//
// Stripe API 2025-03-31 moved `current_period_start` / `current_period_end` off the
// subscription object and onto each subscription item (`items.data[n].current_period_end`).
//
// This matters twice over here:
//  - The webhook endpoint is pinned to an older version, so events still carry the fields
//    on the subscription. Upgrading it in the Stripe dashboard would silently drop them.
//  - Direct `fetch('/v1/subscriptions/...')` calls send no `Stripe-Version` header, so they
//    use the ACCOUNT default — which is already on the newer shape. Those reads can miss
//    the field today.
//
// A missing period end is not harmless: `saveSubscription` writes it on every update, so
// it would be overwritten with null, and the banner gate (cdnM.js) treats a cancelled
// subscription with no period end as ended — blocking a customer who has paid through a
// future date.
//
// Same class of drift as `invoice.subscription` → `invoice.parent.subscription_details`,
// already handled in stripeWebhook.js.

function firstItem(sub) {
  return sub?.items?.data?.[0] ?? null;
}

/** Unix seconds, or null. Subscription-level first (older API), then first item (newer). */
export function periodStartOf(sub) {
  return sub?.current_period_start ?? firstItem(sub)?.current_period_start ?? null;
}

/** Unix seconds, or null. Subscription-level first (older API), then first item (newer). */
export function periodEndOf(sub) {
  return sub?.current_period_end ?? firstItem(sub)?.current_period_end ?? null;
}
