// POST /api/subscriptions/upgrade
// Upgrade or downgrade: cancel the existing subscription for a site, then create
// a new Stripe Checkout Session for the new plan.
// The old subscription is cancelled only after the new checkout completes
// (via stripeWebhook.js reading oldStripeSubscriptionId from session metadata).
//
// Body: { siteId, organizationId, planId: 'basic'|'essential'|'growth', interval: 'monthly'|'yearly', successUrl?, cancelUrl? }
// Returns: { success, url, sessionId }

import { getSessionById, getUserById, getSubscriptionBySiteId, getSiteTrialUsed, isSiteTrialIneligible } from '../services/db.js';
import { flowLog } from '../utils/flowLog.js';
import { resolveBillingActor } from '../services/team.js';
import {
  isCodeAllowedForEmail,
  isCouponIdAllowedForEmail,
  PROMO_NOT_ALLOWED_MESSAGE,
} from '../services/promoRestrictions.js';

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

async function validatePriceIsRecurring(secret, priceId) {
  if (!priceId || !String(priceId).startsWith('price_')) {
    return { ok: false, error: `Invalid price id: ${priceId}` };
  }
  try {
    const res = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(String(priceId).trim())}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const p = await res.json();
    if (p.error) return { ok: false, error: p.error.message || 'Stripe price lookup failed' };
    if (p.type !== 'recurring') return { ok: false, error: `Price ${priceId} is not a recurring/subscription price.` };
    if (p.active === false) return { ok: false, error: `Price ${priceId} is archived/inactive.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'Price validation failed' };
  }
}

export async function handleUpgradeSubscription(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const secret = env.STRIPE_SECRET_KEY;
  const db = env.CONSENT_WEBAPP;

  if (!secret) { console.error('[UPGRADE] Missing STRIPE_SECRET_KEY'); return Response.json({ success: false, error: 'Stripe not configured.' }, { status: 503 }); }
  if (!db) { console.error('[UPGRADE] Missing CONSENT_WEBAPP binding'); return Response.json({ success: false, error: 'Database not available.' }, { status: 503 }); }

  // Auth
  const sid = getSessionIdFromCookie(request);
  if (!sid) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const session = await getSessionById(db, sid);
  if (!session) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const email = (user.email && typeof user.email === 'string') ? user.email.trim().toLowerCase() : null;
  if (!email || !email.includes('@')) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const siteId = (body.siteId && typeof body.siteId === 'string') ? body.siteId.trim() : null;
  const organizationId = (body.organizationId && typeof body.organizationId === 'string') ? body.organizationId.trim() : null;
  const planId = (['basic', 'essential', 'growth'].includes(body.planId)) ? body.planId : null;
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const stripeCouponId = body.stripeCouponId && body.stripeCouponId.trim() ? body.stripeCouponId.trim() : null;
  const promotionCodeId = body.promotionCodeId && body.promotionCodeId.trim() ? body.promotionCodeId.trim() : null;
  const couponCode = body.couponCode && body.couponCode.trim() ? body.couponCode.trim() : null;
  const rawSuccessUrl = body.successUrl || `${request.url.replace(/\/api\/.*$/, '')}/dashboard`;
  const successUrl = rawSuccessUrl.includes('?')
    ? `${rawSuccessUrl}&session_id={CHECKOUT_SESSION_ID}`
    : `${rawSuccessUrl}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancelUrl || `${request.url.replace(/\/api\/.*$/, '')}/dashboard`;


  if (!siteId) { console.error('[UPGRADE] Missing siteId'); return Response.json({ success: false, error: 'siteId required' }, { status: 400 }); }
  if (!organizationId) { console.error('[UPGRADE] Missing organizationId'); return Response.json({ success: false, error: 'organizationId required' }, { status: 400 }); }
  if (!planId) { console.error('[UPGRADE] Invalid planId:', body.planId); return Response.json({ success: false, error: 'planId must be basic, essential, or growth' }, { status: 400 }); }

  // Resolve the new Stripe price id
  const tierPriceMap = {
    basic:     { monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
  const newPriceId = tierPriceMap[planId][interval] || tierPriceMap[planId].monthly;
  if (!newPriceId) {
    console.error('[UPGRADE] Missing price env var for', planId, interval);
    return Response.json(
      { success: false, error: `Missing env STRIPE_PRICE_${planId.toUpperCase()}_${interval.toUpperCase()}.` },
      { status: 503 },
    );
  }

  const priceCheck = await validatePriceIsRecurring(secret, newPriceId);
  if (!priceCheck.ok) {
    console.error('[UPGRADE] price validation failed:', priceCheck.error);
    return Response.json({ success: false, error: priceCheck.error }, { status: 400 });
  }

  // Find existing active subscription for this site (may be null for free tier)
  const existingSub = await getSubscriptionBySiteId(db, siteId);
  const oldStripeSubscriptionId = existingSub
    ? (existingSub.stripeSubscriptionId ?? existingSub.stripesubscriptionid ?? null)
    : null;

  // Look up platformSiteId so the webhook can update WEBFLOW_AUTHENTICATION KV
  let platformSiteId = null;
  try {
    const siteRow = await db.prepare('SELECT platformSiteId FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
    platformSiteId = siteRow?.platformSiteId ?? null;
  } catch (e) {
    console.error('[UPGRADE] platformSiteId lookup failed:', e?.message);
  }

  // A team Admin upgrading for the owner bills the owner's Stripe customer (owner's
  // billing email). Owners take the unchanged path.
  let customerEmail = email;
  if (organizationId) {
    const actor = await resolveBillingActor(db, user.id, organizationId, siteId);
    if (actor.admin) {
      if (planId === 'basic') {
        return Response.json({ success: false, error: "Only the account owner can move a site to Basic or Free. Team members lose access on those plans.", code: 'OWNER_ONLY' }, { status: 403 });
      }
      if (!actor.ownerEmail) {
        return Response.json({ success: false, error: "Could not find the account owner's billing email." }, { status: 409 });
      }
      customerEmail = actor.ownerEmail;
    }
  }

  // Build Stripe Checkout Session — subscription mode with new plan
  const params = new URLSearchParams();
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('client_reference_id', organizationId);
  params.set('customer_email', customerEmail);
  params.set('billing_address_collection', 'auto');
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', newPriceId);
  params.set('line_items[0][quantity]', '1');
  params.set('subscription_data[metadata][organizationId]', organizationId);
  params.set('subscription_data[metadata][planId]', planId);
  params.set('subscription_data[metadata][planType]', 'tier');
  params.set('subscription_data[metadata][interval]', interval);
  params.set('subscription_data[metadata][siteId]', siteId);
  if (platformSiteId) {
    params.set('subscription_data[metadata][platformId]', platformSiteId);
  } else {
    console.warn('[UPGRADE] platformSiteId not found — KV plan stamp will fall back to DB lookup in webhook');
  }
  // Pass old subscription id so the webhook can cancel it after payment succeeds
  if (oldStripeSubscriptionId) {
    params.set('subscription_data[metadata][oldStripeSubscriptionId]', oldStripeSubscriptionId);
  }
  // Only give free trial if: no existing paid subscription AND trial has never been used before
  // Subscription history counts, not just the flag — no second trial for a returning site.
  const trialAlreadyUsed = await isSiteTrialIneligible(db, { siteId }, env);
  flowLog(env, 'trial', (!oldStripeSubscriptionId && !trialAlreadyUsed) ? 'granted' : 'withheld', {
    path: 'upgrade', siteId, hasOldSubscription: !!oldStripeSubscriptionId, trialAlreadyUsed,
  });
  if (!oldStripeSubscriptionId && !trialAlreadyUsed) {
    params.set('subscription_data[trial_period_days]', '14');
  }

  // ── Apply coupon / promotion code (optional) ─────────────────────────────

  // a) Raw coupon id (coup_xxx) — bypasses promotion-code checks, so gate it here.
  if (stripeCouponId) {
    const rawOk = await isCouponIdAllowedForEmail(secret, stripeCouponId, customerEmail);
    if (!rawOk.allowed) {
      return Response.json({ success: false, error: rawOk.reason }, { status: 400 });
    }
    params.set('discounts[0][coupon]', stripeCouponId);
  }

  // b) Promotion code id (promo_xxx) — re-validate server-side
  if (promotionCodeId) {
    try {
      const verifyRes = await fetch(
        `https://api.stripe.com/v1/promotion_codes/${encodeURIComponent(promotionCodeId)}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      const verify = await verifyRes.json();
      if (verify.error || !verify.active) {
        console.warn('[UPGRADE] promotion code rejected', { id: promotionCodeId, err: verify.error?.message });
        return Response.json({ success: false, error: 'Promotion code is no longer valid' }, { status: 400 });
      }
      if (!isCodeAllowedForEmail(verify.code, customerEmail)) {
        console.warn('[UPGRADE] promo restricted to another account', { code: verify.code, email });
        return Response.json({ success: false, error: PROMO_NOT_ALLOWED_MESSAGE }, { status: 400 });
      }
      params.set('discounts[0][promotion_code]', promotionCodeId);
      if (verify.code) params.set('subscription_data[metadata][promotionCode]', verify.code);
    } catch (e) {
      console.error('[UPGRADE] promotion code verify failed', e?.message);
      return Response.json({ success: false, error: 'Promotion code validation failed' }, { status: 400 });
    }
  }

  // c) Customer-facing coupon string ("MEMORIAL25") — resolve to promo_xxx via list endpoint,
  //    then apply same way. Skipped if promotionCodeId already applied (no stacking).
  if (couponCode && !promotionCodeId) {
    try {
      const listParams = new URLSearchParams({ code: couponCode, active: 'true', limit: '1' });
      const lookupRes = await fetch(
        `https://api.stripe.com/v1/promotion_codes?${listParams.toString()}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      const lookupData = await lookupRes.json();
      if (lookupData?.error) {
        return Response.json({ success: false, error: lookupData.error.message || 'Coupon lookup failed' }, { status: 400 });
      }
      const promo = lookupData?.data?.[0];
      if (!promo || !promo.active) {
        return Response.json({ success: false, error: 'Invalid or expired coupon code' }, { status: 400 });
      }
      if (!isCodeAllowedForEmail(promo.code || couponCode, customerEmail)) {
        console.warn('[UPGRADE] coupon restricted to another account', { code: promo.code || couponCode, email });
        return Response.json({ success: false, error: PROMO_NOT_ALLOWED_MESSAGE }, { status: 400 });
      }
      params.set('discounts[0][promotion_code]', promo.id);
      params.set('subscription_data[metadata][promotionCode]', promo.code || couponCode);
    } catch (e) {
      console.error('[UPGRADE] coupon code resolution failed', e?.message);
      return Response.json({ success: false, error: 'Coupon validation failed' }, { status: 400 });
    }
  }

  if (params.has('discounts[0][promotion_code]') || params.has('discounts[0][coupon]')) {
  } else {
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await res.json();
  if (data.error) {
    console.error('[UPGRADE] Stripe error:', data.error);
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 400 });
  }
  if (!data.id || !data.url) {
    console.error('[UPGRADE] No session id/url in Stripe response:', data);
    return Response.json({ success: false, error: 'No session URL returned from Stripe' }, { status: 502 });
  }

  return Response.json({ success: true, sessionId: data.id, url: data.url });
}
