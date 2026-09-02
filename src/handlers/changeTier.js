// Changes an existing subscription's plan tier (basic/essential/growth) in-place.
// Upgrades apply immediately and charge the prorated difference to the card on file.
// Downgrades are scheduled for the end of the current billing period (no charge now).
//
// POST /api/subscriptions/change-tier          → commit the change
// POST /api/subscriptions/change-tier/preview   → preview the prorated amount (no change)
// Body for both: { organizationId, siteId?, planId: 'basic'|'essential'|'growth',
//                  interval: 'monthly'|'yearly', promotionCodeId? }
//
// Companion to switchBillingInterval.js (same-tier interval switch). This handler is
// for tier changes; the interval may also differ (e.g. Basic-monthly → Growth-yearly).

import {
  getSessionById,
  getUserById,
  getSubscriptionBySiteId,
  getSubscriptionByOrganization,
  getOrganizationMember,
} from '../services/db.js';
import { syncSubscriptionUpdateToLegacy } from '../services/syncLegacy.js';
import { isPromotionCodeAllowedForEmail } from '../services/promoRestrictions.js';

const PLAN_ORDER = { basic: 1, essential: 2, growth: 3 };

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

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return { status: res.status, body: await res.json() };
}

async function stripePost(env, path, formObj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(formObj)) {
    if (v != null) params.set(k, String(v));
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  return { status: res.status, body: await res.json() };
}

