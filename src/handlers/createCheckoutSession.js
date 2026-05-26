// POST /api/create-checkout-session
// Requires logged-in user (session cookie sid). No guest checkout.
// Body: { organizationId, planId?: 'basic'|'essential'|'growth', interval, siteId?, siteName?, siteDomain?, stripeCouponId?, successUrl, cancelUrl }
// Per-site only: tier subscription (planId) or legacy single-site subscription. Bulk / multi-seat quantity checkout is not enabled.
// Checkout uses `customer_email` from the logged-in user; Stripe creates the Customer on completion.
// Returns { success, sessionId, url }

import { getSessionById, getUserById, getSiteTrialUsed } from '../services/db.js';

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
  console.log('[CreateCheckout] POST /api/create-checkout-session called');
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }
  const secret = env.STRIPE_SECRET_KEY;
  const db = env.CONSENT_WEBAPP;
  const priceMonthly = env.STRIPE_PRICE_MONTHLY;
  const priceYearly = env.STRIPE_PRICE_YEARLY;

  console.log('[CreateCheckout] Stripe key mode:', secret ? (secret.startsWith('sk_live') ? 'LIVE' : 'TEST') : 'NOT SET');

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

  /**
   * Do not pre-create / search Customers. Checkout Sessions accept `customer_email` alone;
   * Stripe creates (or links) the Customer when the user completes checkout. Pre-flight
   * Customer Search/Create was failing for some keys/accounts and surfaced as checkout errors.
   */

  const organizationId = (body.organizationId || '').trim();
  const planId = (body.planId && ['basic', 'essential', 'growth'].includes(body.planId)) ? body.planId : null;
  console.log('[CreateCheckout] body — orgId:', organizationId, '| planId:', planId, '| interval:', body.interval, '| siteId:', body.siteId);
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

  const params = new URLSearchParams();
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('client_reference_id', organizationId);
  params.set('customer_email', email);
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
    const trialAlreadyUsed = siteId ? await getSiteTrialUsed(db, siteId) : false;
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
      params.set('discounts[0][promotion_code]', promotionCodeId);
      if (verify.code) params.set('subscription_data[metadata][promotionCode]', verify.code);
    } catch (e) {
      console.error('[CreateCheckout] promotion code verify failed', e?.message);
      return Response.json({ success: false, error: 'Promotion code validation failed' }, { status: 400 });
    }
  }

  // ── Apply customer-facing coupon code (optional) ─────────────────────────
  console.log('[CreateCheckout] coupon inputs', {
    couponCode,
    promotionCodeId,
    stripeCouponId,
    bodyKeys: Object.keys(body || {}),
  });
  if (couponCode && !promotionCodeId) {
    try {
      const listParams = new URLSearchParams({ code: couponCode, active: 'true', limit: '1' });
      const lookupRes = await fetch(
        `https://api.stripe.com/v1/promotion_codes?${listParams.toString()}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      const lookupData = await lookupRes.json();
      console.log('[CreateCheckout] coupon code lookup result', {
        httpStatus: lookupRes.status,
        found: lookupData?.data?.length || 0,
        firstId: lookupData?.data?.[0]?.id,
        firstActive: lookupData?.data?.[0]?.active,
        error: lookupData?.error?.message,
      });
      if (lookupData?.error) {
        return Response.json({ success: false, error: lookupData.error.message || 'Coupon lookup failed' }, { status: 400 });
      }
      const promo = lookupData?.data?.[0];
      if (!promo || !promo.active) {
        return Response.json({ success: false, error: 'Invalid or expired coupon code' }, { status: 400 });
      }
      params.set('discounts[0][promotion_code]', promo.id);
      params.set('subscription_data[metadata][promotionCode]', promo.code || couponCode);
      console.log('[CreateCheckout] coupon attached to session', { promoId: promo.id, code: promo.code });
    } catch (e) {
      console.error('[CreateCheckout] coupon code resolution failed', e?.message);
      return Response.json({ success: false, error: 'Coupon validation failed' }, { status: 400 });
    }
  }

  // ── Allow customers to enter a promo code directly on Stripe Checkout ──
  // Mutually exclusive with pre-applied discounts[] — Stripe rejects sessions
  // that set both. So only enable the input field when no discount was attached.
  if (!params.has('discounts[0][promotion_code]') && !params.has('discounts[0][coupon]')) {
    params.set('allow_promotion_codes', 'true');
  }

  // Final visibility into what we're sending to Stripe
  if (params.has('discounts[0][promotion_code]') || params.has('discounts[0][coupon]')) {
    console.log('[CreateCheckout] discount params being sent to Stripe', {
      'discounts[0][promotion_code]': params.get('discounts[0][promotion_code]'),
      'discounts[0][coupon]': params.get('discounts[0][coupon]'),
      mode: params.get('mode'),
      hasTrial: params.has('subscription_data[trial_period_days]'),
    });
  } else {
    console.log('[CreateCheckout] no discount being applied to Stripe session (allow_promotion_codes=true)');
  }

  console.log('[CreateCheckout] creating Stripe checkout session — plan:', planId || 'legacy', '| interval:', body.interval === 'yearly' ? 'yearly' : 'monthly');
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

  console.log('[CreateCheckout] session created:', data.id);
  return Response.json({
    success: true,
    sessionId: data.id,
    url: data.url,
  });
}
