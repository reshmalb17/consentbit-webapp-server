import { ensureSchema, getSubscriptionBySiteId, getSubscriptionByOrganization, getSiteById } from '../services/db.js';

/**
 * GET /api/payment/subscription?siteId=<id>
 *
 * Returns { subscriptionStatuses: [{ isSubscribed: bool }] }
 * Drop-in replacement for the cb-server endpoint of the same path.
 */
export async function handlePaymentSubscription(request, env) {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');

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

    const isSubscribed = !!(sub && ['active', 'trialing'].includes(sub.status ?? sub.status));
    const plan = sub?.planId ?? sub?.plan ?? null;
    const updatedAt = sub?.updatedAt ?? sub?.createdAt ?? null;

    return Response.json({ subscriptionStatuses: [{ isSubscribed, plan, updatedAt }] }, { status: 200 });
  } catch (err) {
    console.error('[paymentSubscription] error:', err);
    return Response.json({ subscriptionStatuses: [{ isSubscribed: false }] }, { status: 200 });
  }
}
