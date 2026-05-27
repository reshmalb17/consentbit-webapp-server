// src/handlers/adminBackfillStripeSubscriptions.js
// One-time backfill: fetches ALL subscriptions from Stripe and upserts them into D1.
// Safe to run multiple times — uses upsert so existing records are updated, not duplicated.
//
// POST /api/admin/backfill-stripe-subscriptions
// Headers: X-Admin-Key: <ADMIN_SECRET>
// Query params:
//   ?dryRun=true   — count only, no writes
//   ?limit=100     — max subscriptions to process (default: all)

import { checkAdminAuth } from '../utils/adminAuth.js';
import {
  ensureSchema,
  saveSubscription,
  inferTierPlanIdFromStripePriceId,
} from '../services/db.js';

function toTimestamp(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
  return ts;
}

async function fetchAllStripeSubscriptions(stripeKey, limitOverride) {
  const subs = [];
  let startingAfter = null;
  let pageCount = 0;

  while (true) {
    const params = new URLSearchParams();
    params.set('status', 'all');
    params.set('limit', '100');
    params.set('expand[]', 'data.items.data.price');
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetch(`https://api.stripe.com/v1/subscriptions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    const page = await res.json();

    if (!page.data || page.error) {
      throw new Error(page.error?.message || 'Stripe API error');
    }

    subs.push(...page.data);
    pageCount++;

    if (!page.has_more) break;
    if (limitOverride && subs.length >= limitOverride) break;

    startingAfter = page.data[page.data.length - 1].id;
  }

  return subs;
}

export async function handleAdminBackfillStripeSubscriptions(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 503 });
  }

  if (!env.CONSENT_WEBAPP) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP D1 not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const limitOverride = parseInt(url.searchParams.get('limit') || '0', 10) || null;

  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);

  let allSubs;
  try {
    allSubs = await fetchAllStripeSubscriptions(env.STRIPE_SECRET_KEY, limitOverride);
  } catch (err) {
    return Response.json({ success: false, error: `Stripe fetch failed: ${err.message}` }, { status: 502 });
  }

  if (dryRun) {
    return Response.json({
      success: true,
      dryRun: true,
      totalFound: allSubs.length,
      message: `Would upsert ${allSubs.length} subscriptions. Run without ?dryRun=true to execute.`,
    });
  }

  let upserted = 0;
  let skipped = 0;
  const errors = [];

  for (const sub of allSubs) {
    try {
      const priceId = sub.items?.data?.[0]?.price?.id ?? null;
      const planId = inferTierPlanIdFromStripePriceId(env, priceId);
      const intervalRaw = sub.items?.data?.[0]?.plan?.interval;
      const interval = intervalRaw === 'year' ? 'yearly' : 'monthly';

      const status =
        sub.status === 'canceled' || sub.status === 'unpaid'
          ? sub.status
          : sub.status === 'trialing'
          ? 'trialing'
          : 'active';

      const canceledAt =
        sub.canceled_at
          ? toTimestamp(sub.canceled_at)
          : status === 'canceled'
          ? new Date().toISOString()
          : null;

      const meta = sub.metadata || {};
      const orgId = meta.organizationId || null;
      const siteId = meta.siteId ? String(meta.siteId).trim() : null;
      const planType =
        planId && ['basic', 'essential', 'growth'].includes(String(planId))
          ? 'tier'
          : meta.planType || 'single';

      if (!orgId) {
        skipped++;
        continue; // Can't upsert without organizationId — not a webapp subscription
      }

      await saveSubscription(db, {
        organizationId: orgId,
        siteId: siteId || null,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: sub.customer,
        stripePriceId: priceId,
        planType,
        planId: planId || null,
        interval,
        status,
        currentPeriodStart: toTimestamp(sub.current_period_start),
        currentPeriodEnd: toTimestamp(sub.current_period_end),
        cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0,
        canceledAt,
        amountCents: sub.plan?.amount ?? null,
      });

      upserted++;
    } catch (err) {
      errors.push({ subId: sub.id, error: err.message });
    }
  }

  return Response.json({
    success: true,
    totalFound: allSubs.length,
    upserted,
    skipped,
    skippedReason: skipped > 0 ? 'No organizationId in Stripe metadata (legacy/external subscriptions)' : null,
    errors: errors.length > 0 ? errors : null,
    message: `Backfill complete. ${upserted} upserted, ${skipped} skipped, ${errors.length} errors.`,
  });
}
