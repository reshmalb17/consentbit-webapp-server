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

    // Fast path: siteId is already a direct D1 internal siteId (e.g. passed from extension using webappSiteId)
    const directRow = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
    if (directRow) {
      resolvedSiteId = directRow.id;
    }

    const platformRow = !directRow
      ? await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(siteId).first()
      : null;
    if (platformRow) {
      resolvedSiteId = platformRow.id;
    } else {
    }

    // KV fallback: if platformSiteId not set, resolve via WEBFLOW_AUTHENTICATION KV
    if (!directRow && resolvedSiteId === siteId && env.WEBFLOW_AUTHENTICATION) {
      try {
        const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(siteId);
        if (kvRaw) {
          const kvEntry = typeof kvRaw === 'string' ? JSON.parse(kvRaw) : kvRaw;
          // 1. webappSiteId fast path
          if (kvEntry.webappSiteId) {
            const directRow = await db.prepare('SELECT id FROM Site WHERE id = ?1 LIMIT 1').bind(kvEntry.webappSiteId).first();
            if (directRow) {
              resolvedSiteId = directRow.id;
              db.prepare('UPDATE Site SET platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3')
                .bind(siteId, new Date().toISOString(), resolvedSiteId).run().catch(() => {});
            } else {
              console.warn('[SUB-CHECK] KV webappSiteId not found in Site table:', kvEntry.webappSiteId);
            }
          }
          // 2. Domain fallback
          if (resolvedSiteId === siteId) {
            const rawDomain = kvEntry.customDomain || kvEntry.stagingUrl || kvEntry.domain || null;
            if (rawDomain) {
              const cleanDomain = rawDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
              const domainRow = await db.prepare(
                'SELECT id FROM Site WHERE LOWER(REPLACE(domain, "https://", "")) = ?1 LIMIT 1'
              ).bind(cleanDomain).first();
              if (domainRow) {
                resolvedSiteId = domainRow.id;
                db.prepare('UPDATE Site SET platformSiteId = ?1, updatedAt = ?2 WHERE id = ?3')
                  .bind(siteId, new Date().toISOString(), resolvedSiteId).run().catch(() => {});
              } else {
                console.warn('[SUB-CHECK] domain not found in Site table:', cleanDomain);
              }
            }
          }
        } else {
          console.warn('[SUB-CHECK] no KV entry for siteId:', siteId);
        }
      } catch (e) { console.error('[SUB-CHECK] KV fallback error:', e?.message); }
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
    let plan = sub?.planId ?? sub?.planid ?? null;
    const updatedAt = sub?.updatedAt ?? sub?.createdAt ?? null;

    try {
      if (env.WEBFLOW_AUTHENTICATION) {
        const wfKvRaw = await env.WEBFLOW_AUTHENTICATION.get(siteId);
        if (wfKvRaw) {
          const wfEntry = typeof wfKvRaw === 'string' ? JSON.parse(wfKvRaw) : wfKvRaw;

          // Use plan stamped by Stripe webhook if D1 didn't return one
          if (!plan && wfEntry.plan && ['basic', 'essential', 'growth'].includes(wfEntry.plan)) {
            plan = wfEntry.plan;
            if (!isSubscribed) isSubscribed = true;
          }

          // Cross-check with ACTIVE_SITES_CONSENTBIT for legacy users
          if (env.ACTIVE_SITES_CONSENTBIT) {
            const rawDomain = wfEntry.customDomain || wfEntry.stagingUrl || wfEntry.domain || null;
            if (rawDomain) {
              const domain = rawDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
              let kvEntry = await env.ACTIVE_SITES_CONSENTBIT.get(domain, { type: 'json' });
              if (!kvEntry) {
                kvEntry = await env.ACTIVE_SITES_CONSENTBIT.get(`https://${domain}`, { type: 'json' });
              }
              if (kvEntry) {
                const kvActive = kvEntry.active === true;
                const kvExplicitlyInactive = kvEntry.active === false;
                if (!isSubscribed && kvActive) isSubscribed = true;
                else if (isSubscribed && kvExplicitlyInactive) isSubscribed = false;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[SUB-CHECK] KV check error:', e?.message);
    }


    // Back-fill: if plan resolved from D1 but KV didn't have it, stamp it now so future lookups are instant
    if (plan && isSubscribed && env.WEBFLOW_AUTHENTICATION) {
      try {
        const raw = await env.WEBFLOW_AUTHENTICATION.get(siteId);
        if (raw) {
          const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!entry.plan || entry.plan !== plan) {
            await env.WEBFLOW_AUTHENTICATION.put(siteId, JSON.stringify({ ...entry, plan }));
          }
        }
      } catch (_) {}
    }

    return Response.json({ subscriptionStatuses: [{ isSubscribed, plan, updatedAt }] }, { status: 200 });
  } catch (err) {
    console.error('[paymentSubscription] error:', err);
    return Response.json({ subscriptionStatuses: [{ isSubscribed: false }] }, { status: 200 });
  }
}
