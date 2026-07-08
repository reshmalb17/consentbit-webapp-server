// src/handlers/webflowBilling.js
//
// Authless, siteId-keyed billing for the Webflow Designer Extension (mirrors the
// authless model of /api/webflow/oauth/status and /api/payment/subscription).
// Resolves the subscription from a Webflow siteId (platformSiteId) or internal
// webapp siteId, then talks to Stripe.
//
//   GET  /api/webflow/billing?siteId=<id>     → plan + status + real Stripe invoices + usage
//   POST /api/webflow/cancel-subscription     body { siteId } → cancel at period end

import { getPageviewUsageForSite, getScanUsageForSite, getPlanById } from '../services/db.js';

const TAG = '[webflow-billing]';

// Monthly scan + pageview allowances for a plan (free defaults: 100 / 7500).
// Lets the client show real "limit reached" notifications instead of hardcoding.
async function resolveLimits(db, planId) {
  try {
    const plan = await getPlanById(db, planId || 'free');
    return {
      scansLimit: plan?.scansIncluded ?? plan?.scansincluded ?? 100,
      pageviewsLimit: plan?.pageviewsIncluded ?? plan?.pageviewsincluded ?? 7500,
    };
  } catch {
    return { scansLimit: 100, pageviewsLimit: 7500 };
  }
}

// Current-month usage (scans + pageviews completed) for the resolved site.
// Best-effort: returns zeros if the site is unresolved or the lookup fails.
async function resolveUsage(db, site) {
  if (!site?.id) return { scansUsed: 0, pageviewsUsed: 0, yearMonth: null };
  try {
    const [pv, sc] = await Promise.all([
      getPageviewUsageForSite(db, site.id),
      getScanUsageForSite(db, site.id),
    ]);
    return {
      scansUsed: sc?.scanCount ?? 0,
      pageviewsUsed: pv?.pageviewCount ?? 0,
      yearMonth: pv?.yearMonth ?? sc?.yearMonth ?? null,
    };
  } catch (e) {
    console.warn(`${TAG} usage lookup failed`, e?.message);
    return { scansUsed: 0, pageviewsUsed: 0, yearMonth: null };
  }
}

