// POST /api/subscriptions/switch-interval
// Switches an existing subscription between monthly and yearly billing in-place.
// Uses Stripe subscription update with proration — no checkout redirect needed.
//
// Body: { organizationId, targetInterval: 'monthly' | 'yearly' }
// Returns: { success, interval, nextBillingDate }

import {
  getSessionById,
  getUserById,
  getSubscriptionByOrganization,
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

export async function handleSwitchBillingInterval(request, env) {
  console.log('[SwitchInterval] POST /api/subscriptions/switch-interval called');
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  if (!env.STRIPE_SECRET_KEY) return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });

  // Auth
  const sid = getSessionIdFromCookie(request);
  if (!sid) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const session = await getSessionById(db, sid);
  if (!session) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const organizationId = (body.organizationId || '').trim();
  const targetInterval = body.targetInterval === 'yearly' ? 'yearly' : body.targetInterval === 'monthly' ? 'monthly' : null;

  if (!organizationId) return Response.json({ success: false, error: 'organizationId required' }, { status: 400 });
  if (!targetInterval) return Response.json({ success: false, error: 'targetInterval must be monthly or yearly' }, { status: 400 });

  const member = await getOrganizationMember(db, userId, organizationId);
  if (!member) return Response.json({ success: false, error: 'Not allowed for this organization' }, { status: 403 });

  // Load current subscription
  const sub = await getSubscriptionByOrganization(db, organizationId);
  if (!sub) return Response.json({ success: false, error: 'No active subscription found' }, { status: 404 });

  const stripeSubId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid;
  const currentInterval = (sub.interval ?? 'monthly').toLowerCase();
  const planId = String(sub.planId ?? sub.planid ?? '').toLowerCase();

  if (!stripeSubId) return Response.json({ success: false, error: 'Subscription has no Stripe ID' }, { status: 400 });
  if (currentInterval === targetInterval) {
    return Response.json({ success: false, error: `Already on ${targetInterval} billing` }, { status: 400 });
  }
  if (!['basic', 'essential', 'growth'].includes(planId)) {
    return Response.json({ success: false, error: 'Cannot switch interval for this plan type' }, { status: 400 });
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
    return Response.json(
      { success: false, error: `Price not configured for ${planId} ${targetInterval}` },
      { status: 503 }
    );
  }

  // Fetch current subscription from Stripe to get the subscription item ID
  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const stripeSub = await subRes.json();
  if (stripeSub.error) {
    console.error('[SwitchInterval] Stripe fetch sub failed:', stripeSub.error.message);
    return Response.json({ success: false, error: stripeSub.error.message || 'Failed to read subscription' }, { status: 400 });
  }

  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) {
    return Response.json({ success: false, error: 'Could not read subscription item ID' }, { status: 500 });
  }

  // Update the subscription in Stripe: swap the price, prorate the difference
  const updateParams = new URLSearchParams({
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: 'create_prorations',
  });
  // When switching to yearly, anchor the billing cycle now so prorations are settled immediately
  if (targetInterval === 'yearly') {
    updateParams.set('billing_cycle_anchor', 'now');
  }

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
    return Response.json({ success: false, error: updated.error.message || 'Failed to switch billing interval' }, { status: 400 });
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
      ? await db.prepare('SELECT domain, legacySource FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: user.email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: sub.stripeCustomerId ?? sub.stripecustomerid,
      status: sub.status ?? 'active',
      cancelAtPeriodEnd: !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend),
      platform: siteRow?.legacySource || null,
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
