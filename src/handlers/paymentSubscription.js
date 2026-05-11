import { ensureSchema, getSubscriptionBySiteId, getSubscriptionByOrganization, getSiteById } from '../services/db.js';

/**
 * GET /api/payment/subscription?siteId=<id>
 *
 * Returns { subscriptionStatuses: [{ isSubscribed: bool }] }
 * Drop-in replacement for the cb-server endpoint of the same path.
 *
 * Source of truth priority:
 *  1. D1 Subscription table (primary — kept in sync by Stripe webhooks)
 *  2. ACTIVE_SITES_CONSENTBIT KV (fallback for legacy users whose D1 stripeSubscriptionId
 *     was null during migration, so webhook updates couldn't match the row by sub ID;
 *     KV is updated by syncSubscriptionUpdateToLegacy / syncSubscriptionDeletedToLegacy)
 */
export async function handlePaymentSubscription(request, env) {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId'); // wfSiteId from the Webflow app

  if (!siteId) {
    return Response.json({ subscriptionStatuses: [{ isSubscribed: false }] }, { status: 200 });
  }

  try {
    const db = env.CONSENT_WEBAPP;
    await ensureSchema(db);

    // Resolve wfSiteId (Webflow platform siteId) → D1 internal siteId via platformSiteId
    let resolvedSiteId = siteId;
    const platformRow = await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(siteId).first();
    if (platformRow) {
      resolvedSiteId = platformRow.id;
    }

    // 1. Try direct site → subscription link
    let sub = await getSubscriptionBySiteId(db, resolvedSiteId);

    // 2. Fallback: look up via organization
    if (!sub) {
      const site = await getSiteById(db, resolvedSiteId);
      const orgId = site ? (site.organizationId ?? site.organizationid ?? null) : null;
      if (orgId) {
        sub = await getSubscriptionByOrganization(db, orgId);
      }
    }

    let isSubscribed = !!(sub && ['active', 'trialing'].includes(sub.status ?? ''));
    const plan = sub?.planId ?? sub?.planid ?? null;
    const updatedAt = sub?.updatedAt ?? sub?.createdAt ?? null;

    // 3. Cross-check with ACTIVE_SITES_CONSENTBIT KV
    //    Handles legacy migrated users whose D1 stripeSubscriptionId is null — Stripe webhooks
    //    update the KV correctly (syncSubscriptionUpdateToLegacy) but cannot match the D1 row
    //    by stripeSubscriptionId, so D1 status may be stale.
    //    Rule: KV overrides D1 in both directions when the KV entry is explicit.
    try {
      if (env.WEBFLOW_AUTHENTICATION && env.ACTIVE_SITES_CONSENTBIT) {
        // Resolve the site domain via WEBFLOW_AUTHENTICATION KV (keyed by wfSiteId)
        const wfKvRaw = await env.WEBFLOW_AUTHENTICATION.get(siteId);
        if (wfKvRaw) {
          const wfEntry = typeof wfKvRaw === 'string' ? JSON.parse(wfKvRaw) : wfKvRaw;
          const rawDomain = wfEntry.customDomain || wfEntry.stagingUrl || wfEntry.domain || null;
          if (rawDomain) {
            const domain = rawDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

            // Try bare key first, then protocol-prefixed (KV entries exist in both formats)
            let kvEntry = await env.ACTIVE_SITES_CONSENTBIT.get(domain, { type: 'json' });
            if (!kvEntry) {
              kvEntry = await env.ACTIVE_SITES_CONSENTBIT.get(`https://${domain}`, { type: 'json' });
            }

            if (kvEntry) {
              const kvActive = kvEntry.active === true;
              const kvExplicitlyInactive = kvEntry.active === false;

              if (!isSubscribed && kvActive) {
                // D1 says not subscribed, KV says active — legacy user whose D1 is stale
                isSubscribed = true;
              } else if (isSubscribed && kvExplicitlyInactive) {
                // D1 says subscribed, KV says inactive — subscription was canceled in Stripe
                // and KV was updated by webhook, but D1 row couldn't be matched (null stripeSubId)
                isSubscribed = false;
              }
            }
          }
        }
      }
    } catch (_) {
      // KV check is best-effort — never fail the whole request over it
    }

    return Response.json({ subscriptionStatuses: [{ isSubscribed, plan, updatedAt }] }, { status: 200 });
  } catch (err) {
    console.error('[paymentSubscription] error:', err);
    return Response.json({ subscriptionStatuses: [{ isSubscribed: false }] }, { status: 200 });
  }
}
