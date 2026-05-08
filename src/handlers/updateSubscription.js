// POST /api/subscriptions/upgrade
// Upgrade or downgrade: cancel the existing subscription for a site, then create
// a new Stripe Checkout Session for the new plan.
// The old subscription is cancelled only after the new checkout completes
// (via stripeWebhook.js reading oldStripeSubscriptionId from session metadata).
//
// Body: { siteId, organizationId, planId: 'basic'|'essential'|'growth', interval: 'monthly'|'yearly', successUrl?, cancelUrl? }
// Returns: { success, url, sessionId }

import { getSessionById, getUserById, getSubscriptionBySiteId, getSiteTrialUsed } from '../services/db.js';

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

  if (!secret) return Response.json({ success: false, error: 'Stripe not configured.' }, { status: 503 });
  if (!db) return Response.json({ success: false, error: 'Database not available.' }, { status: 503 });

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
  const rawSuccessUrl = body.successUrl || `${request.url.replace(/\/api\/.*$/, '')}/dashboard`;
  const successUrl = rawSuccessUrl.includes('?')
    ? `${rawSuccessUrl}&session_id={CHECKOUT_SESSION_ID}`
    : `${rawSuccessUrl}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancelUrl || `${request.url.replace(/\/api\/.*$/, '')}/dashboard`;

  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });
  if (!organizationId) return Response.json({ success: false, error: 'organizationId required' }, { status: 400 });
  if (!planId) return Response.json({ success: false, error: 'planId must be basic, essential, or growth' }, { status: 400 });

  // Resolve the new Stripe price id
  const tierPriceMap = {
    basic:     { monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
  const newPriceId = tierPriceMap[planId][interval] || tierPriceMap[planId].monthly;
  if (!newPriceId) {
    return Response.json(
      { success: false, error: `Missing env STRIPE_PRICE_${planId.toUpperCase()}_${interval.toUpperCase()}.` },
      { status: 503 },
    );
  }

  const priceCheck = await validatePriceIsRecurring(secret, newPriceId);
  if (!priceCheck.ok) {
    return Response.json({ success: false, error: priceCheck.error }, { status: 400 });
  }

  // Find existing active subscription for this site (may be null for free tier)
  const existingSub = await getSubscriptionBySiteId(db, siteId);
  const oldStripeSubscriptionId = existingSub
    ? (existingSub.stripeSubscriptionId ?? existingSub.stripesubscriptionid ?? null)
    : null;


  // Build Stripe Checkout Session — subscription mode with new plan
  const params = new URLSearchParams();
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('client_reference_id', organizationId);
  params.set('customer_email', email);
  params.set('billing_address_collection', 'auto');
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', newPriceId);
  params.set('line_items[0][quantity]', '1');
  params.set('subscription_data[metadata][organizationId]', organizationId);
  params.set('subscription_data[metadata][planId]', planId);
  params.set('subscription_data[metadata][planType]', 'tier');
  params.set('subscription_data[metadata][interval]', interval);
  params.set('subscription_data[metadata][siteId]', siteId);
  // Pass old subscription id so the webhook can cancel it after payment succeeds
  if (oldStripeSubscriptionId) {
    params.set('subscription_data[metadata][oldStripeSubscriptionId]', oldStripeSubscriptionId);
  }
  // Only give free trial if: no existing paid subscription AND trial has never been used before
  const trialAlreadyUsed = await getSiteTrialUsed(db, siteId);
  if (!oldStripeSubscriptionId && !trialAlreadyUsed) {
    params.set('subscription_data[trial_period_days]', '14');
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
    return Response.json({ success: false, error: 'No session URL returned from Stripe' }, { status: 502 });
  }

  return Response.json({ success: true, sessionId: data.id, url: data.url });
}
