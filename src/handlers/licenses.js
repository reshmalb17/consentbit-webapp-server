// GET /api/licenses?organizationId=xxx
// Returns flattened license keys with details and activated site info.
// Requires auth (session cookie).

import { getSessionById, getUserById, getSubscriptionsByOrganization, getSiteById, getLicenseActivationsByOrganization } from '../services/db.js';

/** Extract licenseKeys from a row - D1 returns column as "licensekeys" (lowercase). */
function getLicenseKeysFromRow(row) {
  let raw = row.licensekeys ?? row.licenseKeys ?? row.license_keys ?? null;
  if (!raw) {
    const k = Object.keys(row || {}).find((key) => key.toLowerCase() === 'licensekeys');
    if (k) raw = row[k];
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch (_) {
    return [];
  }
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleLicenses(request, env) {
  if (request.method !== 'GET') {
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

  const url = new URL(request.url);
  const organizationId = (url.searchParams.get('organizationId') || '').trim();
  if (!organizationId) {
    return Response.json({ success: false, error: 'organizationId required' }, { status: 400 });
  }

  const subs = await getSubscriptionsByOrganization(db, organizationId);
  const activations = await getLicenseActivationsByOrganization(db, organizationId);

  // Explicitly fetch quantity plan rows (planType='quantity') - more reliable than filtering by licenseKeys column
  let quantityRows = [];
  try {
    const qRes = await db.prepare(
      'SELECT * FROM Subscription WHERE organizationId = ?1 AND planType = ?2'
    ).bind(organizationId, 'quantity').all();
    quantityRows = qRes.results || [];
  } catch (e) {
    console.warn('[Licenses] Quantity plan query failed:', e.message);
  }

  const processedSubIds = new Set();
  const licenses = [];

  for (const sub of subs) {
    const planType = String(sub.planType ?? sub.plantype ?? 'single').toLowerCase();
    const status = sub.status ?? 'active';
    const interval = sub.interval ?? 'monthly';
    const currentPeriodEnd = sub.currentPeriodEnd ?? sub.currentperiodend ?? null;
    const siteId = sub.siteId ?? sub.siteid ?? null;
    const keys = getLicenseKeysFromRow(sub);

    let siteName = null;
    let siteDomain = null;
    if (siteId) {
      const site = await getSiteById(db, siteId);
      if (site) {
        siteName = site.name ?? null;
        siteDomain = site.domain ?? null;
      }
    }

    // Quantity plan: has licenseKeys array (or planType quantity with keys)
    if ((planType === 'quantity' || (keys && keys.length > 0)) && keys && keys.length > 0) {
      const qty = sub.quantity ?? sub.Quantity ?? keys.length;
      const subId = sub.id ?? null;
      const stripeSubId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null;
      const cancelAtPeriodEnd = !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const activatedSiteId = activations[key] || null;
        let siteName = null;
        let siteDomain = null;
        if (activatedSiteId) {
          const site = await getSiteById(db, activatedSiteId);
          if (site) {
            siteName = site.name ?? null;
            siteDomain = site.domain ?? null;
          }
        }
        licenses.push({
          licenseKey: key,
          planType: 'quantity',
          status,
          interval,
          currentPeriodEnd,
          quantity: qty,
          siteId: activatedSiteId,
          siteName,
          siteDomain,
          subscriptionId: subId,
          stripeSubscriptionId: stripeSubId,
          cancelAtPeriodEnd,
        });
      }
      processedSubIds.add(sub.id);
    } else if (sub.licenseKey ?? sub.licensekey) {
      const cancelAtPeriodEnd = !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend);
      licenses.push({
        licenseKey: sub.licenseKey ?? sub.licensekey,
        planType,
        status,
        interval,
        currentPeriodEnd,
        quantity: 1,
        siteId,
        siteName,
        siteDomain,
        subscriptionId: sub.id ?? null,
        stripeSubscriptionId: sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null,
        cancelAtPeriodEnd,
      });
    }
  }

  // Process quantity rows from explicit query (in case they weren't in main subs or licenseKeys wasn't returned)
  for (const sub of quantityRows) {
    if (processedSubIds.has(sub.id)) continue;
    const keys = getLicenseKeysFromRow(sub);
    if (!keys || !Array.isArray(keys) || keys.length === 0) continue;
    const status = sub.status ?? 'active';
    const interval = sub.interval ?? 'monthly';
    const currentPeriodEnd = sub.currentPeriodEnd ?? sub.currentperiodend ?? null;
    const qty = sub.quantity ?? sub.Quantity ?? keys.length;
    const subId = sub.id ?? null;
    const stripeSubId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null;
    const cancelAtPeriodEnd = !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const activatedSiteId = activations[key] || null;
      let siteName = null;
      let siteDomain = null;
      if (activatedSiteId) {
        const site = await getSiteById(db, activatedSiteId);
        if (site) {
          siteName = site.name ?? null;
          siteDomain = site.domain ?? null;
        }
      }
      licenses.push({
        licenseKey: key,
        planType: 'quantity',
        status,
        interval,
        currentPeriodEnd,
        quantity: qty,
        siteId: activatedSiteId,
        siteName,
        siteDomain,
        subscriptionId: subId,
        stripeSubscriptionId: stripeSubId,
        cancelAtPeriodEnd,
      });
    }
  }

  return Response.json({ success: true, licenses });
}
