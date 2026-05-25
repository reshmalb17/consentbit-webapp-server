// Handles two endpoints for in-place card update (no portal redirect):
//
//   POST /api/billing/setup-intent
//     Body: { organizationId }
//     Returns: { success, clientSecret }
//
//   POST /api/billing/update-payment-method
//     Body: { organizationId, paymentMethodId }
//     Returns: { success, paymentMethod: { brand, last4, exp_month, exp_year } }

import {
  getSessionById,
  getUserById,
  getSubscriptionByOrganization,
  getOrganizationMember,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

async function requireSessionAuth(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return { ok: false, status: 503, body: { error: 'Database not available' } };
  const sid = getSessionIdFromCookie(request);
  if (!sid) return { ok: false, status: 401, body: { error: 'Login required' } };
  const session = await getSessionById(db, sid);
  if (!session) return { ok: false, status: 401, body: { error: 'Login required' } };
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) return { ok: false, status: 401, body: { error: 'Login required' } };
  return { ok: true, user, db };
}

async function requireOrgAccess(db, userId, organizationId) {
  if (!organizationId) return false;
  const member = await getOrganizationMember(db, userId, organizationId);
  return !!member;
}

export async function handleCreateSetupIntent(request, env) {
  console.log('[SetupIntent] POST /api/billing/setup-intent called');
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const auth = await requireSessionAuth(request, env);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });
  const { db } = auth;

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const organizationId = (body.organizationId || '').trim();
  if (!organizationId) return Response.json({ error: 'organizationId required' }, { status: 400 });

  const allowed = await requireOrgAccess(db, auth.user.id, organizationId);
  if (!allowed) return Response.json({ error: 'Not allowed for this organization' }, { status: 403 });

  if (!env.STRIPE_SECRET_KEY) return Response.json({ error: 'Stripe not configured' }, { status: 503 });

  const sub = await getSubscriptionByOrganization(db, organizationId);
  const stripeCustomerId = sub && (sub.stripeCustomerId ?? sub.stripecustomerid);
  if (!stripeCustomerId) return Response.json({ error: 'No Stripe customer found for this organization' }, { status: 404 });

  const makeIntent = async (customerId) => {
    const res = await fetch('https://api.stripe.com/v1/setup_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: customerId,
        'payment_method_types[]': 'card',
        usage: 'off_session',
      }).toString(),
    });
    return res.json();
  };

  let intent = await makeIntent(stripeCustomerId);

  // If customer was deleted in Stripe, try to recover by email
  if (!intent.client_secret && intent.error?.code === 'resource_missing') {
    console.warn('[SetupIntent] Stripe customer not found, attempting email recovery for org:', organizationId);
    const userEmail = auth.user.email;
    const searchRes = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(userEmail)}'&limit=1`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    const searchData = await searchRes.json();
    const recoveredId = searchData?.data?.[0]?.id || null;
    if (recoveredId) {
      await db.prepare('UPDATE Subscription SET stripeCustomerId = ?, updatedAt = ? WHERE stripeCustomerId = ?')
        .bind(recoveredId, new Date().toISOString(), stripeCustomerId).run().catch(() => {});
      intent = await makeIntent(recoveredId);
    }
  }

  if (!intent.client_secret) {
    console.error('[SetupIntent] failed to create:', intent.error?.message);
    return Response.json({ error: intent.error?.message || 'Failed to create setup intent' }, { status: 500 });
  }

  console.log('[SetupIntent] created for customer:', stripeCustomerId);
  return Response.json({ success: true, clientSecret: intent.client_secret });
}

export async function handleUpdatePaymentMethod(request, env) {
  console.log('[UpdatePM] POST /api/billing/update-payment-method called');
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const auth = await requireSessionAuth(request, env);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });
  const { db } = auth;

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const organizationId = (body.organizationId || '').trim();
  const paymentMethodId = (body.paymentMethodId || '').trim();

  if (!organizationId) return Response.json({ error: 'organizationId required' }, { status: 400 });
  if (!paymentMethodId || !paymentMethodId.startsWith('pm_')) {
    return Response.json({ error: 'Valid paymentMethodId required' }, { status: 400 });
  }

  const allowed = await requireOrgAccess(db, auth.user.id, organizationId);
  if (!allowed) return Response.json({ error: 'Not allowed for this organization' }, { status: 403 });

  if (!env.STRIPE_SECRET_KEY) return Response.json({ error: 'Stripe not configured' }, { status: 503 });

  const sub = await getSubscriptionByOrganization(db, organizationId);
  const stripeCustomerId = sub && (sub.stripeCustomerId ?? sub.stripecustomerid);
  const stripeSubscriptionId = sub && (sub.stripeSubscriptionId ?? sub.stripesubscriptionid);

  if (!stripeCustomerId) return Response.json({ error: 'No Stripe customer found for this organization' }, { status: 404 });

  const stripeHeaders = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // 1. Attach the new PM to the customer
  const attachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
    method: 'POST',
    headers: stripeHeaders,
    body: new URLSearchParams({ customer: stripeCustomerId }).toString(),
  });
  const attached = await attachRes.json();
  if (attached.error) {
    console.error('[UpdatePM] attach failed:', attached.error.message);
    return Response.json({ error: attached.error.message || 'Failed to attach payment method' }, { status: 400 });
  }

  // 2. Set as default on customer
  await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, {
    method: 'POST',
    headers: stripeHeaders,
    body: new URLSearchParams({ 'invoice_settings[default_payment_method]': paymentMethodId }).toString(),
  });

  // 3. Set as default on subscription
  if (stripeSubscriptionId) {
    await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
      method: 'POST',
      headers: stripeHeaders,
      body: new URLSearchParams({ default_payment_method: paymentMethodId }).toString(),
    });
  }

  const card = attached.card || {};
  console.log('[UpdatePM] payment method updated for customer:', stripeCustomerId, '| last4:', card.last4);
  return Response.json({
    success: true,
    paymentMethod: {
      brand: card.brand || 'card',
      last4: card.last4 || '',
      exp_month: card.exp_month || null,
      exp_year: card.exp_year || null,
    },
  });
}
