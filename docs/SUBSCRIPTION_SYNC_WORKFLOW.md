# Subscription Sync — Target Workflow

How Stripe and D1 should stay in agreement, and what to build to get there.

Written after the Unity Gym incident (2026-09-16), where a customer paid $9 and our
database never noticed — their banner stayed dark for three weeks and no alert fired.
Full case notes: `Customer Issues/customer-issues-log.md`, 2026-09-16 entry 2.

---

## 1. Why the current design fails

Today the workflow is **webhook arrives → write → hope**. It is event-driven with no
second line of defence, so any event that is missed, dropped, or silently discarded
stays wrong forever.

Measured on production, 2026-09-16:

| Evidence | Number |
|---|---|
| `PaymentEvent` rows | 3,039 |
| …that record a **successful** payment amount | **0** |
| `invoice.payment_failed` rows | 141 |
| …with a `failureReason` | **0** |
| Cancelled subscriptions | 280 |
| …with a `canceledAt` timestamp | **2** |
| Legacy rows diverged from main D1 | **22** |
| Cron jobs that reconcile Stripe against D1 | **0** |

Revenue is not reconstructible from our database — only losses are.

### The four root causes

1. **A 200 is a decision.** In `payment_intent.succeeded`, `savePaymentEvent()` sits
   inside `if (isBulk)` but the handler returns `{received:true}` either way. Stripe
   logs a successful delivery and never retries, because we told it we were happy.
2. **Unsubscribed events.** `invoice.payment_succeeded` is not subscribed to at all.
3. **Silent sync failure.** The legacy sync omits `email`, which binds `null` into a
   `NOT NULL` column and throws — inside `ctx.waitUntil` + `Promise.allSettled` +
   a `console.warn`-only catch. Three reasonable layers combining into total silence.
4. **Dropped columns.** `saveSubscription`'s upsert column list omits `canceledAt` and
   `endedAt`, so the webhook computes them and they are discarded.

---

## 2. Principles

1. **Persist before processing.** Never act on an event you have not durably recorded.
2. **A 200 means "stored", not "seen".** No branch returns 200 without writing something.
3. **Stripe is the source of truth. D1 is a cache that must be able to rebuild itself.**
4. **Events are an optimisation; reconciliation is the guarantee.** Assume every
   individual event can be lost.
5. **Money arriving is never ignorable.** A payment that cannot be applied is an alert,
   not a log line.
6. **Fail loudly at the boundary.** A missing required field is caught where it is
   passed, not several layers down inside a swallowed promise.

---

## 3. The workflow

### Stage 1 — Ingest: never lose an event

```
verify signature
  ↓
INSERT INTO StripeEventInbox (raw event)      ← durable, before anything else
  ↓
try { ensureSchema } catch { log, continue }  ← must not be able to 500 the request
  ↓
dispatch by type
  ↓
UPDATE StripeEventInbox SET processedAt | error
  ↓
200
```

The inbox write uses a single `CREATE TABLE IF NOT EXISTS` + `INSERT`, **not**
`ensureSchema` — `ensureSchema` runs a full migration on cold start and is exactly
the thing that can throw before dispatch.

Dedupe on `stripeEventId` **in the inbox only**. Do not add a unique index to
`PaymentEvent`; it already contains duplicates from Stripe retries.

A failed row stays in the inbox with its error, so it can be replayed.

### Stage 2 — Record: capture what happened

Every event writes a `PaymentEvent` **before** any early return. Applies to all
subscribed types, not just failures.

Subscribe to and handle:

| Event | Why |
|---|---|
| `invoice.payment_succeeded` | **currently missing** — the event behind every successful renewal |
| `payment_intent.succeeded` | subscribed, but currently discarded unless bulk |
| `charge.succeeded` | payment-method level detail |
| `customer.subscription.created/updated/deleted` | already handled |
| `invoice.payment_failed` | already handled |

Fields that must be populated and currently are not:

- `amountCents` on **successes**, not just failures
- `failureReason` — read from `payment_intent.last_payment_error.message` or
  `charge.outcome.seller_message`. The current source,
  `invoice.last_finalization_error`, is null for an ordinary card decline.
- `canceledAt`, `endedAt`, and the cancellation **reason**
  (`cancellation_details.reason` distinguishes involuntary churn from voluntary)
- `stripeItemId` — `reportStripeMeteredUsage` reads it and it is populated on 4.5% of rows

Because `saveSubscription`'s upsert does not carry the cancel/end columns, write them
in a **separate guarded statement** rather than editing that upsert (it is live billing
code):

