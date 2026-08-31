// src/handlers/webflowUpgrade.js
//
// Webflow-ID-token-authenticated, siteId-keyed UPGRADE surface for the WEBFLOW
// Designer Extension.
//
//   POST /api/wf/upgrade/change-tier/preview      → prorated amount for a tier change (no change)
//   POST /api/wf/upgrade/change-tier              → commit the tier change (charge card on file)
//   POST /api/wf/upgrade/switch-interval/preview  → prorated amount for monthly↔yearly (no change)
//   POST /api/wf/upgrade/switch-interval          → commit the interval switch (charge card on file)
//
// WHY THIS FILE EXISTS
// This is the Webflow twin of handlers/framerUpgrade.js. The Stripe proration logic
// is identical (both mirror changeTier.js / switchBillingInterval.js); only the
// AUTH MODEL differs:
//
//   • framerUpgrade.js  — verifies the Framer plugin's own HS256 JWT locally with
//                         env.FRAMER_JWT_SECRET, then *advisorily* binds it to the site.
//   • this file         — uses the Designer Extension's Webflow ID token
//                         (`await webflow.getIdToken()`), sent as
//                         Authorization: Bearer <idToken> plus X-Webflow-Site-Id.
//
// The ID token is resolved server-side against Webflow's Resolve-ID-Token endpoint by
// middleware/webflowIdentity.js, which ALSO enforces that the body's `siteId` belongs
// to the authenticated Webflow site. Because /api/wf/* runs that middleware before
// dispatch, these handlers receive a trusted `identity`
// ({ userId, email, webflowSiteId, siteId }) as their 4th argument.
//
// Auth is therefore STRICT here (unlike the Framer twin's advisory binding): a caller
// who merely knows a siteId cannot reach this surface at all.
//
// Defense in depth — these handlers do NOT assume the middleware ran:
//   1. If no `identity` is passed, requireWebflowIdentity() is called directly, so the
//      handlers are safe even if mounted on a different (unwrapped) route.
//   2. `identity.unverified` (the oauth/status escape hatch for sites with no stored
//      OAuth token) is rejected — billing changes always need a resolved token.
//   3. The resolved Site row is re-checked against identity.webflowSiteId, so a body
//      siteId can never target another installation's subscription.
//
// The other change-tier / switch-interval handlers are left untouched.

import { syncSubscriptionUpdateToLegacy } from '../services/syncLegacy.js';
import { requireWebflowIdentity } from '../middleware/webflowIdentity.js';
import { isPromotionCodeAllowedForEmail } from '../services/promoRestrictions.js';

const TAG = '[webflow-upgrade]';
const PLAN_ORDER = { basic: 1, essential: 2, growth: 3 };

// ── Logging ─────────────────────────────────────────────────────────────────
//
// Every request gets a short id so its lines can be read as one story in
// `wrangler tail` even while other users are mid-upgrade. Follow one upgrade with:
//
//   npx wrangler tail --format pretty | grep "webflow-upgrade"
//
// The happy path prints, in order:
//   → change-tier          (entry: method, site header, whether a token was sent)
//   auth ok                (which Webflow user/site the ID token resolved to)
//   site ok / sub ok       (D1 rows that were matched)
//   plan basic→essential   (direction + resolved Stripe price id)
//   stripe sub ok          (live status, item id, trialing?)
//   preview / commit lines (the money)
//   d1 updated + ✓ done    (with total ms)
// Anything that stops the request prints a single `✗ <status> <reason>` line.

/** Short per-request id — enough to correlate, short enough to scan. */
function newReqId() {
  try { return crypto.randomUUID().slice(0, 8); } catch { return String(Date.now()).slice(-8); }
}

const log  = (rid, ...a) => console.log(`${TAG}[${rid}]`, ...a);
const warn = (rid, ...a) => console.warn(`${TAG}[${rid}]`, ...a);

const fail = (error, status, extra) =>
  Response.json({ success: false, error, ...(extra || {}) }, { status });

/**
 * fail() that also logs WHY the request stopped. Every early return uses this, so a
 * failed upgrade always leaves exactly one `✗` line explaining itself — no silent 400s.
 */
