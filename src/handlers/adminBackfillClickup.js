// src/handlers/adminBackfillClickup.js
// One-time backfill: creates ClickUp tasks for Stripe subscriptions that were missed
// because the ClickUp integration was not yet live when they were created.
//
// POST /api/admin/backfill-clickup
// Headers: X-Admin-Key: <ADMIN_SECRET>
// Query params:
//   ?since=2026-05-01   — ISO date lower bound (default: 2026-05-01)
//   ?until=2026-06-04   — ISO date upper bound (default: today)
//   ?platform=webflow   — filter to one platform: webflow | framer | all (default: all)
//   ?dryRun=true        — list matched subscriptions without calling ClickUp

import { checkAdminAuth } from '../utils/adminAuth.js';
import { addCustomerToClickUp } from '../services/clickup.js';

async function fetchSubscriptionPage(stripeKey, createdGte, createdLte, startingAfter) {
  const params = new URLSearchParams();
  params.set('status', 'all');
  params.set('limit', '100');
  params.set('expand[]', 'data.customer');
  params.set('created[gte]', String(createdGte));
  params.set('created[lte]', String(createdLte));
  if (startingAfter) params.set('starting_after', startingAfter);

  const res = await fetch(`https://api.stripe.com/v1/subscriptions?${params}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  return res.json();
}

async function fetchAllSubscriptionsInRange(stripeKey, createdGte, createdLte) {
  const all = [];
  let startingAfter = null;

  while (true) {
    const page = await fetchSubscriptionPage(stripeKey, createdGte, createdLte, startingAfter);
    if (!page.data || page.error) {
      throw new Error(page.error?.message || 'Stripe API error');
    }
    all.push(...page.data);
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return all;
}

async function resolveSiteDetails(env, sub) {
  const meta = sub.metadata || {};
  const platform = meta.platform ? meta.platform.trim().toLowerCase() : null;
  const domainFromMeta = meta.siteDomain ? String(meta.siteDomain).trim() : null;

  const siteId = meta.siteId ? String(meta.siteId).trim() : null;
  if ((!platform || !domainFromMeta) && siteId && env.CONSENT_WEBAPP) {
    try {
      const row = await env.CONSENT_WEBAPP
        .prepare('SELECT platform, domain FROM Site WHERE id = ?1 LIMIT 1')
        .bind(siteId)
        .first();
      return {
        platform: platform || row?.platform || null,
        domain: domainFromMeta || row?.domain || null,
      };
    } catch {
      return { platform, domain: domainFromMeta };
    }
  }

  return { platform, domain: domainFromMeta };
}

export async function handleAdminBackfillClickup(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 503 });
  }
  if (!env.CLICKUP_API_KEY) {
    return Response.json({ success: false, error: 'CLICKUP_API_KEY not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const platformFilter = (url.searchParams.get('platform') || 'all').toLowerCase();
  const includeWebsite = url.searchParams.get('includeWebsite') === 'true';

  const sinceParam = url.searchParams.get('since') || '2026-05-01';
  const untilParam = url.searchParams.get('until') || new Date().toISOString().split('T')[0];

  const createdGte = Math.floor(new Date(sinceParam).getTime() / 1000);
  const createdLte = Math.floor(new Date(untilParam + 'T23:59:59Z').getTime() / 1000);

  if (isNaN(createdGte) || isNaN(createdLte)) {
    return Response.json({ success: false, error: 'Invalid since/until date format. Use YYYY-MM-DD.' }, { status: 400 });
  }

  let allSubs;
  try {
    allSubs = await fetchAllSubscriptionsInRange(env.STRIPE_SECRET_KEY, createdGte, createdLte);
  } catch (err) {
    return Response.json({ success: false, error: `Stripe fetch failed: ${err.message}` }, { status: 502 });
  }

  const results = [];
  const skippedEntries = [];
  let sent = 0;
  const errors = [];

  for (const sub of allSubs) {
    const meta = sub.metadata || {};
    const customer = typeof sub.customer === 'object' ? sub.customer : null;
    const email = customer?.email || null;
    const name = customer?.name || null;
    const customerId = customer?.id || (typeof sub.customer === 'string' ? sub.customer : null);

    const { platform, domain: resolvedDomain } = await resolveSiteDetails(env, sub);
    const status = sub.status || null;
    const dateCreated = new Date(sub.created * 1000).toISOString().split('T')[0];

    if (platformFilter !== 'all' && platform !== platformFilter) {
      skippedEntries.push({ subId: sub.id, email, platform, status, dateCreated, reason: `platform filter (${platform})` });
      continue;
    }

    // Route null-platform entries to website list when includeWebsite=true, otherwise skip
    if (!platform || !['webflow', 'framer'].includes(platform)) {
      if (!includeWebsite) {
        skippedEntries.push({ subId: sub.id, email, platform, status, dateCreated, reason: `non-webflow/framer platform (${platform || 'null'})` });
        continue;
      }
      // fall through with platform=null → addCustomerToClickUp routes to CLICKUP_LIST_WEBSITE
    }

    const planId = meta.planId || null;
    const intervalRaw = sub.items?.data?.[0]?.plan?.interval;
    const interval = intervalRaw === 'year' ? 'yearly' : 'monthly';
    const amountCents = sub.items?.data?.[0]?.plan?.amount ?? null;
    const currency = sub.currency || 'usd';
    const domain = resolvedDomain;

    const entry = {
      subId: sub.id,
      email,
      name,
      platform,
      status,
      planId,
      interval,
      domain,
      dateCreated,
      customerId,
    };

    results.push(entry);

    if (!dryRun) {
      try {
        await addCustomerToClickUp(env, {
          email,
          name,
          platform,
          plan: planId,
          interval,
          domain,
          amountCents,
          currency,
          subscriptionId: sub.id,
          customerId,
          isFirstPurchase: false,
        });
        sent++;
      } catch (err) {
        errors.push({ subId: sub.id, error: err.message });
      }
    }
  }

  return Response.json({
    success: true,
    dryRun,
    range: { since: sinceParam, until: untilParam },
    platformFilter,
    totalFetched: allSubs.length,
    matched: results.length,
    sent: dryRun ? null : sent,
    skipped: skippedEntries.length,
    errors: errors.length > 0 ? errors : null,
    entries: results,
    skippedEntries,
    message: dryRun
      ? `Dry run: ${results.length} subscriptions would be sent to ClickUp. Re-run without ?dryRun=true to execute.`
      : `Backfill complete. ${sent} sent to ClickUp, ${skippedEntries.length} skipped, ${errors.length} errors.`,
  });
}
