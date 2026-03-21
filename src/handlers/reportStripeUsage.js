/**
 * Workflow A: Report metered usage to Stripe (pageviews and scans).
 * Run from cron (e.g. daily or hourly). For each active subscription with a
 * Stripe subscription that has metered price items, we send current period usage
 * with action=set so Stripe bills at renewal.
 *
 * Env vars (optional): set metered price IDs so we know which subscription item
 * is for pageviews vs scans.
 *   STRIPE_PRICE_ESSENTIAL_PAGEVIEWS_METERED
 *   STRIPE_PRICE_ESSENTIAL_SCANS_METERED
 *   STRIPE_PRICE_GROWTH_PAGEVIEWS_METERED
 *   STRIPE_PRICE_GROWTH_SCANS_METERED
 * Unit for pageviews: 1 unit = 10,000 pageviews. Unit for scans: 1 unit = 10,000 scans.
 */

import { ensureSchema, getActiveSubscriptionsForMeteredReporting, getPageviewUsageForOrganization, getScanUsageForOrganization } from '../services/db.js';

const PAGEVIEW_UNIT_SIZE = 10000;
const SCAN_UNIT_SIZE = 10000;

function getMeteredPriceIds(env) {
  const ids = {
    pageviews: [],
    scans: [],
  };
  const essentialPv = env.STRIPE_PRICE_ESSENTIAL_PAGEVIEWS_METERED;
  const essentialScans = env.STRIPE_PRICE_ESSENTIAL_SCANS_METERED;
  const growthPv = env.STRIPE_PRICE_GROWTH_PAGEVIEWS_METERED;
  const growthScans = env.STRIPE_PRICE_GROWTH_SCANS_METERED;
  if (essentialPv) ids.pageviews.push(essentialPv);
  if (growthPv) ids.pageviews.push(growthPv);
  if (essentialScans) ids.scans.push(essentialScans);
  if (growthScans) ids.scans.push(growthScans);
  return ids;
}

export async function reportStripeMeteredUsage(env) {
  const db = env.CONSENT_WEBAPP;
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!db || !stripeKey) return;

  try {
    await ensureSchema(db);
  } catch (err) {
    console.error('[ReportStripeUsage] ensureSchema failed', err);
    return;
  }

  const meteredPriceIds = getMeteredPriceIds(env);
  if (meteredPriceIds.pageviews.length === 0 && meteredPriceIds.scans.length === 0) {
    return; // no metered prices configured
  }

  const subs = await getActiveSubscriptionsForMeteredReporting(db);
  if (subs.length === 0) return;

  let reported = 0;
  for (const row of subs) {
    const organizationId = row.organizationId ?? row.organizationid;
    const stripeSubId = row.stripeSubscriptionId ?? row.stripesubscriptionid;
    if (!organizationId || !stripeSubId) continue;

    try {
      const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}?expand[]=items.data.price`, {
        headers: { Authorization: `Bearer ${stripeKey}` },
      });
      const subData = await subRes.json();
      if (subData.error || !subData.items?.data) {
        console.warn('[ReportStripeUsage] Stripe subscription fetch failed', stripeSubId, subData.error?.message || subData);
        continue;
      }

      const pageviewUsage = await getPageviewUsageForOrganization(db, organizationId);
      const scanUsage = await getScanUsageForOrganization(db, organizationId);

      for (const item of subData.items.data) {
        const price = item.price;
        const usageType = price?.recurring?.usage_type;
        if (usageType !== 'metered') continue;

        const priceId = price?.id;
        const subscriptionItemId = item.id;

        let quantity = 0;
        if (meteredPriceIds.pageviews.includes(priceId)) {
          quantity = Math.ceil((pageviewUsage.pageviewCount || 0) / PAGEVIEW_UNIT_SIZE);
        } else if (meteredPriceIds.scans.includes(priceId)) {
          quantity = Math.ceil((scanUsage.scanCount || 0) / SCAN_UNIT_SIZE);
        } else {
          continue;
        }

        const params = new URLSearchParams();
        params.set('quantity', String(quantity));
        params.set('timestamp', String(Math.floor(Date.now() / 1000)));
        params.set('action', 'set');

        const usageRes = await fetch(`https://api.stripe.com/v1/subscription_items/${subscriptionItemId}/usage_records`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${stripeKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });
        const usageData = await usageRes.json();
        if (usageData.error) {
          console.warn('[ReportStripeUsage] usage record failed', subscriptionItemId, usageData.error.message);
        } else {
          reported++;
        }
      }
    } catch (err) {
      console.error('[ReportStripeUsage] Error for subscription', stripeSubId, err);
    }
  }

  if (reported > 0) {
    console.log('[ReportStripeUsage] Reported usage for', reported, 'subscription item(s)');
  }
}