const failLog = (rid, error, status, extra) => {
  warn(rid, `✗ ${status} ${error}`);
  return fail(error, status, extra);
};

function trimEnv(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ── Auth ────────────────────────────────────────────────────────────────────

// Resolve a trusted Webflow identity for this request.
//
// `identity` is the object index.js already produced via requireWebflowIdentity for
// every /api/wf/* route; when it is absent (handler mounted elsewhere, or called
// directly in a test) we run the same middleware ourselves. Either way the result is
// a token that Webflow itself resolved for the claimed site.
//
// Returns { ok:true, identity } or { ok:false, res:Response }.
async function requireWebflowAuth(request, env, identity, rid) {
  let id = identity;

  if (!id) {
    // No identity passed in → the /api/wf/* pipeline didn't run this. Resolve it here.
    log(rid, 'auth: no identity passed by router — resolving ID token inline');
    const auth = await requireWebflowIdentity(request, env);
    if (!auth.ok) {
      return { ok: false, res: failLog(rid, auth.error, auth.status, { code: auth.code }) };
    }
    id = auth.identity;
  }

  // Billing mutations always need a RESOLVED token. `unverified` identities exist
  // only so /api/wf/oauth/status can answer for a site with no stored OAuth token —
  // that path skips ID-token resolution and must never reach money movement.
  if (id.unverified) {
    return { ok: false, res: failLog(rid, 'Site is not authorized.', 401, { code: 'SITE_NOT_AUTHORIZED' }) };
  }
  if (!id.webflowSiteId) {
    return { ok: false, res: failLog(rid, 'Missing Webflow site id.', 400, { code: 'MISSING_SITE_ID' }) };
  }

  log(rid, `auth ok — user=${id.email || id.userId || '?'} webflowSite=${id.webflowSiteId} target=${id.siteId || '-'}`);
  return { ok: true, identity: id };
}

// Re-verify that the Site row we resolved really belongs to the authenticated Webflow
// site. requireWebflowIdentity already checked the *requested* id against ownedSiteIds;
// this closes the loop on the row actually loaded from D1.
function siteBelongsToWebflowSite(site, webflowSiteId) {
  if (!site) return false;
  const wf = String(webflowSiteId);
  return String(site.id) === wf || String(site.platformSiteId ?? '') === wf;
}

// ── Site / subscription resolution (siteId-keyed, mirrors webflowBillingWf.js) ──

function pick(sub, camel, snake) {
  return sub?.[camel] ?? sub?.[snake] ?? null;
}

async function resolveSite(db, siteId) {
  if (!siteId) return null;
  return db
    .prepare('SELECT id, organizationId, platformSiteId FROM Site WHERE id = ?1 OR platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
    .bind(siteId)
    .first()
    .catch(() => null);
}

async function resolveSubscription(db, site) {
  if (!site) return null;
  const cols =
    'id, organizationId, siteId, planId, planType, status, stripeSubscriptionId, stripeCustomerId, interval, currentPeriodEnd, cancelAtPeriodEnd';
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

// ── Stripe helpers (ported from changeTier.js) ──────────────────────────────

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

function tierPriceMap(env) {
  return {
    basic:     { monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
}

// Sum only the proration line items — the invoice's amount_due would fold in the next
// full renewal and overstate the charge. Mirrors changeTier.js / switchBillingInterval.js.
function sumProrationCents(invoiceBody) {
  let total = 0;
  let sawProration = false;
  for (const line of invoiceBody?.lines?.data || []) {
    if (line.proration === true) { total += line.amount || 0; sawProration = true; }
  }
  return sawProration ? total : (invoiceBody?.amount_due ?? invoiceBody?.total ?? null);
}

// Preview the net amount charged now for an immediate (upgrade / interval-bump) change.
// Tries Upcoming Invoice, falls back to Create Preview Invoice for flexible-billing subs.
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

  const customerId = stripeSub.customer;
  const items = stripeSub.items?.data || [];
  const form = {
    customer: customerId,
    subscription: stripeSubId,
    'subscription_details[proration_behavior]': 'create_prorations',
  };
  items.forEach((item, i) => {
    form[`subscription_details[items][${i}][id]`] = item.id;
    form[`subscription_details[items][${i}][price]`] = i === 0 ? newPriceId : item.price?.id;
  });
  if (promotionCodeId) form['discounts[0][promotion_code]'] = promotionCodeId;

  const prev = await stripePost(env, '/invoices/create_preview', form);
  if (prev.body.error) {
    return { error: prev.body.error.message || 'Could not preview the charge' };
  }
  return { amountDueCents: sumProrationCents(prev.body), currency: prev.body.currency || 'usd' };
}

// ═════════════════════════════════════════════════════════════════════════════
//  CHANGE TIER  (basic / essential / growth)  — mirrors changeTier.js
// ═════════════════════════════════════════════════════════════════════════════

// Shared prep for change-tier preview + commit: Webflow-ID-token auth, validation,
// load subscription by siteId, resolve the new price, read the live Stripe subscription.
async function prepareChange(request, env, identity, label) {
  const rid = newReqId();
  const t0 = Date.now();
  log(rid, `→ ${label} ${request.method} site=${request.headers.get('X-Webflow-Site-Id') || '-'} hasToken=${!!request.headers.get('Authorization')}`);

  if (request.method !== 'POST') return { error: failLog(rid, 'Method not allowed', 405) };

  const db = env.CONSENT_WEBAPP;
  if (!db) return { error: failLog(rid, 'Database not available', 503) };
  if (!env.STRIPE_SECRET_KEY) return { error: failLog(rid, 'Stripe not configured', 503) };

  const auth = await requireWebflowAuth(request, env, identity, rid);
  if (!auth.ok) return { error: auth.res };
  const id = auth.identity;

  let body;
  try { body = await request.json(); } catch { return { error: failLog(rid, 'Invalid JSON', 400) }; }

  // The token's own site is the fallback target, so the app may omit siteId entirely.
  const siteId = String(body.siteId || id.siteId || id.webflowSiteId || '').trim();
  const planId = ['basic', 'essential', 'growth'].includes(body.planId) ? body.planId : null;
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const promotionCodeId = body.promotionCodeId && String(body.promotionCodeId).trim()
    ? String(body.promotionCodeId).trim()
    : null;
  const paymentMethodId = body.paymentMethodId && String(body.paymentMethodId).trim()
    ? String(body.paymentMethodId).trim()
    : null;

  log(rid, `body: siteId=${siteId || '-'} planId=${body.planId || '-'} interval=${body.interval || '-'} promo=${promotionCodeId ? 'yes' : 'no'} pm=${paymentMethodId ? 'yes' : 'no'}`);

  if (!siteId) return { error: failLog(rid, 'siteId required', 400) };
  if (!planId) return { error: failLog(rid, 'planId must be basic, essential, or growth', 400) };

  // Per-customer promo restrictions (see services/promoRestrictions.js).
  if (promotionCodeId) {
    const promoOk = await isPromotionCodeAllowedForEmail(
      env.STRIPE_SECRET_KEY, promotionCodeId, id.email,
    );
    if (!promoOk.allowed) return { error: failLog(rid, promoOk.reason, 400) };
  }

  const site = await resolveSite(db, siteId);
  if (!site) return { error: failLog(rid, 'Site not found', 404) };
  if (!siteBelongsToWebflowSite(site, id.webflowSiteId)) {
    warn(rid, `site not owned — site.id=${site.id} platformSiteId=${site.platformSiteId || '-'} webflowSite=${id.webflowSiteId}`);
    return { error: failLog(rid, 'Not authorized for this site', 403, { code: 'SITE_FORBIDDEN' }) };
  }
  log(rid, `site ok — id=${site.id} platformSiteId=${site.platformSiteId || '-'} org=${site.organizationId || '-'}`);

  const sub = await resolveSubscription(db, site);
  if (!sub) return { error: failLog(rid, 'No active subscription found', 404) };

  const stripeSubId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const currentPlanId = String(pick(sub, 'planId', 'planid') || '').toLowerCase();
  const currentInterval = String(pick(sub, 'interval', 'interval') || 'monthly').toLowerCase();
  log(rid, `sub ok — d1Id=${sub.id} plan=${currentPlanId || '-'}/${currentInterval} status=${pick(sub, 'status', 'status') || '-'} stripeSub=${stripeSubId || 'MISSING'}`);

  if (!stripeSubId) return { error: failLog(rid, 'Subscription has no Stripe ID', 400) };
  if (!PLAN_ORDER[currentPlanId]) {
    return { error: failLog(rid, 'Current plan is not a tier plan; cannot change here', 400) };
  }
  if (currentPlanId === planId && currentInterval === interval) {
    return { error: failLog(rid, 'Already on this plan', 400) };
  }

  const newPriceId = tierPriceMap(env)[planId]?.[interval];
  if (!newPriceId) {
    console.error(`${TAG}[${rid}] Missing price env var for`, planId, interval);
    return { error: failLog(rid, `Price not configured for ${planId} ${interval}`, 503) };
  }

  const isDowngrade = PLAN_ORDER[planId] < PLAN_ORDER[currentPlanId];
  log(rid, `plan ${currentPlanId}/${currentInterval} → ${planId}/${interval} (${isDowngrade ? 'DOWNGRADE' : 'UPGRADE'}) price=${newPriceId}`);

  const subRes = await stripeGet(env, `/subscriptions/${stripeSubId}`);
  if (subRes.body.error) {
    return { error: failLog(rid, subRes.body.error.message || 'Failed to read subscription', 400) };
  }
  const stripeSub = subRes.body;
  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return { error: failLog(rid, 'Could not read subscription item ID', 500) };

  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);
  const trialEndISO = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;
  const periodEndISO = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null;
  log(rid, `stripe sub ok — status=${stripeSub.status} item=${subItemId} trialing=${!!isTrialing} periodEnd=${periodEndISO || '-'} schedule=${stripeSub.schedule || 'none'}`);

  return {
    ctx: {
      rid, t0,
      db, email: id.email || null, env, siteId, site, planId, interval, promotionCodeId, paymentMethodId,
      sub, stripeSubId, stripeSub, subItemId, newPriceId,
      currentPlanId, currentInterval, isDowngrade, isTrialing, trialEndISO, periodEndISO,
    },
  };
}

// POST /api/wf/upgrade/change-tier/preview
export async function handleWebflowChangeTierPreview(request, env, ctxArg, identity) {
  const prep = await prepareChange(request, env, identity, 'change-tier/preview');
  if (prep.error) return prep.error;
  const ctx = prep.ctx;
  const { rid, t0, currentPlanId, currentInterval, planId, interval, isDowngrade, isTrialing, trialEndISO, periodEndISO, newPriceId } = ctx;

  if (isTrialing) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    if (priceRes.body.error) return failLog(rid, priceRes.body.error.message || 'Could not read the plan price', 400);
    log(rid, `✓ preview (trialing) — charged at trial end: ${priceRes.body.unit_amount} ${priceRes.body.currency || 'usd'} (${Date.now() - t0}ms)`);
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

  if (isDowngrade) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    const newAmount = priceRes.body?.error ? null : (priceRes.body.unit_amount ?? null);
    log(rid, `✓ preview (downgrade) — no charge now, effective ${periodEndISO || '-'}, new plan ${newAmount} ${priceRes.body?.currency || 'usd'} (${Date.now() - t0}ms)`);
    return Response.json({
      success: true,
      direction: 'downgrade',
      currentPlanId, currentInterval, planId, interval,
      isTrialing: false,
      amountDueCents: 0,
      newPlanAmountCents: newAmount,
      currency: priceRes.body?.currency || 'usd',
      trialEnd: null,
      effectiveAt: periodEndISO,
    });
  }

  const res = await previewImmediateAmount(env, ctx);
  if (res.error) return failLog(rid, res.error, 400);
  log(rid, `✓ preview (upgrade) — due now: ${res.amountDueCents} ${res.currency}${res.couponPreviewSkipped ? ' [coupon skipped in preview]' : ''} (${Date.now() - t0}ms)`);
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

// POST /api/wf/upgrade/change-tier — commit.
export async function handleWebflowChangeTier(request, env, ctxArg, identity) {
  const prep = await prepareChange(request, env, identity, 'change-tier');
  if (prep.error) return prep.error;
  const {
    rid, t0,
    db, email, siteId, planId, interval, promotionCodeId, paymentMethodId,
    sub, stripeSubId, stripeSub, subItemId, newPriceId, isDowngrade, isTrialing, periodEndISO,
  } = prep.ctx;

  // ── Downgrade → schedule for period end (no charge now) ──────────────────
  if (isDowngrade && !isTrialing) {
    log(rid, 'commit: scheduling downgrade at period end');
    const currentPriceId = stripeSub.items?.data?.[0]?.price?.id;
    const startDate = stripeSub.current_period_start;
    const changeDate = stripeSub.current_period_end;

    if (stripeSub.schedule) {
      log(rid, `releasing existing schedule ${stripeSub.schedule}`);
      await stripePost(env, `/subscription_schedules/${stripeSub.schedule}/release`, {}).catch(() => {});
    }

    const created = await stripePost(env, '/subscription_schedules', { from_subscription: stripeSubId });
    if (created.body.error) {
      return failLog(rid, created.body.error.message || 'Could not schedule the downgrade', 400);
    }
    const schedId = created.body.id;
    log(rid, `schedule created ${schedId}`);

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
      'metadata[organizationId]': pick(sub, 'organizationId', 'organizationid') || '',
    };
    const updated = await stripePost(env, `/subscription_schedules/${schedId}`, updateForm);
    if (updated.body.error) {
      return failLog(rid, updated.body.error.message || 'Could not schedule the downgrade', 400);
    }

    log(rid, `✓ done — downgrade to ${planId}/${interval} scheduled for ${periodEndISO || '-'} (${Date.now() - t0}ms)`);
    return Response.json({
      success: true,
      direction: 'downgrade',
      scheduled: true,
      effectiveAt: periodEndISO,
      planId, interval,
    });
  }

  // ── Upgrade (or interval bump) → apply now, invoice the proration immediately ──
  log(rid, `commit: applying ${isTrialing ? 'trialing (no proration)' : 'immediate + always_invoice'} change now`);
  if (stripeSub.schedule) {
    log(rid, `releasing existing schedule ${stripeSub.schedule}`);
    await stripePost(env, `/subscription_schedules/${stripeSub.schedule}/release`, {}).catch(() => {});
  }

  const customerId = stripeSub.customer;
  if (paymentMethodId) {
    const attach = await stripePost(env, `/payment_methods/${paymentMethodId}/attach`, { customer: customerId });
    if (attach.body.error) {
      return failLog(rid, attach.body.error.message || 'Could not use that card. Please try another.', 400);
    }
    log(rid, `card ${paymentMethodId} attached to ${customerId}`);
  }

  const updateForm = {
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: isTrialing ? 'none' : 'always_invoice',
    payment_behavior: paymentMethodId ? 'default_incomplete' : 'error_if_incomplete',
    'metadata[planId]': planId,
    'metadata[interval]': interval,
    'expand[0]': 'latest_invoice.payment_intent',
  };
  if (paymentMethodId) updateForm['default_payment_method'] = paymentMethodId;
  if (promotionCodeId) updateForm['discounts[0][promotion_code]'] = promotionCodeId;

  const updateRes = await stripePost(env, `/subscriptions/${stripeSubId}`, updateForm);
  if (updateRes.body.error) {
    // The most common real failure: the saved card was declined, or there is no
    // default payment method on the customer at all.
    return failLog(rid, updateRes.body.error.message || 'Payment could not be completed', 400);
  }
  const updatedSub = updateRes.body;
  log(rid, `stripe sub updated — status=${updatedSub.status} price=${updatedSub.items?.data?.[0]?.price?.id || '-'}`);

  const latestInv = (updatedSub.latest_invoice && typeof updatedSub.latest_invoice === 'object')
    ? updatedSub.latest_invoice
    : null;
  const pi = latestInv && typeof latestInv.payment_intent === 'object' ? latestInv.payment_intent : null;
  if (paymentMethodId && pi) {
    log(rid, `payment intent ${pi.id} status=${pi.status}`);
    if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
      log(rid, `✓ done — 3DS required, returning clientSecret (${Date.now() - t0}ms)`);
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
      return failLog(rid, 'Your card was declined. Please try another card.', 402);
    }
  }

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
      log(rid, `invoice ${invoiceId} — status=${paymentStatus} paid=${amountPaidCents} ${currency}`);
    } else {
      warn(rid, `invoice ${invoiceId} read failed: ${inv.body.error.message}`);
    }
  } else {
    log(rid, 'no invoice on the updated subscription (nothing to charge)');
  }

  const newPeriodEndISO = updatedSub.current_period_end
    ? new Date(updatedSub.current_period_end * 1000).toISOString()
    : periodEndISO;
  const now = new Date().toISOString();
  // D1 is what the app's billing/status calls read back, so a silent failure here
  // means the UI keeps showing the OLD plan even though Stripe charged correctly.
  try {
    const upd = await db.prepare(
      `UPDATE Subscription SET planId = ?, planType = 'tier', interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
       WHERE stripeSubscriptionId = ?`,
    ).bind(planId, interval, newPriceId, newPeriodEndISO, now, stripeSubId).run();
    const rows = upd?.meta?.changes ?? upd?.meta?.rows_written ?? '?';
    log(rid, `d1 updated — ${rows} row(s) → ${planId}/${interval} periodEnd=${newPeriodEndISO || '-'}`);
    if (rows === 0) warn(rid, `d1 matched NO row for stripeSubscriptionId=${stripeSubId} — the app will still show the old plan`);
  } catch (dbErr) {
    // Stripe already charged — never fail the response on the bookkeeping write.
    console.error(`${TAG}[${rid}] d1 update FAILED (Stripe change already applied):`, dbErr?.message || dbErr);
  }

  try {
    const sId = siteId ?? sub.siteId ?? sub.siteid;
    const siteRow = sId
      ? await db.prepare('SELECT domain, legacySource FROM Site WHERE id = ?1 OR platformSiteId = ?1 LIMIT 1').bind(sId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: pick(sub, 'stripeCustomerId', 'stripecustomerid'),
      status: 'active',
      cancelAtPeriodEnd: !!(pick(sub, 'cancelAtPeriodEnd', 'cancelatperiodend')),
      platform: siteRow?.legacySource || 'webflow',
      interval,
    });
    log(rid, `legacy sync ok — domain=${siteRow?.domain || '-'} source=${siteRow?.legacySource || 'webflow'}`);
  } catch (syncErr) {
    warn(rid, 'legacy sync failed (non-critical):', syncErr?.message);
  }

  log(rid, `✓ done — ${planId}/${interval} live, charged ${amountPaidCents} ${currency}, invoice=${paymentStatus} (${Date.now() - t0}ms)`);
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