```js
if (sub.canceled_at || sub.ended_at) {
  try {
    await db.prepare(
      `UPDATE Subscription SET canceledAt = COALESCE(?1, canceledAt),
                               endedAt    = COALESCE(?2, endedAt)
         WHERE stripeSubscriptionId = ?3`
    ).bind(iso(sub.canceled_at), iso(sub.ended_at), sub.id).run();
  } catch (e) { console.warn('[webhook] cancel/end write failed:', e?.message); }
}
```

Decide one meaning for `endedAt` first. Today the cron uses it for "paid period lapsed"
while Stripe means "subscription terminated" — 17 days apart in the Unity Gym case. If
Stripe's meaning wins, the end-sweep needs its own column or the two will fight.

### Stage 3 — Apply: change state, independently

The three legacy writes currently share one async branch, so the first throw kills the
other two. Give each its own error handling:

```js
const results = await Promise.allSettled([
  safeWrite('legacy.subscription', () => upsertLegacySubscription(...)),
  safeWrite('legacy.site',         () => upsertLegacySite(...)),
  safeWrite('legacy.licenses',     () => updateLicenses(...)),
  safeWrite('kv.site',             () => writeKvSiteEntry(...)),
]);
recordSyncFailures(db, results);   // queryable, not console.warn
```

And fix the cause — pass `email` at the call site, plus a defensive `COALESCE` so an
existing row reuses its stored email:

```sql
VALUES (COALESCE(?1, (SELECT user_email FROM subscriptions WHERE subscription_id = ?3)), ...)
```

`console.warn` inside `ctx.waitUntil` is invisible unless someone is tailing at that
exact moment. Sync failures must land somewhere you can query and alert on.

### Stage 4 — Self-heal: let a payment repair state

On **any** successful payment, re-fetch the subscription from Stripe and upsert D1.
A missed earlier event then repairs itself at the next payment instead of stranding a
paying customer.

When the payment cannot be applied — the subscription is cancelled, as with Unity Gym —
self-healing is impossible and the correct response is an **alert**. Money against a
dead subscription is always either a customer who paid for nothing or a cancellation we
got wrong. Both need a human the same day.

### Stage 5 — Reconcile: the actual guarantee

A scheduled pass that assumes events were lost.

```
daily:
  page through Stripe subscriptions (status=all)
  for each, compare against D1:
    - status mismatch          (Stripe active, D1 cancelled → customer paying for nothing)
    - missing D1 row           (provisioned in Stripe, absent here)
    - period drift             (currentPeriodEnd disagrees)
    - legacy mismatch          (main D1 vs consentbit-licenses)
  write a divergence report; alert when non-empty
```

**Ship v1 read-only** — report, repair nothing. It tells you the true size of the
problem without risking a mass write. Promote individual divergence classes to
auto-repair once each has been observed to be correct for a while.

`adminBackfillStripeSubscriptions.js` already pages through every Stripe subscription
and has a `?dryRun=true` mode, so the fetching half exists. It needs the comparison and
a cron trigger rather than a manual POST with `ADMIN_SECRET`.

---

## 3b. Cancellation and reactivation — the missing workflow

### What Stripe does

Stripe retries a failed invoice up to 8 times over roughly two weeks. When retries are
exhausted its configured action fires — for us, **cancel the subscription**. Stripe's
cancel is *terminal*: a `canceled` subscription can never be updated, resumed or
reactivated. Its own error message says so, and our code already quotes it in
`webflowBilling.js:259`:

> "A canceled subscription can only update its cancellation_details and metadata."

**The unpaid invoice is not closed.** It stays `open` and permanently payable through
its `hosted_invoice_url`. That is the trapdoor: a customer can pay a real Stripe invoice,
see "Paid", and receive nothing — because the subscription it belonged to no longer
exists. Unity Gym paid $9 this way on 2026-08-27, two days after cancellation.

Nothing in the codebase voids or marks such an invoice uncollectible — the string does
not appear anywhere in `src/`.

### What we record today

| | |
|---|---|
| `Subscription.status = 'canceled'` | ✅ |
| `PaymentEvent` (`customer.subscription.deleted`) | ✅ |
| `PlanTransition` (`cancelled`, `basic → free`) | ✅ |
| KV → `expired`, `active: false` | ✅ |
| `canceledAt` | ❌ 2 of 280 |
| Cancellation **reason** (`cancellation_details.reason`) | ❌ never |
| Legacy DB rows | ❌ silent failure |
| The open invoice | ❌ left payable forever |

Enough to turn the banner off. Not enough to say *when*, *why*, or to stop the customer
paying into the void.

