// src/services/stripeCardPin.js
//
// Card-on-file helpers for subscriptions.
//
// STRIPE CONSTRAINT — a subscription's card pin cannot be removed
// A subscription's `default_payment_method` cannot be cleared once set. Stripe's API spec
// types it as a plain `string` on subscription update, while the neighbouring
// `default_source` is `Emptyable<string>` (null | '' | string) — the marker for parameters
// that accept an empty value to unset them. Confirmed in stripe-node 18.1.0 and 20.1.2
// (API 2025-12-15.clover). Sending `default_payment_method=''` is rejected.
//
// An earlier version of this module tried exactly that ("unpin after first payment"). It
// could never have worked, and the checkout change made alongside it — switching
// `save_default_payment_method` to `off` — actually removed Stripe's own self-healing.
// Both are reverted. Neither was deployed.
//
// THE CORRECT STRATEGY — keep the pin pointing at the current card
// Since the pin cannot be removed, renewals charge the right card only if the pin is kept
// in step with the customer's card. Three mechanisms do that:
//   1. updatePaymentMethod.js — our billing page sets the customer default AND the
//      subscription pin to the new card. Already correct.
//   2. payment_settings.save_default_payment_method = 'on_subscription' — "Stripe updates
//      subscription.default_payment_method when payment succeeds", so a card that
//      successfully pays an invoice becomes the pin. Must stay on.
//   3. Cards changed OUTSIDE our app (Stripe billing portal / dashboard) update only the
//      customer default and leave the pin on the old card. NOT YET HANDLED — needs a
//      `customer.updated` webhook that re-pins active subscriptions to the new default.
//
// What this module still does, and why it is still worth doing:
//   - setCustomerDefaultCard: neither checkout sets the customer's invoice default (custom
//     checkout only attaches the card; hosted Checkout puts it on the subscription). A
//     populated customer default is what Stripe's billing portal shows and edits, what any
//     subscription without its own pin falls back to, and the baseline mechanism 3 needs.
//   - displayPaymentMethodId: shows the card actually on file, whichever level it is on.
//
// Nothing here throws, and nothing here ever touches the subscription's pin.

const STRIPE = 'https://api.stripe.com/v1';

/**
 * Customer metadata key stamped whenever OUR code sets the customer's default card.
 *
 * services/cardPinFollow.js re-pins subscriptions when a customer's default card changes,
 * but only for changes made OUTSIDE our app (Stripe billing portal / dashboard). Our own
 * writes must not trigger it — checkout sets the default to the card just used for a NEW
 * site, and following that would move the customer's OTHER sites onto it (e.g. an agency's
 * site A moved onto client B's card).
 *
 * The stamp is written in the same request as the default card, so both change in one
 * `customer.updated` event and the key appears in `previous_attributes.metadata`.
 */
export const CARD_DEFAULT_MARKER = 'cb_default_card_set_at';

/** Form fields that stamp the marker. Add to any request that sets the customer default card. */
export function cardDefaultMarkerParams(now = new Date()) {
  return { [`metadata[${CARD_DEFAULT_MARKER}]`]: now.toISOString() };
}

/** Stripe fields may be an id string or an expanded object. */
function idOf(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id ?? null;
}

/** Make this card the customer's default for invoices. Returns true on success. */
export async function setCustomerDefaultCard(secret, customerId, paymentMethodId) {
  if (!secret || !customerId || !paymentMethodId) return false;
  try {
    const res = await fetch(`${STRIPE}/customers/${customerId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'invoice_settings[default_payment_method]': paymentMethodId,
        ...cardDefaultMarkerParams(),
      }).toString(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) {
      console.warn('[CardPin] could not set customer default card', data?.error?.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[CardPin] setCustomerDefaultCard failed', e?.message);
    return false;
  }
}

/**
 * Hosted Checkout: copy the card Checkout put on the subscription onto the customer's
 * invoice default. The subscription's own pin is left exactly as it is.
 */
export async function syncCustomerDefaultFromSubscription(secret, subscriptionId) {
  if (!secret || !subscriptionId) return;
  try {
    const res = await fetch(`${STRIPE}/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const sub = await res.json().catch(() => null);
    if (!res.ok || !sub || sub.error) {
      console.warn('[CardPin] could not read subscription', { subscriptionId, error: sub?.error?.message });
      return;
    }
    const card = idOf(sub.default_payment_method);
    if (!card) return;
    await setCustomerDefaultCard(secret, idOf(sub.customer), card);
  } catch (e) {
    console.warn('[CardPin] syncCustomerDefaultFromSubscription failed', e?.message);
  }
}

/**
 * The card to SHOW as "on file" for a subscription: its own pin if it has one, otherwise
 * the customer's invoice default. Returns a payment method id or null.
 *
 * A subscription created without a pin has an empty default_payment_method and falls back
 * to the customer default for charging — so reading only the pin would show no card.
 */
export async function displayPaymentMethodId(secret, subscription) {
  const own = idOf(subscription?.default_payment_method);
  if (own) return own;
  const customerId = idOf(subscription?.customer);
  if (!secret || !customerId) return null;
  try {
    const res = await fetch(`${STRIPE}/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const cust = await res.json().catch(() => null);
    return idOf(cust?.invoice_settings?.default_payment_method);
  } catch {
    return null;
  }
}
