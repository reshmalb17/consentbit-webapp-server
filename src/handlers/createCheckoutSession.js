// POST /api/create-checkout-session
// Requires logged-in user (session cookie sid). No guest checkout.
// Body: { organizationId, planId?: 'basic'|'essential'|'growth', interval, siteId?, siteName?, siteDomain?, stripeCouponId?, successUrl, cancelUrl }
// Per-site only: tier subscription (planId) or legacy single-site subscription. Bulk / multi-seat quantity checkout is not enabled.
// Checkout uses `customer_email` from the logged-in user; Stripe creates the Customer on completion.
// Returns { success, sessionId, url }

import { getSessionById, getUserById, getSiteTrialUsed, isSiteTrialIneligible } from '../services/db.js';
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

/** Cloudflare [vars] / secrets sometimes pick up trailing spaces from copy-paste. */
function trimEnv(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/** Subscription Checkout requires `price` ids with type=recurring (not one-time). */
async function validatePriceIsRecurring(secret, priceId, label) {
  const tag = label ? ` [${label}]` : '';
  if (!priceId || typeof priceId !== 'string' || !String(priceId).startsWith('price_')) {
    return { ok: false, error: `Invalid or missing Stripe price id${tag} (expected price_...).` };
  }
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/prices/${encodeURIComponent(String(priceId).trim())}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    const p = await res.json();
    if (p.error) {
      return {
        ok: false,
        error: `${p.error.message || 'Stripe price lookup failed'}${tag}. Check this price id exists in the same Stripe mode (test/live) as STRIPE_SECRET_KEY.`,
      };
    }
    if (p.type !== 'recurring') {
      return {
        ok: false,
        error:
          `Price ${priceId}${tag} is one-time (type=${p.type}). In Stripe → Products → open this tier → Pricing → add a **Subscription** price (monthly/yearly), copy its price_ id into the Worker env (e.g. STRIPE_PRICE_BASIC_MONTHLY).`,
      };
    }
    if (!p.recurring || !p.recurring.interval) {
      return {
        ok: false,
        error: `Price ${priceId}${tag} is missing recurring billing details. Recreate it as a standard subscription price in Stripe.`,
      };
    }
    if (p.active === false) {
      return {
        ok: false,
        error: `Price ${priceId}${tag} is archived/inactive. In Stripe activate the price or copy a new active recurring price_ id into the Worker.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'Price validation failed' };
  }
}

export async function handleCreateCheckoutSession(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }
  const secret = env.STRIPE_SECRET_KEY;
  const db = env.CONSENT_WEBAPP;
  const priceMonthly = env.STRIPE_PRICE_MONTHLY;
  const priceYearly = env.STRIPE_PRICE_YEARLY;


  if (!secret) {
    console.error('[CreateCheckout] STRIPE_SECRET_KEY not set');
    return Response.json({
      success: false,
      error: 'Stripe not configured. Set STRIPE_SECRET_KEY.',
    }, { status: 503 });
  }

  if (!db) {
    console.error('[CreateCheckout] CONSENT_WEBAPP DB binding not set');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    console.error('[CreateCheckout] invalid JSON body');
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const email = (user.email && typeof user.email === 'string') ? user.email.trim().toLowerCase() : null;
  if (!email || !email.includes('@')) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  // NOTE: there was an emailVerifiedAt gate here, blocking checkout until the address was
  // confirmed. It was removed deliberately:
  //
  //   1. Signup goes through an emailed code again, so every webapp account is proven at
  //      creation — the gate guarded a hole that no longer exists on that path.
  //   2. SyncPlugin.js and customeCheeckout.js (Webflow/Framer registration) never stamp
  //      emailVerifiedAt, so it would have blocked EVERY plugin-registered customer from
  //      upgrading, plus three real accounts that already existed unstamped.
  //
  // Only /api/auth/password-signup can still create an unproven account, and no UI calls
  // it. If that changes, re-add the gate — but stamp the plugin registration paths first,
  // or you will lock out Webflow and Framer users.

  /**
   * Do not pre-create / search Customers. Checkout Sessions accept `customer_email` alone;
   * Stripe creates (or links) the Customer when the user completes checkout. Pre-flight
   * Customer Search/Create was failing for some keys/accounts and surfaced as checkout errors.
   */

  const organizationId = (body.organizationId || '').trim();
  const planId = (body.planId && ['basic', 'essential', 'growth'].includes(body.planId)) ? body.planId : null;
  const rawPlanType = body.planType === 'quantity' ? 'quantity' : body.planType === 'bulk' ? 'bulk' : 'single';
  if (rawPlanType === 'bulk' || rawPlanType === 'quantity') {
    return Response.json(
      {
        success: false,
        error:
          'Bulk and quantity checkout are not available. Use a per-site plan: pass planId (basic, essential, or growth) with a site, or legacy single-site checkout without planId.',
      },
      { status: 400 },
    );
  }
  const planType = 'single';
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const quantity = 1;
  const siteId = (body.siteId && typeof body.siteId === 'string') ? body.siteId.trim() : null;
  const siteName = (body.siteName && typeof body.siteName === 'string') ? body.siteName.trim() : null;
  const siteDomain = (body.siteDomain && typeof body.siteDomain === 'string') ? body.siteDomain.trim() : null;
  const rawSuccessUrl = body.successUrl || `${request.url.replace(/\/api\/.*$/, '')}/pro-plan?success=true`;
  // Append Stripe's {CHECKOUT_SESSION_ID} template so the frontend receives the session ID on redirect
  const successUrl = rawSuccessUrl.includes('?')
    ? `${rawSuccessUrl}&session_id={CHECKOUT_SESSION_ID}`
    : `${rawSuccessUrl}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancelUrl || `${request.url.replace(/\/api\/.*$/, '')}/pro-plan?canceled=true`;
  const stripeCouponId = body.stripeCouponId && body.stripeCouponId.trim() ? body.stripeCouponId.trim() : null;
  const promotionCodeId = body.promotionCodeId && body.promotionCodeId.trim() ? body.promotionCodeId.trim() : null;
  // Customer-facing coupon string (e.g. "MEMORIAL25"). Resolved to a promo_xxx id below.
  const couponCode = body.couponCode && body.couponCode.trim() ? body.couponCode.trim() : null;

  if (!organizationId) {
    return Response.json({ success: false, error: 'organizationId required' }, { status: 400 });
  }

  // Tier plans: one Stripe subscription per checkout = one recurring `line_items[0].price` (selected plan + monthly|yearly).
  const tierPriceMap = {
    basic: {
      monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),
      yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY),
    },
    essential: {
      monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY),
      yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY),
    },
    growth: {
      monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),
      yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY),
    },
  };
  const tierEnvKey = (p, inv) =>
    `STRIPE_PRICE_${String(p).toUpperCase()}_${inv === 'yearly' ? 'YEARLY' : 'MONTHLY'}`;
  const useTierPlan = planId && tierPriceMap[planId];
  const tierPrice = useTierPlan ? (tierPriceMap[planId][interval] || tierPriceMap[planId].monthly) : null;

  if (useTierPlan) {
    if (!tierPrice) {
      return Response.json(
        {
          success: false,
          error: `Missing env ${tierEnvKey(planId, interval)} (plan=${planId}, interval=${interval}). Set it on the Worker to the recurring price_ id for that tier.`,
        },
        { status: 503 },
      );
    }
    const hasExisting = siteId && siteId.length > 0;
    const hasNewDetails = siteName && siteName.length > 0 && siteDomain && siteDomain.length > 0;
    if (!hasExisting && !hasNewDetails) {
      return Response.json({ success: false, error: 'Select an existing site or enter new site name and domain.' }, { status: 400 });
    }
    if (hasExisting && db) {
      const site = await db.prepare('SELECT id, organizationId, name, domain FROM Site WHERE id = ?1').bind(siteId).first();
      if (!site) {
        return Response.json({ success: false, error: 'Site not found' }, { status: 404 });
      }
      const siteOrgId = site.organizationId ?? site.organizationid;
      if (siteOrgId !== organizationId) {
        return Response.json({ success: false, error: 'Site does not belong to this organization' }, { status: 403 });
      }
    }

    const priceCheck = await validatePriceIsRecurring(
      secret,
      tierPrice,
      `plan=${planId} interval=${interval} env=${tierEnvKey(planId, interval)}`,
    );
    if (!priceCheck.ok) {
      return Response.json({ success: false, error: priceCheck.error }, { status: 400 });
    }
  }

  if (planType === 'single') {
    const hasExisting = siteId && siteId.length > 0;
    const hasNewDetails = siteName && siteName.length > 0 && siteDomain && siteDomain.length > 0;
    if (!hasExisting && !hasNewDetails) {
      return Response.json({ success: false, error: 'Select an existing site or enter new site name and domain.' }, { status: 400 });
    }
    if (hasExisting && hasNewDetails) {
      return Response.json({ success: false, error: 'Use either an existing site or new site details, not both.' }, { status: 400 });
    }
    if (db && hasExisting) {
      const site = await db.prepare('SELECT id, organizationId, name, domain FROM Site WHERE id = ?1').bind(siteId).first();
      if (!site) {
        return Response.json({ success: false, error: 'Site not found' }, { status: 404 });
      }
      const siteOrgId = site.organizationId ?? site.organizationid;
      if (siteOrgId !== organizationId) {
        return Response.json({ success: false, error: 'Site does not belong to this organization' }, { status: 403 });
      }
    }
    if (hasNewDetails) {
      if (siteName.length < 1 || siteName.length > 255) {
        return Response.json({ success: false, error: 'Site name must be 1–255 characters.' }, { status: 400 });
      }
      const domainNorm = siteDomain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
      if (domainNorm.length < 1 || domainNorm.length > 500) {
        return Response.json({ success: false, error: 'Enter a valid domain (e.g. example.com or https://example.com).' }, { status: 400 });
      }
    }
  }

  // A team Admin checking out for the owner's account: bill the owner's Stripe
  // customer (owner's billing email), and tag the session so the webhook gives the
  // Admin access to a site this creates. Owners take the unchanged path below.
  let customerEmail = email;
  let teamAdminUserId = null;
  if (db && organizationId) {
    const actor = await resolveBillingActor(db, user.id, organizationId, siteId || null);
    if (actor.admin) {
      if (siteId && planId === 'basic') {
        return Response.json({ success: false, error: "Only the account owner can move a site to Basic or Free. Team members lose access on those plans.", code: 'OWNER_ONLY' }, { status: 403 });
      }
      if (!actor.ownerEmail) {
        return Response.json({ success: false, error: 'Could not find the account owner\'s billing email.' }, { status: 409 });
      }
      customerEmail = actor.ownerEmail;
      teamAdminUserId = String(user.id);
    }
  }

  const params = new URLSearchParams();
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('client_reference_id', organizationId);
  params.set('customer_email', customerEmail);
  if (teamAdminUserId) {
    params.set('metadata[teamAdminUserId]', teamAdminUserId);
    params.set('subscription_data[metadata][teamAdminUserId]', teamAdminUserId);
  }
  params.set('billing_address_collection', 'auto');

  if (useTierPlan) {
    params.set('line_items[0][price]', tierPrice);
    params.set('line_items[0][quantity]', '1');
    params.set('mode', 'subscription');
    params.set('subscription_data[metadata][organizationId]', organizationId);
    params.set('subscription_data[metadata][planId]', planId);
    params.set('subscription_data[metadata][planType]', 'tier');
    params.set('subscription_data[metadata][interval]', interval);
    params.set('subscription_data[metadata][siteId]', siteId || '');
    if (siteName) params.set('subscription_data[metadata][siteName]', siteName);
    if (body.siteDomain && typeof body.siteDomain === 'string') {
      const domainNorm = String(body.siteDomain).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (domainNorm) params.set('subscription_data[metadata][siteDomain]', domainNorm);
    }
    // Only grant trial if this site has never used one before
    // Any subscription history — not just the trialUsed flag — rules out a trial, so a
    // returning customer renewing a cancelled/deleted subscription never gets a second one.
    const trialAlreadyUsed = siteId ? await isSiteTrialIneligible(db, { siteId }, env) : false;
    flowLog(env, 'trial', trialAlreadyUsed ? 'withheld' : 'granted', {
      path: 'hosted-checkout', siteId, organizationId, planId, interval,
    });
    if (!trialAlreadyUsed) {
      params.set('subscription_data[trial_period_days]', '14');
    }
  } else {
    params.set('line_items[0][price]', interval === 'yearly' ? priceYearly : priceMonthly);
    params.set('line_items[0][quantity]', String(quantity));
  }

  if (!useTierPlan) {
    // single (legacy)
    if (!priceMonthly || !priceYearly) {
      return Response.json({
        success: false,
        error: 'Stripe subscription prices not configured. Set STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY.',
      }, { status: 503 });
    }
    params.set('mode', 'subscription');
    params.set('subscription_data[metadata][organizationId]', organizationId);
    params.set('subscription_data[metadata][planType]', planType);
    params.set('subscription_data[metadata][quantity]', String(quantity));
    params.set('subscription_data[metadata][interval]', interval);
    params.set('subscription_data[metadata][siteId]', siteId || '');
    if (siteName) params.set('subscription_data[metadata][siteName]', siteName);
    if (body.siteDomain && typeof body.siteDomain === 'string') {
      const domainNorm = String(body.siteDomain).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (domainNorm) params.set('subscription_data[metadata][siteDomain]', domainNorm);
    }
  }

  if (stripeCouponId) {
    // Raw coupon ids bypass promotion-code checks — verify the account is allowed first.
    const rawOk = await isCouponIdAllowedForEmail(secret, stripeCouponId, customerEmail);
    if (!rawOk.allowed) {
      return Response.json({ success: false, error: rawOk.reason }, { status: 400 });
    }
    params.set('discounts[0][coupon]', stripeCouponId);
  }

  // ── Apply promotion code (optional) ──────────────────────────────────────
  // Re-validate server-side — never trust the client's claim.
  if (promotionCodeId) {
    try {
      const verifyRes = await fetch(
        `https://api.stripe.com/v1/promotion_codes/${encodeURIComponent(promotionCodeId)}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      const verify = await verifyRes.json();
      if (verify.error || !verify.active) {
        console.warn('[CreateCheckout] promotion code rejected', { id: promotionCodeId, err: verify.error?.message });
        return Response.json({ success: false, error: 'Promotion code is no longer valid' }, { status: 400 });
      }
      if (!isCodeAllowedForEmail(verify.code, customerEmail)) {
        console.warn('[CreateCheckout] promo restricted to another account', { code: verify.code, email });
        return Response.json({ success: false, error: PROMO_NOT_ALLOWED_MESSAGE }, { status: 400 });
      }
      params.set('discounts[0][promotion_code]', promotionCodeId);
      if (verify.code) params.set('subscription_data[metadata][promotionCode]', verify.code);
    } catch (e) {
      console.error('[CreateCheckout] promotion code verify failed', e?.message);
      return Response.json({ success: false, error: 'Promotion code validation failed' }, { status: 400 });
    }
  }

  // ── Apply customer-facing coupon code (optional) ─────────────────────────
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
        console.warn('[CreateCheckout] coupon restricted to another account', { code: promo.code || couponCode, email });
        return Response.json({ success: false, error: PROMO_NOT_ALLOWED_MESSAGE }, { status: 400 });
      }
      params.set('discounts[0][promotion_code]', promo.id);
      params.set('subscription_data[metadata][promotionCode]', promo.code || couponCode);
    } catch (e) {
      console.error('[CreateCheckout] coupon code resolution failed', e?.message);
      return Response.json({ success: false, error: 'Coupon validation failed' }, { status: 400 });
    }
  }

  // ── Stripe's own promo input is deliberately DISABLED ──────────────────────
  // Setting allow_promotion_codes=true renders Stripe's "Add promotion code" box on
  // the hosted checkout page. Codes typed there are applied by Stripe directly — this
  // worker never sees them, so the per-customer allowlist in services/promoRestrictions.js
  // cannot run. Stripe's own `promotion_code.customer` restriction can't cover for us
  // either: these sessions carry `customer_email` only (the Customer is created after
  // checkout completes), so there is no Customer for Stripe to match against.
  //
  // Net effect: leaving it on made every active code — including restricted ones —
  // redeemable by anyone who knew the string. Promo codes must therefore be entered in
  // our own coupon field, which validates them server-side before they reach Stripe.
  // Do not re-enable without first attaching a real `customer` to the session.

  // Final visibility into what we're sending to Stripe
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
    let msg = data.error.message || 'Stripe error';
    console.error('[CreateCheckout] Stripe error:', msg);
    if (typeof msg === 'string' && msg.toLowerCase().includes('recurring')) {
      msg +=
        ' The price id in Worker env for this plan must be a **Subscription (recurring)** price in Stripe (Products → tier → Pricing), not one-time. For Basic, set STRIPE_PRICE_BASIC_MONTHLY / STRIPE_PRICE_BASIC_YEARLY to those recurring price_ ids.';
    }
    return Response.json({ success: false, error: msg }, { status: 400 });
  }
  if (!data.id || !data.url) {
    console.error('[CreateCheckout] no session id/url in Stripe response');
    return Response.json({ success: false, error: 'No session URL returned' }, { status: 502 });
  }

  return Response.json({
    success: true,
    sessionId: data.id,
    url: data.url,
  });
}