### The renewal path today: there isn't one

A returning customer with a cancelled subscription on an existing site hits a dead end:

```
logs in
  ↓ dashboard-init returns planId='basic'  (status ignored)
  ↓ currentTier = 'basic'  (planTierFromSiteRow reads planId only)
  ↓ upgrade page: currentTier !== 'free'  → in-place tier change
  ↓ changeTier.js → POST /v1/subscriptions/{cancelled id}
  ↓ Stripe 400 — raw error shown to the customer
```

The checkout path that *would* create a new subscription runs only when
`currentTier === 'free'`, which a lapsed customer can never reach. So the only route
that appears to work is the old invoice link — which takes their money and restores
nothing.

**A customer who wants to start paying again currently cannot.**

### Target: an explicit reactivation workflow

Introduce a third state. Today the code recognises `ACTIVE` and `FREE`; the missing one
is `LAPSED` — *site exists, subscription terminal*.

**On cancellation:**

1. Record `canceledAt` and `cancellation_details.reason` (distinguishes involuntary
   churn from a customer who chose to leave).
2. **Void or mark uncollectible the open invoice**, so it can no longer be paid. This
   alone would have prevented the Unity Gym incident entirely.
3. Sync legacy + KV with per-write error handling.
4. Mark the account `LAPSED`.

**On reactivation:**

1. Detect `LAPSED` and show a **Reactivate** screen — not the upgrade grid.
2. Always **create a new Stripe subscription**. Never attempt to update the old one;
   it is terminal by definition.
3. **Reuse everything else.** `createSite` looks up by domain and explicitly preserves
   `cdnScriptId` and `apiKey` — *"regenerating would break live Webflow sites"* — and
   freezes `embedScriptUrl` with `COALESCE`. So the customer's existing script tag keeps
   working and nothing on their site needs touching.
4. **Carry the metadata**: `organizationId`, `siteId`, `planId`, `planType`, `interval`.
   Without these the webhook cannot resolve the org and discards the subscription.
5. **Do not pin a payment method.** Use the customer default, or a card the customer
   fixes later will still be ignored.
6. **Credit orphan payments.** Before charging, look for successful payments against the
   cancelled subscription that bought nothing, and apply them as a customer balance
   credit. Otherwise a customer who paid a dead invoice pays twice.
7. **Link old to new** via `Subscription.migratedSubId` — the column already exists and
   is currently used only by the dashboard migration tool. Keep the old row as history.
8. Let the webhook provision. Status returns to active, the banner comes back on the
   same script id, licences and legacy rows are written by the normal path.

**Never** hand-write D1 rows to bring a customer back. A grace grant (as applied to
Unity Gym on 2026-09-16) is a temporary measure that does not bill and does not expire
on its own — it always needs a real subscription behind it eventually.

### Why this also fixes the dead end

Step 1 depends on the source-level fix in §5.2: when the subscription is terminal,
`authDashboardInit` must stop reporting the old `planId`. Once `currentTier` resolves to
`free`/`lapsed`, the upgrade page stops routing into the in-place change path, and the
customer reaches checkout — which already does the right thing.

## 4. Alerts

Alert on the **symptom**, not only the known causes — that is what catches the bug
nobody has found yet.

| Signal | Means |
|---|---|
| Divergence report non-empty | Stripe and D1 disagree |
| Sync failure count > 0 | a background write is failing silently |
| Payment succeeded on a cancelled subscription | customer paid for nothing |
| Inbox rows unprocessed > N minutes | dispatch is broken |
| Site had traffic last month, none this month, no cancellation the customer agreed to | someone went dark |

That last one is worth emphasising: Unity Gym was visible in `PageviewUsage` three weeks
before anyone asked about them. Traffic simply stopped. No cause-specific alert was
needed to see it.

---

## 5. Product decisions this exposes

These are not bugs, but the incident makes them worth deciding deliberately.

**1. A cancelled customer is currently treated worse than a stranger.** In `cdnM.js`,
no subscription row at all → the free banner serves. A *cancelled* row → HTTP 402 and
the site goes completely dark. Someone who never paid gets compliance coverage; someone
whose card failed gets none. If cancelled should mean "drop to free", the 402 branch
becomes `effectivePlanId = 'free'` and no one's site ever goes dark over billing.

> **Decided 2026-09-17: keep blocking.** A cancelled site keeps its banner until its paid
> period ends, then is blocked; deleted is always blocked. "Drop to free" and a grace
> period were considered and not chosen. Full decision record, the affected sites at the
> time, and how to find affected sites later: `Customer Issues/customer-issues-log.md`,
> section 8k. Blocks are logged on Test as `[CB-FLOW] banner.blocked` with
> `"reason":"cancelled-period-ended"`.

