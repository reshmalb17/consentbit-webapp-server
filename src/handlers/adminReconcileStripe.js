// src/handlers/adminReconcileStripe.js
//
// Compare every Subscription row against what Stripe actually says, and report the drift.
//
// This exists because our database cannot be trusted about payment state on its own:
//   - stripeWebhook.js flattened every status except canceled/unpaid to 'active', so
//     `past_due` was never once stored (656 rows, zero past_due, before 2026-09-23).
//   - The legacy sync path defaults an absent status to 'active' in three places and can
//     only ever promote a row, never demote it.
//   - `interval` is in saveSubscription()'s INSERT list but NOT its DO UPDATE SET, so
//     whatever a row was created with is permanent no matter what Stripe later says.
//
// Each of those was found by hand, months late. Stripe is the authoritative record; this
// handler is the standing check that we match it.
//
//   POST /api/admin/reconcile-stripe
//   Headers: X-Admin-Key: <ADMIN_SECRET>
//   Query:
//     ?apply=true        — write stripeStatus/stripeStatusAt for the rows that drifted.
//                          Safe: neither column takes part in any access decision.
//     ?fixInterval=true  — additionally correct the `interval` column where it disagrees
//                          with Stripe. Off by default; see the note on that write below.
//     ?limit=50          — cap the reported rows per category (default 200, 0 = no cap).
//
// READ-ONLY unless ?apply=true. It never writes `status`: that column decides entitlement
// (`status IN ('active','trialing')` gates the banner, billing views and consent reports),
// so writing a true `past_due` into it would cut off customers who are merely inside
// Stripe's retry window. Recording the truth and changing entitlement are separate
// decisions, and this handler only does the first.

import { checkAdminAuth } from '../utils/adminAuth.js';
import { periodStartOf, periodEndOf } from '../utils/stripePeriod.js';

/** Statuses our access filters treat as entitled. */
const ENTITLED = new Set(['active', 'trialing']);

/**
 * Read the billing interval defensively.
 *
 * Stripe deprecated `items.data[].plan` in favour of `items.data[].price`, and the five
 * existing `?.plan?.interval` reads in this codebase silently yield 'monthly' when it is
 * absent. Same class of drift as the period fields in utils/stripePeriod.js. Check price
 * first, then plan, and return null rather than guessing when neither is present — a null
 * shows up as "unknown" in the report instead of quietly becoming a wrong answer.
 */
function intervalOf(sub) {
  const item = sub?.items?.data?.[0] ?? null;
  const raw = item?.price?.recurring?.interval ?? item?.plan?.interval ?? sub?.plan?.interval ?? null;
  if (!raw) return null;
  return raw === 'year' ? 'yearly' : raw === 'month' ? 'monthly' : String(raw);
}

