# Billing Interval Switch (Monthly ↔ Yearly)

How an existing subscription moves between monthly and yearly billing, when the
customer is charged, what happens to feature access, and where everything lands
in Stripe.

- **Handler:** [`src/handlers/switchBillingInterval.js`](../src/handlers/switchBillingInterval.js)
- **Endpoints (proxied from the webapp):**
  - `POST /api/subscriptions/switch-interval` → commit the switch
  - `POST /api/subscriptions/switch-interval/preview` → preview the prorated balance (no change)
- **Body for both:** `{ organizationId, targetInterval: 'monthly' | 'yearly' }`

The switch happens **in place** via a Stripe subscription update — no checkout
redirect.

---

## Key point: features never change on a switch

A switch is always **within the same tier**. The handler rejects anything that
isn't a same-plan interval swap:

```js
if (!['basic', 'essential', 'growth'].includes(planId)) {
  return { error: fail('Cannot switch interval for this plan type', 400) };
}
// new price = SAME tier, different interval
const newPriceId = tierPriceMap[planId]?.[targetInterval];
```

Monthly and yearly of the same plan have **identical features**. Only billing
frequency and price differ. Feature access is therefore **continuous** across a
switch — there is no gap and no "monthly features vs yearly features."

The only thing that differs between the two directions is **when money moves**,
because the code treats the directions asymmetrically.

---

## Monthly → Yearly (charged immediately)

```js
const updateParams = new URLSearchParams({
  'items[0][id]': subItemId,
  'items[0][price]': newPriceId,
  proration_behavior: 'create_prorations',
});
if (targetInterval === 'yearly' && !isTrialing) {
  updateParams.set('billing_cycle_anchor', 'now');
}
```

- `billing_cycle_anchor: 'now'` + `create_prorations` makes Stripe **close the
  current period and invoice immediately**.
- The card on file is charged **right away** = full yearly price **minus a
  credit** for the unused days left in the current monthly period.
- The new annual period **starts now** and runs 12 months; `currentPeriodEnd` is
  updated to ~1 year out.
- Features: unchanged, continuous.

The preview endpoint mirrors this — it sets `subscription_billing_cycle_anchor: 'now'`
and returns `amountDueCents` as the amount charged immediately.

## Yearly → Monthly (no immediate charge)

For this direction the anchor is **not** reset — only `proration_behavior:
'create_prorations'` applies (the `billing_cycle_anchor` block is skipped because
`targetInterval !== 'yearly'`).

- No immediate invoice. Stripe records proration line items — a **credit** for
  the unused portion of the year already paid — that offset **future** monthly
  invoices.
- In practice the customer already paid for a full year, so that credit covers
  upcoming monthly charges; they aren't billed again until the credit is
  exhausted.
- Features: unchanged, continuous.

### Trial edge case

While the subscription is still trialing, Stripe rejects `billing_cycle_anchor=now`
("Trial end cannot be after billing_cycle_anchor"). During a trial there is
nothing to prorate, so the handler keeps the remaining trial and bills the new
price at trial end. The preview returns the new plan's recurring price (what will
be billed when the trial converts) instead of a prorated amount.

---

## Summary

| Direction | When money is deducted | Feature access |
|---|---|---|
| Monthly → Yearly | **Immediately** — yearly price minus unused-monthly credit, charged to the card on file now | Same tier, continuous (no gap) |
| Yearly → Monthly | **Not now** — unused-year credit is applied against future monthly invoices | Same tier, continuous (no gap) |

A yearly → monthly switch becomes **account credit**, not a refund. The customer
never loses access and never loses money already paid.

---

## Does Stripe handle this? Yes — one API call

The whole switch is a single `POST /v1/subscriptions/{id}`:

```js
await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: updateParams.toString(),
});
```

Given that call, Stripe automatically:

- Swaps the price on the subscription item to the new interval's price.
- Computes the proration (credit for unused time + charge for the new price) —
  the app never calculates this; `proration_behavior: 'create_prorations'` tells
  Stripe to.
- For monthly→yearly, generates and charges an invoice immediately against the
  default payment method (`billing_cycle_anchor: 'now'`).
- For yearly→monthly, records the proration as a pending credit balance to apply
  to the next invoice.

### Where each change lands in Stripe

| Thing | Where in the Stripe Dashboard |
|---|---|
| New price / interval | Subscription page → line item shows the new price (e.g. "Basic yearly") |
| Immediate charge (monthly→yearly) | Customer → Invoices → a new paid invoice with proration line items |
| Proration line items | Inside that invoice: a negative "Unused time" credit line + a positive "Remaining time at new price" line |
| Credit balance (yearly→monthly) | Customer page → Account / customer credit balance (negative = credit owed to customer) |
| Next billing date | Subscription page → "Next invoice on …" = `current_period_end` |

### What the app mirrors into D1

Stripe is the source of truth, but the handler also writes the relevant fields
into D1 so the app doesn't need a Stripe round-trip to know current state:

```js
await db.prepare(
  `UPDATE Subscription SET interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
   WHERE stripeSubscriptionId = ?`
).bind(targetInterval, newPriceId, newPeriodEndISO, now, stripeSubId).run();
```

It then fires a best-effort sync to legacy KV.

---

## Open items / caveats

- **Webhook authority.** D1 is updated synchronously in the response, but the
  authoritative path is Stripe webhooks (`customer.subscription.updated`,
  `invoice.paid`). If the switch succeeds in Stripe but the D1 write fails, or
  Stripe later adjusts the period end at real renewal, D1 can drift. Confirm a
  webhook handler also updates the `Subscription` row on
  `customer.subscription.updated` (interval / price / period-end).
- **Yearly → monthly does not re-anchor to today.** The billing date stays on the
  original yearly anchor and the customer rides on credit. If the intent is to
  re-anchor monthly billing to "now," that's a one-line change
  (set `billing_cycle_anchor: 'now'` for the monthly direction too).