// Shared prep for both preview and commit: auth, validation, load subscription,
// resolve the new tier price, and read the live Stripe subscription.
// Returns either { error: Response } or { ctx: {...} }.
async function prepareChange(request, env) {
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
  const planId = ['basic', 'essential', 'growth'].includes(body.planId) ? body.planId : null;
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const promotionCodeId = body.promotionCodeId && String(body.promotionCodeId).trim()
    ? String(body.promotionCodeId).trim()
    : null;
  // Option 3: a new card tokenized on the client (Stripe PaymentMethod id). When present,
  // the prorated amount is charged to THIS card and it becomes the subscription default.
  const paymentMethodId = body.paymentMethodId && String(body.paymentMethodId).trim()
    ? String(body.paymentMethodId).trim()
    : null;

  if (!organizationId) return { error: fail('organizationId required', 400) };
  if (!planId) return { error: fail('planId must be basic, essential, or growth', 400) };

  const member = await getOrganizationMember(db, userId, organizationId);
  if (!member) return { error: fail('Not allowed for this organization', 403) };

  // Per-customer promo restrictions (see services/promoRestrictions.js).
  if (promotionCodeId) {
    const promoOk = await isPromotionCodeAllowedForEmail(
      env.STRIPE_SECRET_KEY, promotionCodeId, user.email,
    );
    if (!promoOk.allowed) return { error: fail(promoOk.reason, 400) };
  }

  // Load current subscription — prefer the per-site license, fall back to org.
  const sub = (siteId ? await getSubscriptionBySiteId(db, siteId) : null)
    || await getSubscriptionByOrganization(db, organizationId);
  if (!sub) return { error: fail('No active subscription found', 404) };

  const stripeSubId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid;
  const currentPlanId = String(sub.planId ?? sub.planid ?? '').toLowerCase();
  const currentInterval = String(sub.interval ?? 'monthly').toLowerCase();

  if (!stripeSubId) return { error: fail('Subscription has no Stripe ID', 400) };
  if (!PLAN_ORDER[currentPlanId]) {
    return { error: fail('Current plan is not a tier plan; cannot change here', 400) };
  }
  if (currentPlanId === planId && currentInterval === interval) {
    return { error: fail('Already on this plan', 400) };
  }

  // Resolve the new price ID (target tier + interval)
  const tierPriceMap = {
    basic:     { monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
  const newPriceId = tierPriceMap[planId]?.[interval];
  if (!newPriceId) {
    console.error('[ChangeTier] Missing price env var for', planId, interval);
    return { error: fail(`Price not configured for ${planId} ${interval}`, 503) };
  }

  // Direction: tier rank decides upgrade vs downgrade. If the tier is unchanged but the
  // interval differs (e.g. essential-monthly → essential-yearly reaching this handler),
  // treat it as immediate proration too.
  const isDowngrade = PLAN_ORDER[planId] < PLAN_ORDER[currentPlanId];

  // Read the live Stripe subscription (item id + trial state + period end).
  const subRes = await stripeGet(env, `/subscriptions/${stripeSubId}`);
  if (subRes.body.error) {
    console.error('[ChangeTier] Stripe fetch sub failed:', subRes.body.error.message);
    return { error: fail(subRes.body.error.message || 'Failed to read subscription', 400) };
  }
  const stripeSub = subRes.body;
  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return { error: fail('Could not read subscription item ID', 500) };

  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);
  const trialEndISO = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;
  const periodEndISO = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null;

  return {
    ctx: {
      db, user, env, organizationId, siteId, planId, interval, promotionCodeId, paymentMethodId,
      sub, stripeSubId, stripeSub, subItemId, newPriceId,
      currentPlanId, currentInterval, isDowngrade, isTrialing, trialEndISO, periodEndISO,
    },
  };
}

// The amount charged NOW for an upgrade is the prorated difference only. The commit
// path uses `always_invoice`, which invoices just the proration items immediately —
// the next full renewal is billed later on the normal cycle. So sum the proration
// line items; the invoice's `amount_due` would wrongly include that next renewal and
// overstate the charge (e.g. showing ~2× the plan price).
function sumProrationCents(invoiceBody) {
  let total = 0;
  let sawProration = false;
  for (const line of invoiceBody?.lines?.data || []) {
    if (line.proration === true) { total += line.amount || 0; sawProration = true; }
  }
  return sawProration ? total : (invoiceBody?.amount_due ?? invoiceBody?.total ?? null);
}

// Preview the net amount charged now for an immediate (upgrade) change.
// Tries the Upcoming Invoice API, then falls back to the Create Preview Invoice API
// for subscriptions on Stripe's flexible billing mode (upcoming-invoice is unsupported there).
async function previewImmediateAmount(env, ctx) {
  const { stripeSubId, subItemId, newPriceId, promotionCodeId, stripeSub } = ctx;

  const base = {
    subscription: stripeSubId,
    'subscription_items[0][id]': subItemId,
    'subscription_items[0][price]': newPriceId,
    subscription_proration_behavior: 'create_prorations',
  };
  if (promotionCodeId) base['discounts[0][promotion_code]'] = promotionCodeId;

  const qs = new URLSearchParams(base).toString();
  const up = await stripeGet(env, `/invoices/upcoming?${qs}`);
  if (!up.body.error) {
    return { amountDueCents: sumProrationCents(up.body), currency: up.body.currency || 'usd' };
  }

  const flexible = up.status === 400 && /billing_mode = flexible/i.test(up.body.error?.message || '');
  if (!flexible) {
    // If the discount caused the error, retry once without it so the user still sees a figure.
    if (promotionCodeId) {
      const retry = { ...base };
      delete retry['discounts[0][promotion_code]'];
      const up2 = await stripeGet(env, `/invoices/upcoming?${new URLSearchParams(retry).toString()}`);
      if (!up2.body.error) {
        return { amountDueCents: sumProrationCents(up2.body), currency: up2.body.currency || 'usd', couponPreviewSkipped: true };
      }
    }
    return { error: up.body.error.message || 'Could not preview the charge' };
  }

  // Flexible billing → Create Preview Invoice with all current items, swapping the tier price.
  const customerId = stripeSub.customer;
  const items = stripeSub.items?.data || [];
  const form = {
    customer: customerId,
    subscription: stripeSubId,
    'subscription_details[proration_behavior]': 'create_prorations',
  };
  items.forEach((item, i) => {
    form[`subscription_details[items][${i}][id]`] = item.id;
    // Swap the first item to the new tier price; keep any metered/extra items as-is.
    form[`subscription_details[items][${i}][price]`] = i === 0 ? newPriceId : item.price?.id;
  });
  if (promotionCodeId) form['discounts[0][promotion_code]'] = promotionCodeId;

  const prev = await stripePost(env, '/invoices/create_preview', form);
  if (prev.body.error) {
    return { error: prev.body.error.message || 'Could not preview the charge' };
  }
  return { amountDueCents: sumProrationCents(prev.body), currency: prev.body.currency || 'usd' };
}

// POST /api/subscriptions/change-tier/preview
export async function handleChangeTierPreview(request, env) {
  console.log('[ChangeTier] POST /preview');
  const prep = await prepareChange(request, env);
  if (prep.error) return prep.error;
  const ctx = prep.ctx;
  const { currentPlanId, currentInterval, planId, interval, isDowngrade, isTrialing, trialEndISO, periodEndISO, newPriceId, env: _e } = ctx;

  // Trialing: nothing to prorate. Show what they'll pay when the trial converts (new price).
  if (isTrialing) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    if (priceRes.body.error) return fail(priceRes.body.error.message || 'Could not read the plan price', 400);
    return Response.json({
      success: true,
      direction: isDowngrade ? 'downgrade' : 'upgrade',
      currentPlanId, currentInterval, planId, interval,
      isTrialing: true,
      amountDueCents: priceRes.body.unit_amount ?? null,
      currency: priceRes.body.currency || 'usd',
      trialEnd: trialEndISO,
      effectiveAt: null,
    });
  }

  // Downgrade: no charge now; takes effect at period end.
  if (isDowngrade) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    const newAmount = priceRes.body?.error ? null : (priceRes.body.unit_amount ?? null);
    return Response.json({
      success: true,
      direction: 'downgrade',
      currentPlanId, currentInterval, planId, interval,
      isTrialing: false,
      amountDueCents: 0,           // nothing charged now
      newPlanAmountCents: newAmount, // what they'll pay from the next period
      currency: priceRes.body?.currency || 'usd',
      trialEnd: null,
      effectiveAt: periodEndISO,
    });
  }

  // Upgrade (or interval bump): prorated amount charged immediately.
  const res = await previewImmediateAmount(env, ctx);
  if (res.error) return fail(res.error, 400);
  return Response.json({
    success: true,
    direction: 'upgrade',
    currentPlanId, currentInterval, planId, interval,
    isTrialing: false,
    amountDueCents: res.amountDueCents,
    currency: res.currency,
    couponPreviewSkipped: !!res.couponPreviewSkipped,
    trialEnd: null,
    effectiveAt: null,
  });
}

