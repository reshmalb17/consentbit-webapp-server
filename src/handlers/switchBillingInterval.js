// Switches an existing subscription between monthly and yearly billing in-place.
// Uses Stripe subscription update with proration — no checkout redirect needed.
//
// POST /api/subscriptions/switch-interval          → commit the switch
// POST /api/subscriptions/switch-interval/preview   → preview the prorated balance (no change)
// Body for both: { organizationId, targetInterval: 'monthly' | 'yearly' }

import {
  getSessionById,
  getUserById,
  getSubscriptionByOrganization,
  getSubscriptionBySiteId,
  getOrganizationMember,
} from '../services/db.js';
import { syncSubscriptionUpdateToLegacy } from '../services/syncLegacy.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function trimEnv(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

const fail = (error, status) => Response.json({ success: false, error }, { status });

// The amount charged NOW for an interval switch is the prorated difference only — the
// unused credit on the old price plus the prorated charge for the new price over the
// remaining period. Sum just the proration line items; the invoice's `amount_due` would
// wrongly include the next full renewal and overstate the charge (e.g. the whole year).
// Mirrors changeTier.js so both flows report a consistent prorated figure.
function sumProrationCents(invoiceBody) {
  let total = 0;
  let sawProration = false;
  for (const line of invoiceBody?.lines?.data || []) {
    if (line.proration === true) { total += line.amount || 0; sawProration = true; }
  }
  return sawProration ? total : (invoiceBody?.amount_due ?? invoiceBody?.total ?? null);
}

// Shared prep for both preview and commit: auth, validation, load subscription,
// resolve the new price, and read the live Stripe subscription (item id + trial state).
// Returns either { error: Response } or { ctx: {...} }.
async function prepareSwitch(request, env) {
  if (request.method !== 'POST') return { error: fail('Method not allowed', 405) };

  const db = env.CONSENT_WEBAPP;
  if (!db) return { error: fail('Database not available', 503) };
  if (!env.STRIPE_SECRET_KEY) return { error: fail('Stripe not configured', 503) };

  // Auth
  const sid = getSessionIdFromCookie(request);
  if (!sid) return { error: fail('Login required', 401) };
  const session = await getSessionById(db, sid);
  if (!session) return { error: fail('Login required', 401) };
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) return { error: fail('Login required', 401) };

  let body;
  try { body = await request.json(); } catch { return { error: fail('Invalid JSON', 400) }; }

  const organizationId = (body.organizationId || '').trim();
  const siteId = (body.siteId || '').trim() || null;
  const targetInterval = body.targetInterval === 'yearly' ? 'yearly' : body.targetInterval === 'monthly' ? 'monthly' : null;

  if (!organizationId) return { error: fail('organizationId required', 400) };
  if (!targetInterval) return { error: fail('targetInterval must be monthly or yearly', 400) };

  const member = await getOrganizationMember(db, userId, organizationId);
  if (!member) return { error: fail('Not allowed for this organization', 403) };

  // Load the current subscription for THIS site. An org can hold several subscriptions
  // (one per paid site), so falling back to the org-wide lookup would pick the most
  // recently updated one — e.g. a Growth sub — and preview/switch the wrong plan. Prefer
  // the per-site subscription; only fall back to org when no siteId was supplied. Mirrors changeTier.js.
  const sub = (siteId ? await getSubscriptionBySiteId(db, siteId) : null)
    || await getSubscriptionByOrganization(db, organizationId);
  if (!sub) return { error: fail('No active subscription found', 404) };

  const stripeSubId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid;
  const currentInterval = (sub.interval ?? 'monthly').toLowerCase();
  const planId = String(sub.planId ?? sub.planid ?? '').toLowerCase();

  if (!stripeSubId) return { error: fail('Subscription has no Stripe ID', 400) };
  if (currentInterval === targetInterval) return { error: fail(`Already on ${targetInterval} billing`, 400) };
  if (!['basic', 'essential', 'growth'].includes(planId)) {
    return { error: fail('Cannot switch interval for this plan type', 400) };
  }

  // Resolve the new price ID (same tier, different interval)
  const tierPriceMap = {
    basic:     { monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
  const newPriceId = tierPriceMap[planId]?.[targetInterval];
  if (!newPriceId) {
    console.error('[SwitchInterval] Missing price env var for', planId, targetInterval);
    return { error: fail(`Price not configured for ${planId} ${targetInterval}`, 503) };
  }

  // Fetch current subscription from Stripe to get the subscription item ID + trial state
  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const stripeSub = await subRes.json();
  if (stripeSub.error) {
    console.error('[SwitchInterval] Stripe fetch sub failed:', stripeSub.error.message);
    return { error: fail(stripeSub.error.message || 'Failed to read subscription', 400) };
  }

  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return { error: fail('Could not read subscription item ID', 500) };

  // While the subscription is still trialing, Stripe rejects billing_cycle_anchor=now
  // ("Trial end cannot be after billing_cycle_anchor"). During a trial there is nothing to
  // prorate yet — keep the remaining trial and bill the new price at trial end.
  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);
  const trialEndISO = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;

  return {
    ctx: {
      db, user, organizationId, targetInterval, currentInterval, planId,
      sub, stripeSubId, stripeSub, subItemId, newPriceId, isTrialing, trialEndISO,
    },
  };
}