// Resolve the internal Site row from a wfSiteId (platformSiteId) OR internal site id.
async function resolveSite(db, siteId) {
  if (!siteId) return null;
  return db
    .prepare('SELECT id, organizationId FROM Site WHERE id = ?1 OR platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
    .bind(siteId)
    .first()
    .catch(() => null);
}

// The subscription for a site → fall back to the org's active/trialing subscription.
async function resolveSubscription(db, site) {
  if (!site) return null;
  const cols =
    'id, organizationId, siteId, planId, planType, status, stripeSubscriptionId, stripeCustomerId, interval, currentPeriodEnd, cancelAtPeriodEnd';
  // A site can accumulate several Subscription rows over time (e.g. cancel → resubscribe,
  // or plan changes each create a new row). Pick the CURRENT one deterministically:
  // active/trialing first, then the most recently created — so a stale cancelled row
  // never wins and shows a false "cancelled" state / wrong invoices.
  let sub = await db
    .prepare(
      `SELECT ${cols} FROM Subscription WHERE siteId = ?1
       ORDER BY CASE WHEN lower(status) IN ('active','trialing') THEN 0 ELSE 1 END, createdAt DESC
       LIMIT 1`,
    )
    .bind(site.id)
    .first()
    .catch(() => null);
  if (!sub && site.organizationId) {
    sub = await db
      .prepare(
        `SELECT ${cols} FROM Subscription WHERE organizationId = ?1 AND lower(status) IN ('active','trialing') ORDER BY createdAt DESC LIMIT 1`,
      )
      .bind(site.organizationId)
      .first()
      .catch(() => null);
  }
  return sub;
}

function pick(sub, camel, snake) {
  return sub?.[camel] ?? sub?.[snake] ?? null;
}

// GET /api/webflow/billing?siteId=<wfSiteId | webappSiteId>
export async function handleWebflowBilling(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });

  const url = new URL(request.url);
  const siteId = (url.searchParams.get('siteId') || '').trim();
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  const site = await resolveSite(db, siteId);
  const sub = await resolveSubscription(db, site);
  const usage = await resolveUsage(db, site);
  if (!sub) {
    const limits = await resolveLimits(db, 'free');
    return Response.json({ success: true, plan: 'free', status: null, invoices: [], stripeSubscriptionId: null, ...usage, ...limits });
  }

  const stripeSubscriptionId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const stripeCustomerId = pick(sub, 'stripeCustomerId', 'stripecustomerid');
  const planId = pick(sub, 'planId', 'planid');
  const cancelRaw = pick(sub, 'cancelAtPeriodEnd', 'cancelatperiodend');

  // Cancelled for UI purposes = flagged to cancel at period end OR already fully canceled.
  // Start from DB, then refine from the live Stripe subscription so a stale DB row (e.g.
  // status still 'trialing' while Stripe already canceled it) doesn't keep the Cancel
  // button visible.
  let cancelAtPeriodEnd = cancelRaw === 1 || cancelRaw === true || cancelRaw === '1'
    || String(pick(sub, 'status', 'status') || '').toLowerCase() === 'canceled';
  if (stripeSubscriptionId && env.STRIPE_SECRET_KEY) {
    try {
      const sres = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const sdata = await sres.json();
      if (!sdata.error) {
        cancelAtPeriodEnd = !!sdata.cancel_at_period_end
          || String(sdata.status || '').toLowerCase() === 'canceled';
      }
    } catch (e) {
      console.warn(`${TAG} subscription fetch failed`, e?.message);
    }
  }

  let invoices = [];
  if (stripeCustomerId && env.STRIPE_SECRET_KEY) {
    try {
      // Only show invoices for subscriptions D1 tracks for THIS site — this excludes ALL
      // orphan subscriptions (abandoned checkouts) and other sites' subs. For the full
      // upgrade history to appear here, upgrades must PRESERVE the old sub's row (see the
      // subscription-history handling in the webhook), so the pre-upgrade plan stays tracked.
      const siteSubIds = new Set();
      if (stripeSubscriptionId) siteSubIds.add(stripeSubscriptionId);
      try {
        const subRows = await db
          .prepare(`SELECT stripeSubscriptionId FROM Subscription WHERE siteId = ?1 AND stripeSubscriptionId IS NOT NULL`)
          .bind(site.id)
          .all();
        for (const r of (subRows?.results || [])) {
          const sid = r.stripeSubscriptionId ?? r.stripesubscriptionid;
          if (sid) siteSubIds.add(sid);
        }
      } catch (e) {
        console.warn(`${TAG} site sub lookup failed`, e?.message);
      }

      const res = await fetch(
        `https://api.stripe.com/v1/invoices?customer=${stripeCustomerId}&limit=100`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      const data = await res.json();
      const filtered = (data.data || [])
        // Keep only invoices tied to a subscription D1 tracks for this site (no orphans).
        .filter((inv) => inv.subscription && siteSubIds.has(inv.subscription))
        // Show finalized invoices — including $0 trial invoices — but hide unfinished
        // drafts / voids.
        .filter((inv) => {
          const status = String(inv.status || '').toLowerCase();
          return status !== 'draft' && status !== 'void';
        });

      // Dedup by subscription: a single subscription can emit several $0 invoices (trial
      // start + proration/renewal), which show up as duplicate rows. Keep only the MOST
      // RECENT invoice per subscription (one row per subscription).
      const bySub = new Map();
      for (const inv of filtered) {
        const key = inv.subscription || inv.id; // one-off invoices (no sub) keyed by their own id
        const prev = bySub.get(key);
        if (!prev || (inv.created || 0) > (prev.created || 0)) bySub.set(key, inv);
      }

      invoices = [...bySub.values()]
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((inv) => ({
          id: inv.id,
          number: inv.number || null,
          status: inv.status || null,
          amountPaid: inv.amount_paid ?? 0,
          amountDue: inv.amount_due ?? 0,
          currency: (inv.currency || 'usd').toUpperCase(),
          created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
          hostedInvoiceUrl: inv.hosted_invoice_url || null,
          invoicePdf: inv.invoice_pdf || null,
        }));

      console.log(`${TAG} invoices site=${site.id} kept=${invoices.length} ofTotal=${(data.data || []).length}`);
    } catch (e) {
      console.warn(`${TAG} invoice fetch failed`, e?.message);
    }
  }

  const limits = await resolveLimits(db, planId);
  return Response.json({
    success: true,
    plan: planId || 'free',
    status: pick(sub, 'status', 'status'),
    interval: pick(sub, 'interval', 'interval'),
    currentPeriodEnd: pick(sub, 'currentPeriodEnd', 'currentperiodend'),
    cancelAtPeriodEnd,
    stripeSubscriptionId,
    invoices,
    ...usage,
    ...limits,
  });
}

