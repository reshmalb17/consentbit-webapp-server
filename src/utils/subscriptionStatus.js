// src/utils/subscriptionStatus.js
//
// Stripe subscription statuses from which a subscription can never recover.
//
// A subscription in one of these states cannot be updated, resumed or reactivated.
// Stripe's own error, quoted in webflowBilling.js:
//   "A canceled subscription can only update its cancellation_details and metadata."
// The only way to give that customer a paid plan again is a NEW subscription via checkout.
//
// `deleted` is not a real Stripe status. It is written into our D1 by syncEvent.js when the
// old dashboard system handles a Stripe cancellation, so it is included for D1-sourced
// statuses. Stripe itself will report such a subscription as `canceled`.
//
// Kept in step with TERMINAL_STATUSES in consentbitwebapp-Test/lib/subscription-state.ts.

export const TERMINAL_SUBSCRIPTION_STATUSES = Object.freeze([
  'canceled',
  'cancelled',
  'deleted',
  'unpaid',
  'incomplete_expired',
]);

/** True when the status is terminal. Unknown / empty → false. */
export function isTerminalSubscriptionStatus(status) {
  if (!status) return false;
  return TERMINAL_SUBSCRIPTION_STATUSES.includes(String(status).trim().toLowerCase());
}

/** Customer-facing message used wherever a change is attempted on a terminal subscription. */
export const TERMINAL_SUBSCRIPTION_MESSAGE =
  'This subscription has ended and can no longer be changed. Please choose a plan to start a new subscription — your site, settings and installed script carry over.';