// POST /api/subscriptions/switch-interval/preview
// Returns the prorated balance that would be charged now (or trial info) — does NOT change anything.
export async function handleSwitchIntervalPreview(request, env) {
  console.log('[SwitchInterval] POST /preview called');
  const prep = await prepareSwitch(request, env);
  if (prep.error) return prep.error;
  const { stripeSubId, subItemId, newPriceId, targetInterval, currentInterval, isTrialing, trialEndISO } = prep.ctx;

  let amountDueCents = null;
  let currency = 'usd';

  if (isTrialing) {
    // During a trial there is no proration to charge now (the upcoming invoice would be $0).
    // Show what the customer will actually be billed when the trial converts = the new plan's
    // recurring price (yearly amount), read straight from the Stripe Price.
    try {
      const priceRes = await fetch(`https://api.stripe.com/v1/prices/${newPriceId}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const price = await priceRes.json();
      if (price.error) {
        console.warn('[SwitchInterval] preview price error:', price.error.message);
        return fail(price.error.message || 'Could not read the plan price', 400);
      }
      amountDueCents = price.unit_amount ?? null;
      currency = price.currency || 'usd';
    } catch (e) {
      console.warn('[SwitchInterval] preview price fetch failed:', e?.message);
      return fail('Could not preview the charge', 502);
    }
  } else {
    // Active subscription: preview the PRORATED DIFFERENCE charged immediately. Keep the
    // existing billing cycle (no billing_cycle_anchor=now) so Stripe only prorates the delta
    // instead of resetting the cycle and invoicing the full new-interval price. Then sum just
    // the proration line items — using amount_due here would fold in the next full renewal and
    // overstate the charge (that's why every plan looked like the same full yearly amount).
    const params = new URLSearchParams({
      subscription: stripeSubId,
      'subscription_items[0][id]': subItemId,
      'subscription_items[0][price]': newPriceId,
      subscription_proration_behavior: 'create_prorations',
    });
    try {
      const res = await fetch(`https://api.stripe.com/v1/invoices/upcoming?${params.toString()}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const inv = await res.json();
      if (inv.error) {
        console.warn('[SwitchInterval] preview upcoming-invoice error:', inv.error.message);
        return fail(inv.error.message || 'Could not preview the charge', 400);
      }
      amountDueCents = sumProrationCents(inv);
      currency = inv.currency || 'usd';
    } catch (e) {
      console.warn('[SwitchInterval] preview fetch failed:', e?.message);
      return fail('Could not preview the charge', 502);
    }
  }

  return Response.json({
    success: true,
    currentInterval,
    targetInterval,
    isTrialing: !!isTrialing,
    // For an active sub: amount charged immediately. For a trial: amount billed at trial end.
    amountDueCents,
    currency,
    trialEnd: isTrialing ? trialEndISO : null,
  });
}

// POST /api/subscriptions/switch-interval — commit the switch.
export async function handleSwitchBillingInterval(request, env) {
  console.log('[SwitchInterval] POST /api/subscriptions/switch-interval called');
  const prep = await prepareSwitch(request, env);
  if (prep.error) return prep.error;
  const {
    db, user, organizationId, targetInterval, currentInterval,
    sub, stripeSubId, subItemId, newPriceId, isTrialing,
  } = prep.ctx;

  // Update the subscription in Stripe: swap the price and invoice ONLY the prorated
  // difference now. always_invoice bills the proration items immediately (matching the
  // preview); error_if_incomplete surfaces a card decline synchronously. We deliberately
  // do NOT set billing_cycle_anchor=now — anchoring would reset the cycle and charge the
  // full new-interval price up front instead of just the prorated delta. Mirrors changeTier.js.
  const updateParams = new URLSearchParams({
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: isTrialing ? 'none' : 'always_invoice',
    payment_behavior: 'error_if_incomplete',
  });

  const updateRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: updateParams.toString(),
  });
  const updated = await updateRes.json();
  if (updated.error) {
    console.error('[SwitchInterval] Stripe update failed:', updated.error.message);
    return fail(updated.error.message || 'Failed to switch billing interval', 400);
  }

  // Determine the new period end
  let newPeriodEnd = updated.current_period_end || null;
  if (!newPeriodEnd) {
    try {
      const freshRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const freshSub = await freshRes.json();
      newPeriodEnd = freshSub?.current_period_end || null;
    } catch { /* fall through */ }
  }
  const newPeriodEndISO = newPeriodEnd ? new Date(newPeriodEnd * 1000).toISOString() : null;

  // Update D1 — interval + stripePriceId + currentPeriodEnd
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE Subscription SET interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
     WHERE stripeSubscriptionId = ?`
  ).bind(targetInterval, newPriceId, newPeriodEndISO, now, stripeSubId).run();

  // Sync to legacy KV (fire-and-forget)
  try {
    const siteId = sub.siteId ?? sub.siteid;
    const siteRow = siteId
      ? await db.prepare('SELECT domain, legacySource, platform FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: user.email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: sub.stripeCustomerId ?? sub.stripecustomerid,
      status: sub.status ?? 'active',
      cancelAtPeriodEnd: !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend),
      // See changeTier.js — legacySource alone misses non-legacy Webflow/Framer plugin sites.
      platform: siteRow?.legacySource || siteRow?.platform || null,
      interval: targetInterval,
    });
  } catch (syncErr) {
    console.warn('[SwitchInterval] Legacy sync failed (non-critical):', syncErr?.message);
  }

  console.log('[SwitchInterval] switched from', currentInterval, '→', targetInterval, 'for org:', organizationId);
  return Response.json({
    success: true,
    interval: targetInterval,
    nextBillingDate: newPeriodEndISO,
  });
}
