import { createSite, listSites, getSubscriptionByOrganization } from '../services/db.js';

/** Only 1 site allowed without payment on staging/production. More allowed on localhost for dev. */
const FREE_SITE_LIMIT_STAGING_PROD = 1;
const FREE_SITE_LIMIT_DEV = 5;

function isStagingOrProduction(request) {
  try {
    const url = new URL(request.url);
    const host = (url.hostname || '').toLowerCase();
    return !host || host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')
      ? false
      : true;
  } catch (_) {
    return true; // assume staging/prod if we can't parse
  }
}

export async function handleSites(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return Response.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const name = (body.name || '').trim();
    const domain = (body.domain || '').trim();
    const bannerTypeRaw = body.bannerType || 'gdpr';
    const regionModeRaw = body.regionMode || 'gdpr'; // 'gdpr' | 'ccpa' | 'both'
    const organizationId = (body.organizationId || '').trim(); // from dashboard / session

    if (!name || !domain || !organizationId) {
      return Response.json(
        { success: false, error: 'name, domain, organizationId required' },
        { status: 400 },
      );
    }

    // On staging/production: only 1 site allowed without payment. On localhost: more for dev.
    const existingSites = await listSites(db, { organizationId });
    const isUpdate = existingSites.some((s) => (s.domain || '').trim().toLowerCase() === domain.toLowerCase());
    if (!isUpdate) {
      const subscription = await getSubscriptionByOrganization(db, organizationId);
      const status = (subscription && subscription.status) || (subscription && subscription.Status) || '';
      const hasPaidSubscription = ['active', 'trialing'].includes(String(status).toLowerCase());
      const freeLimit = isStagingOrProduction(request) ? FREE_SITE_LIMIT_STAGING_PROD : FREE_SITE_LIMIT_DEV;
      const siteLimit = hasPaidSubscription ? 999 : freeLimit;
      if (existingSites.length >= siteLimit) {
        return Response.json(
          {
            success: false,
            error: 'Only one site is included without a Pro plan. Upgrade to Pro to add more sites.',
            code: 'SITE_LIMIT_REACHED',
          },
          { status: 403 },
        );
      }
    }

    // validate bannerType
    const allowedBannerTypes = ['gdpr', 'ccpa'];
    const bannerType = allowedBannerTypes.includes(bannerTypeRaw)
      ? bannerTypeRaw
      : 'gdpr';

    // validate regionMode
    const allowedRegionModes = ['gdpr', 'ccpa', 'both'];
    const regionMode = allowedRegionModes.includes(regionModeRaw)
      ? regionModeRaw
      : 'gdpr';

    // create or update site for this org + domain
    const site = await createSite(db, {
      organizationId,
      name,
      domain,
      origin: url.origin,
      bannerType,
      regionMode,
    });

    return Response.json({ success: true, site });
  }

  if (request.method === 'GET') {
    // optional filter: ?organizationId=...
    const organizationId = url.searchParams.get('organizationId') || null;

    const sites = await listSites(db, { organizationId });
    return Response.json({ success: true, sites });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
