// POST /api/create-checkout-session
// Requires logged-in user (session cookie sid). No guest checkout.
// Body: { organizationId, planType: 'single'|'bulk', interval, quantity?, siteId?, siteName?, siteDomain?, stripeCouponId?, successUrl, cancelUrl }
// Single: siteId (existing site) or siteName+siteDomain (new site). Bulk: quantity.
// Creates or finds Stripe customer by login email and attaches to checkout session.
// Returns { success, sessionId, url }

import { getSessionById, getUserById, generateTempLicenseKeys } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/** Find existing Stripe customer by email, or create one. */
async function findOrCreateStripeCustomerByEmail(env, email) {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret || !email || !email.includes('@')) return null;
  const normalized = email.trim().toLowerCase();
  try {
    const query = encodeURIComponent(`email:'${normalized}'`);
    const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=${query}&limit=1`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const searchData = await searchRes.json();
    if (searchData.data && searchData.data.length > 0 && searchData.data[0].id) {
      return searchData.data[0].id;
    }
    const createParams = new URLSearchParams();
    createParams.set('email', normalized);
    const createRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: createParams.toString(),
    });
    const createData = await createRes.json();
    if (createData.id) return createData.id;
    return null;
  } catch (e) {
    console.warn('[CreateCheckoutSession] findOrCreateStripeCustomerByEmail failed', e.message);
    return null;
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
  const oneTimePriceMonthly = env.STRIPE_ONE_TIME_PRICE_MONTHLY || 'price_1SpSusJwcuG9163MHGK38FfW';
  const oneTimePriceYearly = env.STRIPE_ONE_TIME_PRICE_YEARLY || 'price_1SpSw0JwcuG9163MLkRgIPmD';

  if (!secret) {
    return Response.json({
      success: false,
      error: 'Stripe not configured. Set STRIPE_SECRET_KEY.',
    }, { status: 503 });
  }

  if (!db) {
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
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

  const stripeCustomerId = await findOrCreateStripeCustomerByEmail(env, email);
  if (!stripeCustomerId) {
    return Response.json({ success: false, error: 'Could not create Stripe customer' }, { status: 503 });
  }

  const organizationId = (body.organizationId || '').trim();
  const planId = (body.planId && ['basic', 'essential', 'growth'].includes(body.planId)) ? body.planId : null;
  const planType = body.planType === 'quantity' ? 'quantity' : body.planType === 'bulk' ? 'bulk' : 'single';
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const quantity = planType === 'bulk'
    ? Math.max(2, Math.min(1000, parseInt(body.quantity, 10) || 2))
    : planType === 'quantity'
      ? Math.max(10, Math.min(100, parseInt(body.quantity, 10) || 10))
      : 1;
  const siteId = (body.siteId && typeof body.siteId === 'string') ? body.siteId.trim() : null;
  const siteName = (body.siteName && typeof body.siteName === 'string') ? body.siteName.trim() : null;
  const siteDomain = (body.siteDomain && typeof body.siteDomain === 'string') ? body.siteDomain.trim() : null;
  const successUrl = body.successUrl || `${request.url.replace(/\/api\/.*$/, '')}/pro-plan?success=true`;
  const cancelUrl = body.cancelUrl || `${request.url.replace(/\/api\/.*$/, '')}/pro-plan?canceled=true`;
  const stripeCouponId = body.stripeCouponId && body.stripeCouponId.trim() ? body.stripeCouponId.trim() : null;

  console.log('[CREATE CHECK OUT SESSION]:', organizationId, planType, interval, quantity, siteId, successUrl, stripeCouponId, email);

  if (!organizationId) {
    return Response.json({ success: false, error: 'organizationId required' }, { status: 400 });
  }

  // Tier plans (Basic/Essential/Growth): subscription with 14-day trial and tier price
  const tierPriceMap = {
    basic: { monthly: env.STRIPE_PRICE_BASIC_MONTHLY, yearly: env.STRIPE_PRICE_BASIC_YEARLY },
    essential: { monthly: env.STRIPE_PRICE_ESSENTIAL_MONTHLY, yearly: env.STRIPE_PRICE_ESSENTIAL_YEARLY },
    growth: { monthly: env.STRIPE_PRICE_GROWTH_MONTHLY, yearly: env.STRIPE_PRICE_GROWTH_YEARLY },
  };
  const useTierPlan = planId && tierPriceMap[planId];
  const tierPrice = useTierPlan ? (tierPriceMap[planId][interval] || tierPriceMap[planId].monthly) : null;

  if (useTierPlan) {
    if (!tierPrice) {
      return Response.json({ success: false, error: `Stripe price not configured for plan ${planId} (${interval}).` }, { status: 503 });
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
  }

  if (planType === 'quantity') {
    const validQty = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    if (!validQty.includes(quantity)) {
      return Response.json({ success: false, error: 'Quantity must be 10, 20, 30, 40, 50, 60, 70, 80, 90, or 100.' }, { status: 400 });
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
  params.set('customer', stripeCustomerId);

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
    params.set('subscription_data[trial_period_days]', '14');
  } else {
    params.set('line_items[0][price]', planType === 'bulk'
      ? (interval === 'yearly' ? oneTimePriceYearly : oneTimePriceMonthly)
      : (interval === 'yearly' ? priceYearly : priceMonthly));
    params.set('line_items[0][quantity]', String(quantity));
  }

  if (planType === 'quantity' && !useTierPlan) {
    if (!priceMonthly || !priceYearly) {
      return Response.json({
        success: false,
        error: 'Stripe subscription prices not configured. Set STRIPE_PRICE_MONTHLY, STRIPE_PRICE_YEARLY.',
      }, { status: 503 });
    }
    params.set('mode', 'subscription');
    params.set('subscription_data[metadata][organizationId]', organizationId);
    params.set('subscription_data[metadata][planType]', 'quantity');
    params.set('subscription_data[metadata][quantity]', String(quantity));
    params.set('subscription_data[metadata][interval]', interval);
  } else if (planType === 'bulk') {
    if (!oneTimePriceMonthly || !oneTimePriceYearly) {
      return Response.json({
        success: false,
        error: 'Bulk one-time prices not configured. Set STRIPE_ONE_TIME_PRICE_MONTHLY and STRIPE_ONE_TIME_PRICE_YEARLY.',
      }, { status: 503 });
    }
    const tempLicenseKeys = generateTempLicenseKeys(quantity);
    params.set('mode', 'payment');
    params.set('metadata[organizationId]', organizationId);
    params.set('metadata[planType]', 'bulk');
    params.set('metadata[quantity]', String(quantity));
    params.set('metadata[interval]', interval);
    params.set('metadata[tempLicenseKeys]', tempLicenseKeys.join(','));
    params.set('payment_intent_data[metadata][organizationId]', organizationId);
    params.set('payment_intent_data[metadata][planType]', 'bulk');
    params.set('payment_intent_data[metadata][quantity]', String(quantity));
    params.set('payment_intent_data[metadata][interval]', interval);
    params.set('payment_intent_data[metadata][tempLicenseKeys]', tempLicenseKeys.join(','));
    params.set('payment_intent_data[metadata][email]', email);
    params.set('payment_intent_data[setup_future_usage]', 'off_session');
  } else if (!useTierPlan) {
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
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 400 });
  }
  if (!data.id || !data.url) {
    return Response.json({ success: false, error: 'No session URL returned' }, { status: 502 });
  }

  return Response.json({
    success: true,
    sessionId: data.id,
    url: data.url,
  });
}