// POST /api/subscriptions/change-tier — commit.
export async function handleChangeTier(request, env) {
  console.log('[ChangeTier] POST /api/subscriptions/change-tier');
  const prep = await prepareChange(request, env);
  if (prep.error) return prep.error;
  const {
    db, user, organizationId, siteId, planId, interval, promotionCodeId, paymentMethodId,
    sub, stripeSubId, stripeSub, subItemId, newPriceId, isDowngrade, isTrialing, periodEndISO,
  } = prep.ctx;

  // ── Downgrade → schedule the change for the end of the current period ──────────
  if (isDowngrade && !isTrialing) {
    const currentPriceId = stripeSub.items?.data?.[0]?.price?.id;
    const startDate = stripeSub.current_period_start;
    const changeDate = stripeSub.current_period_end;

    // If a schedule already exists on the sub, release it first so we can re-create cleanly.
    if (stripeSub.schedule) {
      await stripePost(env, `/subscription_schedules/${stripeSub.schedule}/release`, {}).catch(() => {});
    }

    const created = await stripePost(env, '/subscription_schedules', { from_subscription: stripeSubId });
    if (created.body.error) {
      console.error('[ChangeTier] schedule create failed:', created.body.error.message);
      return fail(created.body.error.message || 'Could not schedule the downgrade', 400);
    }
    const schedId = created.body.id;

    // Two phases: keep current price until period end, then move to the new lower price.
    const updateForm = {
      end_behavior: 'release',
      'phases[0][items][0][price]': currentPriceId,
      'phases[0][items][0][quantity]': '1',
      'phases[0][start_date]': startDate,
      'phases[0][end_date]': changeDate,
      'phases[0][proration_behavior]': 'none',
      'phases[1][items][0][price]': newPriceId,
      'phases[1][items][0][quantity]': '1',
      'phases[1][proration_behavior]': 'none',
      'metadata[planId]': planId,
      'metadata[interval]': interval,
      'metadata[siteId]': siteId || (sub.siteId ?? sub.siteid ?? ''),
      'metadata[organizationId]': organizationId,
    };
    const updated = await stripePost(env, `/subscription_schedules/${schedId}`, updateForm);
    if (updated.body.error) {
      console.error('[ChangeTier] schedule update failed:', updated.body.error.message);
      return fail(updated.body.error.message || 'Could not schedule the downgrade', 400);
    }

    // D1 stays on the current plan until the scheduled change fires (webhook will sync it).
    return Response.json({
      success: true,
      direction: 'downgrade',
      scheduled: true,
      effectiveAt: periodEndISO,
      planId, interval,
    });
  }

  // ── Upgrade (or interval bump) → apply now, invoice the proration immediately ──

  // Cancel any pending downgrade schedule when the user upgrades instead.
  if (stripeSub.schedule) {
    await stripePost(env, `/subscription_schedules/${stripeSub.schedule}/release`, {}).catch(() => {});
  }

  // Option 3 — a new card was tokenized on the client. Attach it, then charge the prorated
  // amount to it. Without a card id, fall back to charging the existing card on file.
  const customerId = stripeSub.customer;
  if (paymentMethodId) {
    const attach = await stripePost(env, `/payment_methods/${paymentMethodId}/attach`, { customer: customerId });
    if (attach.body.error) {
      console.error('[ChangeTier] card attach failed:', attach.body.error.message);
      return fail(attach.body.error.message || 'Could not use that card. Please try another.', 400);
    }
  }

  const updateForm = {
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    // always_invoice → invoice the prorated difference immediately.
    proration_behavior: isTrialing ? 'none' : 'always_invoice',
    // New card: collect on the client (supports 3D Secure) via default_incomplete.
    // Card on file: charge now and surface failure synchronously.
    payment_behavior: paymentMethodId ? 'default_incomplete' : 'error_if_incomplete',
    'metadata[planId]': planId,
    'metadata[interval]': interval,
    'expand[0]': 'latest_invoice.payment_intent',
  };
  if (paymentMethodId) updateForm['default_payment_method'] = paymentMethodId;
  if (promotionCodeId) updateForm['discounts[0][promotion_code]'] = promotionCodeId;

  const updateRes = await stripePost(env, `/subscriptions/${stripeSubId}`, updateForm);
  if (updateRes.body.error) {
    console.error('[ChangeTier] Stripe update failed:', updateRes.body.error.message);
    return fail(updateRes.body.error.message || 'Payment could not be completed', 400);
  }
  const updatedSub = updateRes.body;

  // Inspect the prorated invoice's PaymentIntent for 3D Secure / decline (new-card path).
  const latestInv = (updatedSub.latest_invoice && typeof updatedSub.latest_invoice === 'object')
    ? updatedSub.latest_invoice
    : null;
  const pi = latestInv && typeof latestInv.payment_intent === 'object' ? latestInv.payment_intent : null;
  if (paymentMethodId && pi) {
    if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
      // Client completes 3D Secure with confirmCardPayment; D1 syncs via webhook once paid.
      return Response.json({
        success: true,
        direction: 'upgrade',
        scheduled: false,
        requiresAction: true,
        clientSecret: pi.client_secret,
        subscriptionId: stripeSubId,
        invoiceId: latestInv.id,
        planId,
        interval,
      });
    }
    if (pi.status === 'requires_payment_method') {
      return fail('Your card was declined. Please try another card.', 402);
    }
  }

  // Pull the invoice we just created/paid for receipt details (best-effort).
  let amountPaidCents = null;
  let currency = 'usd';
  let invoiceId = latestInv ? latestInv.id : (updatedSub.latest_invoice || null);
  let invoiceUrl = null;
  let paymentStatus = 'paid';
  if (invoiceId) {
    const inv = await stripeGet(env, `/invoices/${invoiceId}`);
    if (!inv.body.error) {
      amountPaidCents = inv.body.amount_paid ?? inv.body.amount_due ?? null;
      currency = inv.body.currency || 'usd';
      invoiceUrl = inv.body.hosted_invoice_url || null;
      paymentStatus = inv.body.status || paymentStatus;
    }
  }

  // Update D1 immediately — planId + interval + priceId + period end.
  const newPeriodEndISO = updatedSub.current_period_end
    ? new Date(updatedSub.current_period_end * 1000).toISOString()
    : periodEndISO;
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE Subscription SET planId = ?, planType = 'tier', interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
     WHERE stripeSubscriptionId = ?`
  ).bind(planId, interval, newPriceId, newPeriodEndISO, now, stripeSubId).run();

  // Sync to legacy KV (fire-and-forget)
  try {
    const sId = siteId ?? sub.siteId ?? sub.siteid;
    const siteRow = sId
      ? await db.prepare('SELECT domain, legacySource, platform FROM Site WHERE id = ?1 LIMIT 1').bind(sId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: user.email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: sub.stripeCustomerId ?? sub.stripecustomerid,
      status: 'active',
      cancelAtPeriodEnd: !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend),
      // legacySource is only set on migrated legacy sites; Site.platform carries the install
      // origin for everyone else. Falling back to it stops a plugin user's legacy row (and KV
      // shard, which is chosen by this same value) from being demoted by a webapp plan change.
      platform: siteRow?.legacySource || siteRow?.platform || null,
      interval,
    });
  } catch (syncErr) {
    console.warn('[ChangeTier] Legacy sync failed (non-critical):', syncErr?.message);
  }

  console.log('[ChangeTier] upgraded to', planId, interval, 'for org:', organizationId);
  return Response.json({
    success: true,
    direction: 'upgrade',
    scheduled: false,
    planId,
    interval,
    amountPaidCents,
    currency,
    invoiceId,
    invoiceUrl,
    paymentStatus,
    nextBillingDate: newPeriodEndISO,
  });
}