/** Unix seconds → ISO, or null. */
function iso(seconds) {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/** Same calendar day? Stripe and D1 can differ by seconds on the same billing moment. */
function sameDay(isoA, isoB) {
  if (!isoA || !isoB) return isoA === isoB;
  return String(isoA).slice(0, 10) === String(isoB).slice(0, 10);
}

/**
 * What the customer's money is actually doing. `status` alone does not say whether the
 * latest invoice was ever paid — a subscription can read `active` on an invoice that is
 * still open.
 */
function invoiceSummary(sub) {
  const inv = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
  if (!inv) return { invoiceId: typeof sub.latest_invoice === 'string' ? sub.latest_invoice : null };
  return {
    invoiceId: inv.id ?? null,
    invoiceStatus: inv.status ?? null,              // draft | open | paid | uncollectible | void
    amountDue: inv.amount_due ?? null,
    amountPaid: inv.amount_paid ?? null,
    attemptCount: inv.attempt_count ?? null,
    nextAttempt: iso(inv.next_payment_attempt),
    paidAt: iso(inv.status_transitions?.paid_at),
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  };
}

async function fetchSubscriptionPage(stripeKey, startingAfter) {
  const params = new URLSearchParams();
  params.set('status', 'all');
  params.set('limit', '100');
  params.set('expand[]', 'data.latest_invoice');
  if (startingAfter) params.set('starting_after', startingAfter);

  const res = await fetch(`https://api.stripe.com/v1/subscriptions?${params}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  return res.json();
}

async function fetchAllSubscriptions(stripeKey) {
  const all = [];
  let startingAfter = null;

  // Hard page cap: a runaway loop here would burn the worker's CPU budget and hammer
  // Stripe. 100 pages = 10,000 subscriptions, far beyond current scale.
  for (let page = 0; page < 100; page += 1) {
    const res = await fetchSubscriptionPage(stripeKey, startingAfter);
    if (res.error) throw new Error(res.error.message || 'Stripe API error');
    if (!Array.isArray(res.data)) throw new Error('Unexpected Stripe response shape');
    all.push(...res.data);
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  return all;
}

export async function handleAdminReconcileStripe(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const apply = url.searchParams.get('apply') === 'true';
  const fixInterval = url.searchParams.get('fixInterval') === 'true';
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === '0' ? Infinity : Number(limitRaw || 200);

  const db = env.CONSENT_WEBAPP;
  const now = new Date().toISOString();

  // ── 1. Everything Stripe knows ────────────────────────────────────────────
  let stripeSubs;
  try {
    stripeSubs = await fetchAllSubscriptions(env.STRIPE_SECRET_KEY);
  } catch (err) {
    return Response.json({ success: false, error: `Stripe fetch failed: ${err.message}` }, { status: 502 });
  }
  const byStripeId = new Map(stripeSubs.map((s) => [s.id, s]));

  // ── 2. Everything we think we know ────────────────────────────────────────
  const { results: rows } = await db
    .prepare(
      `SELECT sub.id, sub.stripeSubscriptionId, sub.stripeCustomerId, sub.status, sub.stripeStatus,
              sub.interval, sub.planId, sub.currentPeriodStart, sub.currentPeriodEnd,
              s.domain, u.email
         FROM Subscription sub
         LEFT JOIN Organization o ON o.id = sub.organizationId
         LEFT JOIN User u ON u.id = o.ownerUserId
         LEFT JOIN Site s ON s.id = sub.siteId
        WHERE sub.stripeSubscriptionId IS NOT NULL`,
    )
    .all();

  const report = {
    statusDrift: [],    // we say entitled, Stripe disagrees — the one that costs money
    intervalDrift: [],
    periodDrift: [],
    missingInStripe: [],
    missingInD1: [],
    unpaidInvoice: [],  // status looks fine but the latest invoice was never paid
  };

  const writes = [];

  for (const row of rows || []) {
    const sub = byStripeId.get(row.stripeSubscriptionId);

    if (!sub) {
      report.missingInStripe.push({
        email: row.email, domain: row.domain,
        subscriptionId: row.stripeSubscriptionId, d1Status: row.status,
      });
      continue;
    }

    const sStatus = String(sub.status || '').toLowerCase();
    const dStatus = String(row.status || '').toLowerCase();
    const sInterval = intervalOf(sub);
    const sPeriodEnd = iso(periodEndOf(sub));
    const sPeriodStart = iso(periodStartOf(sub));
    const inv = invoiceSummary(sub);

    const base = {
      email: row.email, domain: row.domain,
      subscriptionId: row.stripeSubscriptionId, customerId: row.stripeCustomerId,
      planId: row.planId,
    };

    // The finding that matters: we are serving someone Stripe does not consider current.
    if (ENTITLED.has(dStatus) && !ENTITLED.has(sStatus)) {
      report.statusDrift.push({ ...base, d1Status: dStatus, stripeStatus: sStatus, ...inv });
    }

    // Paid-up on paper, unpaid in fact.
    if (ENTITLED.has(sStatus) && inv.invoiceStatus && !['paid', 'void'].includes(inv.invoiceStatus)) {
      report.unpaidInvoice.push({ ...base, stripeStatus: sStatus, ...inv });
    }

    if (sInterval && row.interval && sInterval !== String(row.interval).toLowerCase()) {
      report.intervalDrift.push({ ...base, d1Interval: row.interval, stripeInterval: sInterval });
    }

    if (sPeriodEnd && !sameDay(sPeriodEnd, row.currentPeriodEnd)) {
      report.periodDrift.push({
        ...base,
        d1PeriodEnd: row.currentPeriodEnd, stripePeriodEnd: sPeriodEnd,
        d1PeriodStart: row.currentPeriodStart, stripePeriodStart: sPeriodStart,
      });
    }

    // ── Writes — only the columns that decide nothing ──────────────────────
    if (apply && sStatus && sStatus !== String(row.stripeStatus || '').toLowerCase()) {
      writes.push(
        db.prepare(`UPDATE Subscription SET stripeStatus = ?1, stripeStatusAt = ?2 WHERE id = ?3`)
          .bind(sStatus, now, row.id),
      );
    }

    // `interval` is a label, not an access control — nothing gates on it. But it is also
    // never corrected by the normal write path (absent from saveSubscription()'s
    // DO UPDATE SET), so this is the only thing that can fix it. Kept behind its own flag
    // so a reconcile run cannot change billing-facing copy unless that was asked for.
    if (apply && fixInterval && sInterval && sInterval !== String(row.interval || '').toLowerCase()) {
      writes.push(
        db.prepare(`UPDATE Subscription SET interval = ?1, updatedAt = ?2 WHERE id = ?3`)
          .bind(sInterval, now, row.id),
      );
    }
  }

  // Subscriptions Stripe has that we have no row for at all.
  const knownIds = new Set((rows || []).map((r) => r.stripeSubscriptionId));
  for (const sub of stripeSubs) {
    if (knownIds.has(sub.id)) continue;
    report.missingInD1.push({
      subscriptionId: sub.id,
      customerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
      stripeStatus: sub.status,
      created: iso(sub.created),
      periodEnd: iso(periodEndOf(sub)),
    });
  }

  let written = 0;
  if (writes.length) {
    // Chunked: D1 batches are bounded, and one oversized batch would fail the whole run.
    for (let i = 0; i < writes.length; i += 50) {
      const chunk = writes.slice(i, i + 50);
      try {
        await db.batch(chunk);
        written += chunk.length;
      } catch (err) {
        console.error('[reconcileStripe] batch write failed:', err?.message || err);
      }
    }
  }

  const counts = Object.fromEntries(Object.entries(report).map(([k, v]) => [k, v.length]));
  const capped = Object.fromEntries(
    Object.entries(report).map(([k, v]) => [k, Number.isFinite(limit) ? v.slice(0, limit) : v]),
  );

  return Response.json({
    success: true,
    mode: apply ? (fixInterval ? 'apply + fixInterval' : 'apply') : 'read-only',
    checkedAt: now,
    stripeSubscriptions: stripeSubs.length,
    d1Subscriptions: (rows || []).length,
    counts,
    written,
    report: capped,
  });
}