// ═════════════════════════════════════════════════════════════════════════════
//  SWITCH INTERVAL  (monthly ↔ yearly, same tier)  — mirrors switchBillingInterval.js
// ═════════════════════════════════════════════════════════════════════════════

// Shared prep for switch-interval preview + commit.
async function prepareSwitch(request, env, identity, label) {
  const rid = newReqId();
  const t0 = Date.now();
  log(rid, `→ ${label} ${request.method} site=${request.headers.get('X-Webflow-Site-Id') || '-'} hasToken=${!!request.headers.get('Authorization')}`);

  if (request.method !== 'POST') return { error: failLog(rid, 'Method not allowed', 405) };

  const db = env.CONSENT_WEBAPP;
  if (!db) return { error: failLog(rid, 'Database not available', 503) };
  if (!env.STRIPE_SECRET_KEY) return { error: failLog(rid, 'Stripe not configured', 503) };

  const auth = await requireWebflowAuth(request, env, identity, rid);
  if (!auth.ok) return { error: auth.res };
  const id = auth.identity;

  let body;
  try { body = await request.json(); } catch { return { error: failLog(rid, 'Invalid JSON', 400) }; }

  const siteId = String(body.siteId || id.siteId || id.webflowSiteId || '').trim();
  const targetInterval = body.targetInterval === 'yearly' ? 'yearly' : body.targetInterval === 'monthly' ? 'monthly' : null;
  log(rid, `body: siteId=${siteId || '-'} targetInterval=${body.targetInterval || '-'}`);

  if (!siteId) return { error: failLog(rid, 'siteId required', 400) };
  if (!targetInterval) return { error: failLog(rid, 'targetInterval must be monthly or yearly', 400) };

  const site = await resolveSite(db, siteId);
  if (!site) return { error: failLog(rid, 'Site not found', 404) };
  if (!siteBelongsToWebflowSite(site, id.webflowSiteId)) {
    warn(rid, `site not owned — site.id=${site.id} platformSiteId=${site.platformSiteId || '-'} webflowSite=${id.webflowSiteId}`);
    return { error: failLog(rid, 'Not authorized for this site', 403, { code: 'SITE_FORBIDDEN' }) };
  }
  log(rid, `site ok — id=${site.id} platformSiteId=${site.platformSiteId || '-'} org=${site.organizationId || '-'}`);

  const sub = await resolveSubscription(db, site);
  if (!sub) return { error: failLog(rid, 'No active subscription found', 404) };

  const stripeSubId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const currentInterval = String(pick(sub, 'interval', 'interval') || 'monthly').toLowerCase();
  const planId = String(pick(sub, 'planId', 'planid') || '').toLowerCase();
  log(rid, `sub ok — d1Id=${sub.id} plan=${planId || '-'}/${currentInterval} status=${pick(sub, 'status', 'status') || '-'} stripeSub=${stripeSubId || 'MISSING'}`);

  if (!stripeSubId) return { error: failLog(rid, 'Subscription has no Stripe ID', 400) };
  if (currentInterval === targetInterval) return { error: failLog(rid, `Already on ${targetInterval} billing`, 400) };
  if (!['basic', 'essential', 'growth'].includes(planId)) {
    return { error: failLog(rid, 'Cannot switch interval for this plan type', 400) };
  }

  const newPriceId = tierPriceMap(env)[planId]?.[targetInterval];
  if (!newPriceId) {
    console.error(`${TAG}[${rid}] Missing price env var for`, planId, targetInterval);
    return { error: failLog(rid, `Price not configured for ${planId} ${targetInterval}`, 503) };
  }
  log(rid, `interval ${currentInterval} → ${targetInterval} on ${planId} price=${newPriceId}`);

  const subRes = await stripeGet(env, `/subscriptions/${stripeSubId}`);
  if (subRes.body.error) {
    return { error: failLog(rid, subRes.body.error.message || 'Failed to read subscription', 400) };
  }
  const stripeSub = subRes.body;

  if (stripeSub.status === 'canceled' || stripeSub.status === 'incomplete_expired') {
    warn(rid, `✗ 409 subscription is ${stripeSub.status} — caller must resubscribe via checkout`);
    return {
      error: Response.json(
        { success: false, canceled: true, plan: planId, targetInterval, error: 'This subscription was canceled. Start a new checkout to resubscribe.' },
        { status: 409 },
      ),
    };
  }

  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return { error: failLog(rid, 'Could not read subscription item ID', 500) };

  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);
  const trialEndISO = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;
  log(rid, `stripe sub ok — status=${stripeSub.status} item=${subItemId} trialing=${!!isTrialing}`);

  return {
    ctx: {
      rid, t0,
      db, email: id.email || null, siteId, site, targetInterval, currentInterval, planId,
      sub, stripeSubId, stripeSub, subItemId, newPriceId, isTrialing, trialEndISO,
    },
  };
}