**2. A cancelled customer cannot re-subscribe through the app.** `authDashboardInit`
returns the old `planId` regardless of status, so `currentTier` is `basic`, so the
upgrade page routes to the in-place tier-change path, which calls Stripe on a terminal
subscription and fails. The checkout path that would create a new subscription only
runs when `currentTier === 'free'`. Fix at the source:

```js
const DEAD = ['canceled', 'cancelled', 'unpaid', 'incomplete_expired'];
const sitePlanId = DEAD.includes(status) ? null : (sub?.planId ?? ...);
```

Add matching guards to `changeTier.js` and `switchBillingInterval.js` so the API returns
a readable 409 instead of a raw Stripe error. `webflowBilling.js` already handles this
correctly (lines 259 and 330) — copy that approach.

**3. Do not leave subscriptions pinned to a specific payment method.** A subscription
with its own `default_payment_method` ignores the customer's default. If a customer
changes card anywhere that only updates the customer default — Stripe's billing portal,
a hosted invoice page, the Stripe dashboard — every renewal retry keeps charging the old
card until dunning cancels the subscription.

*Correction:* this was first written up as the cause of the Unity Gym cancellation. It
was not — their replacement card was added on Aug 27, after all retries (Aug 11–25) had
already run on their only card. Pinning is a real risk, just not that incident's cause.

**The pin cannot be removed.** Stripe does not allow clearing a subscription's
`default_payment_method` — its API spec types it as a plain `string` on update, where
clearable fields (e.g. the neighbouring `default_source`) are `Emptyable`. An attempt to
"unpin after the first payment" was built and then withdrawn for this reason.

So the goal is not to remove the pin but to **keep it pointing at the current card**:

1. **Our card-update flow re-pins** — `updatePaymentMethod.js` sets the customer default
   *and* the subscription pin. Correct as it stands.
2. **`save_default_payment_method: on_subscription` must stay on.** Stripe: *"updates
   `subscription.default_payment_method` when payment succeeds"* — so a card that pays an
   invoice becomes the pin. Turning it `off` would freeze renewals on the original card.
3. **Cards changed outside our app are not yet followed.** Stripe's billing portal and
   dashboard update only the customer default. A `customer.updated` handler should re-pin
   active subscriptions whenever `invoice_settings.default_payment_method` changes.

Both checkouts now also set the customer's invoice default card, which neither did before —
it is what the billing portal shows and edits, and the baseline step 3 relies on.

---

## 6. Build order

Each step is useful alone; none depends on a later one.

| # | Change | Risk | Effect |
|---|---|---|---|
| 0 | **Void / mark uncollectible the open invoice on cancellation** | low | closes the trapdoor — customers can no longer pay a dead invoice |
| 1 | Move `savePaymentEvent` out of `if (isBulk)` | trivial | stops discarding successful payments today |
| 2 | Reconciliation report, read-only, daily | none (read-only) | reveals the true size of the problem |
| 3 | Legacy sync: `email` + `COALESCE` + per-write error handling | low | fixes silent failure for **all** customers |
| 4 | Subscribe to + handle `invoice.payment_succeeded` | low | closes the renewal blind spot |
| 5 | Self-heal on successful payment + alert when impossible | medium | future incidents fix or announce themselves |
| 6 | `canceledAt` / cancellation reason / `stripeItemId` | low | churn analysis and usage reporting become possible |
| 7 | `StripeEventInbox` + replay | medium | no event can be lost without trace |
| 8 | Product decisions in §5 | product call | cancelled customers stop going dark and can pay again |

Backfill separately: 22 diverged legacy rows, and `canceledAt` for 278 cancelled
subscriptions (recoverable from Stripe).

---

## 7. How to know it worked

- Replay a real webhook with the worker's DB binding pointed at a scratch D1 —
  every subscribed event type leaves a `PaymentEvent` row.
- Deliberately break one legacy write in staging and confirm something, somewhere,
  notices. If nothing does, Stage 3 is not finished.
- Run the reconciliation report on a normal day. It should be empty. The day it is not,
  it should be a customer you can name before they email you.
- `SELECT COUNT(amountCents) FROM PaymentEvent WHERE eventType LIKE '%succeeded%'`
  should be non-zero — today it is 0.

---

## Deployment note

`consent-manager` deploys **two** worker scripts. A plain `wrangler deploy` does not
update `manager.consentbit.com` — that needs `wrangler deploy --env production`. It
looks like propagation lag; it is not.
