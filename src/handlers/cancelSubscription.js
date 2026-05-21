// POST /api/subscriptions/cancel
// Body: { stripeSubscriptionId } or { subscriptionId } — subscription ID is required.
// For quantity plan downgrade: also pass { licenseKey } to remove one license.
// Sets cancel_at_period_end on Stripe so the plan continues until the subscription date ends.
// Updates DB with cancelAtPeriodEnd.

import { getSessionById, getUserById, getSubscriptionByStripeId, getSubscriptionById, saveSubscription, getSiteById, getSiteByDomain } from '../services/db.js';
import { syncSubscriptionUpdateToLegacy } from '../services/syncLegacy.js';
import { sendCancellationEmail } from '../services/email.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function getLicenseKeysFromRow(row) {
  let raw = row?.licensekeys ?? row?.licenseKeys ?? row?.license_keys ?? null;
  if (!raw) {
    const k = Object.keys(row || {}).find((key) => key.toLowerCase() === 'licensekeys');
    if (k) raw = row[k];
  }
  if (!raw) return [];
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch (_) {
    return [];
  }
}

export async function handleCancelSubscription(request, env, ctx) {
  console.log('[CancelSubscription] POST /api/subscriptions/cancel called');
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
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

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const stripeSubscriptionId = (body.stripeSubscriptionId || body.stripe_subscription_id || '').trim() || null;
  const subscriptionId = (body.subscriptionId || body.subscription_id || '').trim() || null;
  const licenseKey = (body.licenseKey || '').trim() || null;
  console.log('[CancelSubscription] stripeSubId:', stripeSubscriptionId, '| subscriptionId:', subscriptionId, '| licenseKey:', licenseKey);

  if (!env.STRIPE_SECRET_KEY) {
    console.error('[CancelSubscription] STRIPE_SECRET_KEY not set');
    return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });
  }

  // Find subscription by stripeSubscriptionId or our internal subscriptionId
  let sub = null;
  if (stripeSubscriptionId) {
    sub = await getSubscriptionByStripeId(db, stripeSubscriptionId);
  }
  if (!sub && subscriptionId) {
    sub = await getSubscriptionById(db, subscriptionId);
  }
  if (!sub) {
    console.warn('[CancelSubscription] no subscription found for stripeSubId:', stripeSubscriptionId, '| subscriptionId:', subscriptionId);
    return Response.json({ success: false, error: 'No active subscription found for this account.' }, { status: 400 });
  }
  console.log('[CancelSubscription] sub found — planType:', sub.planType ?? sub.plantype, '| status:', sub.status, '| stripeSubId:', sub.stripeSubscriptionId ?? sub.stripesubscriptionid);

  const subStripeId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null;
  if (!subStripeId) {
    return Response.json({ success: false, error: 'Subscription has no Stripe ID' }, { status: 400 });
  }

  const planType = String(sub.planType ?? sub.plantype ?? 'single').toLowerCase();

  if (planType === 'quantity') {
    const keys = getLicenseKeysFromRow(sub);
    const qty = sub.quantity ?? sub.Quantity ?? keys.length;

    // If licenseKey provided: downgrade one license. Otherwise: cancel entire subscription.
    if (licenseKey && keys.includes(licenseKey)) {
      const newKeys = keys.filter((k) => k !== licenseKey);
      const newQty = Math.max(0, qty - 1);

      if (newQty === 0) {
        const params = new URLSearchParams();
        params.set('cancel_at_period_end', 'true');
        const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        const data = await res.json();
        if (data.error) {
          console.error('[CancelSubscription] Stripe error:', data.error);
          return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
        }
      } else {
        const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        }).then((r) => r.json());
        const itemId = subRes.items?.data?.[0]?.id;
        if (!itemId) {
          return Response.json({ success: false, error: 'Could not get subscription item' }, { status: 502 });
        }
        const params = new URLSearchParams();
        params.set('items[0][id]', itemId);
        params.set('items[0][quantity]', String(newQty));
        params.set('proration_behavior', 'create_prorations');
        const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        const data = await res.json();
        if (data.error) {
          console.error('[CancelSubscription] Stripe quantity update error:', data.error);
          return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
        }
      }

      let cancelledRaw = sub.cancelledLicenseKeys ?? sub.cancelledlicensekeys ?? null;
      if (!cancelledRaw) {
        const k = Object.keys(sub || {}).find((key) => key.toLowerCase() === 'cancelledlicensekeys');
        if (k) cancelledRaw = sub[k];
      }
      let cancelled = [];
      try {
        cancelled = cancelledRaw ? (typeof cancelledRaw === 'string' ? JSON.parse(cancelledRaw) : cancelledRaw) : [];
      } catch (_) {}
      if (!Array.isArray(cancelled)) cancelled = [];
      cancelled.push(licenseKey);

      await saveSubscription(db, {
        id: sub.id,
        organizationId: sub.organizationId ?? sub.organizationid,
        stripeSubscriptionId: subStripeId,
        stripeCustomerId: sub.stripeCustomerId ?? sub.stripecustomerid,
        stripePriceId: sub.stripePriceId ?? sub.stripepriceid,
        planType: 'quantity',
        interval: sub.interval ?? 'monthly',
        status: sub.status ?? 'active',
        currentPeriodStart: sub.currentPeriodStart ?? sub.currentperiodstart,
        currentPeriodEnd: sub.currentPeriodEnd ?? sub.currentperiodend,
        cancelAtPeriodEnd: newQty === 0 ? 1 : (sub.cancelAtPeriodEnd ?? sub.cancelatperiodend ? 1 : 0),
        licenseKeys: newKeys,
        cancelledLicenseKeys: cancelled,
        quantity: newQty,
      });

      return Response.json({
        success: true,
        message: 'License downgraded. It remains valid until the end of the current billing period. Your next renewal will be at a prorated amount.',
      });
    }

    // No licenseKey or not in subscription: cancel entire quantity subscription at period end
    const params = new URLSearchParams();
    params.set('cancel_at_period_end', 'true');
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[CancelSubscription] Stripe error:', data.error);
      return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
    }
    await saveSubscription(db, {
      id: sub.id,
      organizationId: sub.organizationId ?? sub.organizationid,
      stripeSubscriptionId: subStripeId,
      stripeCustomerId: sub.stripeCustomerId ?? sub.stripecustomerid,
      stripePriceId: sub.stripePriceId ?? sub.stripepriceid,
      planType: 'quantity',
      interval: sub.interval ?? 'monthly',
      status: sub.status ?? 'active',
      currentPeriodStart: sub.currentPeriodStart ?? sub.currentperiodstart,
      currentPeriodEnd: sub.currentPeriodEnd ?? sub.currentperiodend,
      cancelAtPeriodEnd: 1,
      licenseKeys: sub.licenseKeys ?? sub.licensekeys,
      quantity: sub.quantity ?? sub.Quantity,
    });
    return Response.json({
      success: true,
      message: 'Subscription will be cancelled at the end of the current billing period. Your plan continues until then.',
    });
  }

  // Single or bulk: cancel at period end
  const params = new URLSearchParams();
  params.set('cancel_at_period_end', 'true');

  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subStripeId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();

  if (data.error) {
    console.error('[CancelSubscription] Stripe error:', data.error);
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
  }

  // Update DB immediately (webhook will also update, but this ensures we don't wait)
  await saveSubscription(db, {
    id: sub.id,
    organizationId: sub.organizationId ?? sub.organizationid,
    siteId: sub.siteId ?? sub.siteid,
    stripeSubscriptionId: subStripeId,
    stripeCustomerId: sub.stripeCustomerId ?? sub.stripecustomerid,
    stripePriceId: sub.stripePriceId ?? sub.stripepriceid,
    planType,
    interval: sub.interval ?? 'monthly',
    status: 'active',
    currentPeriodStart: sub.currentPeriodStart ?? sub.currentperiodstart,
    currentPeriodEnd: sub.currentPeriodEnd ?? sub.currentperiodend,
    cancelAtPeriodEnd: 1,
    licenseKey: sub.licenseKey ?? sub.licensekey,
    licenseKeys: sub.licenseKeys ?? sub.licensekeys,
    quantity: sub.quantity ?? sub.Quantity,
  });

  // Outbound sync → LEGACY_DB + KV (fire-and-forget, must not block response)
  try {
    const siteId = sub.siteId ?? sub.siteid;
    const site = siteId ? await getSiteById(db, siteId) : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: user?.email || null,
      domain: site?.domain || null,
      subscriptionId: subStripeId,
      customerId: sub.stripeCustomerId ?? sub.stripecustomerid,
      status: 'active',
      cancelAtPeriodEnd: true,
      platform: site?.legacySource || null,
      interval: sub.interval ?? 'monthly',
    });
  } catch (syncErr) {
    console.warn('[CancelSubscription] Legacy sync failed (non-critical):', syncErr?.message);
  }

  console.log('[CancelSubscription] cancel_at_period_end set — stripeSubId:', subStripeId);
  sendCancellationEmail(env, ctx, { to: user.email, name: user.name || '' });
  return Response.json({
    success: true,
    message: 'Subscription will be cancelled at the end of the current billing period. Your plan continues until then.',
  });
}