// POST /api/wf/upgrade/switch-interval/preview
export async function handleWebflowSwitchIntervalPreview(request, env, ctxArg, identity) {
  const prep = await prepareSwitch(request, env, identity, 'switch-interval/preview');
  if (prep.error) return prep.error;
  const { rid, t0, stripeSubId, subItemId, newPriceId, targetInterval, currentInterval, isTrialing, trialEndISO } = prep.ctx;

  let amountDueCents = null;
  let currency = 'usd';

  if (isTrialing) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    if (priceRes.body.error) return failLog(rid, priceRes.body.error.message || 'Could not read the plan price', 400);
    amountDueCents = priceRes.body.unit_amount ?? null;
    currency = priceRes.body.currency || 'usd';
  } else {
    const params = new URLSearchParams({
      subscription: stripeSubId,
      'subscription_items[0][id]': subItemId,
      'subscription_items[0][price]': newPriceId,
      subscription_proration_behavior: 'create_prorations',
    });
    const inv = await stripeGet(env, `/invoices/upcoming?${params.toString()}`);
    if (inv.body.error) {
      return failLog(rid, inv.body.error.message || 'Could not preview the charge', 400);
    }
    amountDueCents = sumProrationCents(inv.body);
    currency = inv.body.currency || 'usd';
  }

  log(rid, `✓ preview (interval) — ${currentInterval}→${targetInterval} due now: ${amountDueCents} ${currency} trialing=${!!isTrialing} (${Date.now() - t0}ms)`);
  return Response.json({
    success: true,
    currentInterval,
    targetInterval,
    isTrialing: !!isTrialing,
    amountDueCents,
    currency,
    trialEnd: isTrialing ? trialEndISO : null,
  });
}