// POST /api/webflow/switch-interval   body: { siteId, targetInterval: 'monthly' | 'yearly' }
// Switches the site's subscription between monthly/yearly in-place (Stripe update
// with proration) — no new checkout. Authless, siteId-keyed.
export async function handleWebflowSwitchInterval(request, env) {
  if (request.method !== 'POST') return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  if (!env.STRIPE_SECRET_KEY) return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }
  const siteId = (body.siteId || '').trim();
  const targetInterval = body.targetInterval === 'yearly' ? 'yearly' : body.targetInterval === 'monthly' ? 'monthly' : null;
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });
  if (!targetInterval) return Response.json({ success: false, error: 'targetInterval must be monthly or yearly' }, { status: 400 });

  const site = await resolveSite(db, siteId);
  const sub = await resolveSubscription(db, site);
  const stripeSubId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const currentInterval = String(pick(sub, 'interval', 'interval') || 'monthly').toLowerCase();
  const planId = String(pick(sub, 'planId', 'planid') || '').toLowerCase();
  if (!stripeSubId) return Response.json({ success: false, error: 'No active subscription found for this site.' }, { status: 400 });
  if (currentInterval === targetInterval) return Response.json({ success: false, error: `Already on ${targetInterval} billing` }, { status: 400 });
  if (!['basic', 'essential', 'growth'].includes(planId)) return Response.json({ success: false, error: 'Cannot switch interval for this plan.' }, { status: 400 });

  const trim = (v) => (v == null ? null : String(v).trim() || null);
  const tierPriceMap = {
    basic:     { monthly: trim(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trim(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trim(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trim(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trim(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trim(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
  const newPriceId = tierPriceMap[planId]?.[targetInterval];
  if (!newPriceId) return Response.json({ success: false, error: `Price not configured for ${planId} ${targetInterval}` }, { status: 503 });

  // Read the Stripe subscription for its item id + trial state.
  const stripeSub = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  }).then((r) => r.json()).catch(() => ({ error: { message: 'network' } }));
  if (stripeSub.error) return Response.json({ success: false, error: stripeSub.error.message || 'Failed to read subscription' }, { status: 400 });

  // A fully canceled subscription can't be modified in place — Stripe rejects any item
  // update with "A canceled subscription can only update its cancellation_details and
  // metadata." Signal the client to resubscribe via a fresh checkout instead of surfacing
  // that raw Stripe error. (Note: cancel_at_period_end subs are still `active` and CAN switch.)
  if (stripeSub.status === 'canceled' || stripeSub.status === 'incomplete_expired') {
    return Response.json(
      { success: false, canceled: true, plan: planId, targetInterval, error: 'This subscription was canceled. Start a new checkout to resubscribe.' },
      { status: 409 },
    );
  }

  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return Response.json({ success: false, error: 'Could not read subscription item' }, { status: 500 });
  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);

  // Swap the price, prorate. Anchor the cycle now only when NOT trialing (Stripe rejects
  // billing_cycle_anchor=now during a trial).
  const updateParams = new URLSearchParams({
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: 'create_prorations',
  });
  if (targetInterval === 'yearly' && !isTrialing) updateParams.set('billing_cycle_anchor', 'now');
  const updated = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: updateParams.toString(),
  }).then((r) => r.json());
  if (updated.error) return Response.json({ success: false, error: updated.error.message || 'Failed to switch billing interval' }, { status: 400 });

  const newPeriodEndISO = updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null;
  await db.prepare(
    'UPDATE Subscription SET interval = ?1, stripePriceId = ?2, currentPeriodEnd = ?3, updatedAt = ?4 WHERE stripeSubscriptionId = ?5',
  ).bind(targetInterval, newPriceId, newPeriodEndISO, new Date().toISOString(), stripeSubId).run().catch(() => {});

  return Response.json({ success: true, interval: targetInterval, nextBillingDate: newPeriodEndISO });
}

// POST /api/webflow/cancel-subscription   body: { siteId }
// Cancels at period end (keeps access until the paid period ends).
export async function handleWebflowCancelSubscription(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  if (!env.STRIPE_SECRET_KEY) return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }
  const siteId = (body.siteId || '').trim();
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  const site = await resolveSite(db, siteId);
  const sub = await resolveSubscription(db, site);
  const stripeSubscriptionId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  if (!stripeSubscriptionId) {
    return Response.json({ success: false, error: 'No active subscription found for this site.' }, { status: 400 });
  }

  const params = new URLSearchParams();
  params.set('cancel_at_period_end', 'true');
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (data.error) {
    // Idempotent cancel: a subscription that's already fully canceled on Stripe rejects
    // cancel_at_period_end with "A canceled subscription can only update its
    // cancellation_details and metadata." Don't surface that as an error — reconcile the
    // DB to the canceled state and report success so the UI shows the cancelled view and
    // hides the Cancel button.
    const errMsg = String(data.error?.message || '');
    const alreadyCanceled =
      /canceled subscription can only update/i.test(errMsg) ||
      data.error?.code === 'subscription_already_canceled';
    if (alreadyCanceled) {
      try {
        await db
          .prepare("UPDATE Subscription SET cancelAtPeriodEnd = 1, status = 'canceled', updatedAt = ?1 WHERE stripeSubscriptionId = ?2")
          .bind(new Date().toISOString(), stripeSubscriptionId)
          .run();
      } catch (e) {
        console.warn(`${TAG} D1 reconcile failed (non-fatal)`, e?.message);
      }
      console.log(`${TAG} already canceled on Stripe — reconciled DB to canceled`, stripeSubscriptionId);
      return Response.json({ success: true, alreadyCanceled: true, cancelAtPeriodEnd: true });
    }
    console.error(`${TAG} Stripe cancel error`, data.error?.message);
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
  }

  try {
    await db
      .prepare('UPDATE Subscription SET cancelAtPeriodEnd = 1, updatedAt = ?1 WHERE stripeSubscriptionId = ?2')
      .bind(new Date().toISOString(), stripeSubscriptionId)
      .run();
  } catch (e) {
    console.warn(`${TAG} D1 update failed (non-fatal)`, e?.message);
  }

  return Response.json({
    success: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end * 1000).toISOString() : null,
  });
}