// POST /api/wf/upgrade/switch-interval — commit.
export async function handleWebflowSwitchInterval(request, env, ctxArg, identity) {
  const prep = await prepareSwitch(request, env, identity, 'switch-interval');
  if (prep.error) return prep.error;
  const {
    rid, t0,
    db, email, siteId, targetInterval, currentInterval,
    sub, stripeSubId, subItemId, newPriceId, isTrialing,
  } = prep.ctx;

  const updateForm = {
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: isTrialing ? 'none' : 'always_invoice',
    payment_behavior: 'error_if_incomplete',
  };
  log(rid, `commit: switching interval (${isTrialing ? 'no proration — trialing' : 'always_invoice'})`);
  const updateRes = await stripePost(env, `/subscriptions/${stripeSubId}`, updateForm);
  if (updateRes.body.error) {
    return failLog(rid, updateRes.body.error.message || 'Failed to switch billing interval', 400);
  }
  const updated = updateRes.body;
  log(rid, `stripe sub updated — status=${updated.status} price=${updated.items?.data?.[0]?.price?.id || '-'}`);

  let newPeriodEnd = updated.current_period_end || null;
  if (!newPeriodEnd) {
    const fresh = await stripeGet(env, `/subscriptions/${stripeSubId}`);
    newPeriodEnd = fresh.body?.current_period_end || null;
  }
  const newPeriodEndISO = newPeriodEnd ? new Date(newPeriodEnd * 1000).toISOString() : null;

  const now = new Date().toISOString();
  try {
    const upd = await db.prepare(
      `UPDATE Subscription SET interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
       WHERE stripeSubscriptionId = ?`,
    ).bind(targetInterval, newPriceId, newPeriodEndISO, now, stripeSubId).run();
    const rows = upd?.meta?.changes ?? upd?.meta?.rows_written ?? '?';
    log(rid, `d1 updated — ${rows} row(s) → interval=${targetInterval} periodEnd=${newPeriodEndISO || '-'}`);
    if (rows === 0) warn(rid, `d1 matched NO row for stripeSubscriptionId=${stripeSubId} — the app will still show the old interval`);
  } catch (dbErr) {
    console.error(`${TAG}[${rid}] d1 update FAILED (Stripe change already applied):`, dbErr?.message || dbErr);
  }

  try {
    const sId = siteId ?? sub.siteId ?? sub.siteid;
    const siteRow = sId
      ? await db.prepare('SELECT domain, legacySource FROM Site WHERE id = ?1 OR platformSiteId = ?1 LIMIT 1').bind(sId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: pick(sub, 'stripeCustomerId', 'stripecustomerid'),
      status: pick(sub, 'status', 'status') || 'active',
      cancelAtPeriodEnd: !!(pick(sub, 'cancelAtPeriodEnd', 'cancelatperiodend')),
      platform: siteRow?.legacySource || 'webflow',
      interval: targetInterval,
    });
    log(rid, `legacy sync ok — domain=${siteRow?.domain || '-'} source=${siteRow?.legacySource || 'webflow'}`);
  } catch (syncErr) {
    warn(rid, 'legacy sync failed (non-critical):', syncErr?.message);
  }

  log(rid, `✓ done — ${currentInterval}→${targetInterval} live, nextBilling=${newPeriodEndISO || '-'} (${Date.now() - t0}ms)`);
  return Response.json({
    success: true,
    interval: targetInterval,
    nextBillingDate: newPeriodEndISO,
  });
}
