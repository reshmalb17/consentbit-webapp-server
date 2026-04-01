import {
  listSites,
  getEffectivePlanForOrganization,
  getSessionById,
  getUserById,
  getOrCreateOrganizationForUser,
  createSite,
  normalizeDomain,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleSites(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  if (request.method === 'POST') {
    const sid = getSessionIdFromCookie(request);
    if (!sid) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    // 1. Parallel: session + user
    const [session, body] = await Promise.all([
      getSessionById(db, sid),
      request.json().catch(() => null),
    ]);

    if (!session) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const userId = session.userId ?? session.user_id;
    const user = await getUserById(db, userId);
    if (!user) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    if (!body) {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const name = (body.name || '').trim();
    const domain = normalizeDomain(body.domain || '');
    const bannerTypeRaw = body.bannerType || 'gdpr';
    const regionModeRaw = body.regionMode || 'gdpr';

    if (!name || !domain) {
      return Response.json({ success: false, error: 'name and domain required' }, { status: 400 });
    }

        // 2a. Resolve org first (needed as foreign key for subsequent queries)
    const orgName = user?.name ? `${user.name}'s Organization` : 'My Organization';
    const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });

    // 2b. Parallel: existing sites + effective plan (org.id now available)
    const [existingSites, planInfo] = await Promise.all([
      listSites(db, { organizationId: org.id }),
      getEffectivePlanForOrganization(db, org.id),
    ]);

    const organizationId = org.id;

    // Validate bannerType/regionMode (same as before)
    const allowedBannerTypes = ['gdpr', 'ccpa','iab'];
    const bannerType = allowedBannerTypes.includes(bannerTypeRaw) ? bannerTypeRaw : 'gdpr';
    const allowedRegionModes = ['gdpr', 'ccpa', 'both'];
    const regionMode = allowedRegionModes.includes(regionModeRaw) ? regionModeRaw : 'gdpr';

    // Site limit check (parallelized above)
    const isUpdate = existingSites.some((s) => (s.domain || '').trim().toLowerCase() === domain.toLowerCase());
    if (!isUpdate) {
      const sitesLimit = planInfo.plan?.domainsIncluded ?? 1;
      if (existingSites.length >= sitesLimit) {
        const message = planInfo.planId === 'free'
          ? 'Free plan allows only 1 site. Upgrade to add more sites.'
          : `Your plan allows ${sitesLimit} site(s). Upgrade to add more.`;
        return Response.json({ success: false, error: message, code: 'SITE_LIMIT_REACHED' }, { status: 403 });
      }
    }

    // 3. Create/update site
    let site;
    try {
      site = await createSite(db, {
        organizationId,
        name,
        domain,
        origin: url.origin,
        bannerType,
        regionMode,
      });
    } catch (e) {
      if (e?.code === 'DOMAIN_EXISTS' || e?.status === 409) {
        return Response.json(
          { success: false, error: 'This domain already exists.', code: 'DOMAIN_EXISTS' },
          { status: 409 },
        );
      }
      throw e;
    }

    return Response.json({ success: true, site });
  }

  if (request.method === 'GET') {
    const organizationId = url.searchParams.get('organizationId') || null;

    let sites, effectivePlanId;
    if (organizationId) {
      // Explicit org ID - parallel sites + plan
      const [siteResults, planResults] = await Promise.all([
        listSites(db, { organizationId }),
        getEffectivePlanForOrganization(db, organizationId),
      ]);
      sites = siteResults;
      effectivePlanId = planResults.planId;
    } else {
      // Authenticated user - parallel session + user + org + sites + plan
      const sid = getSessionIdFromCookie(request);
      if (sid) {
        const [session, user, siteResults, planResults] = await Promise.all([
          getSessionById(db, sid),
          sid ? getUserById(db, session?.userId ?? session?.user_id) : Promise.resolve(null),
          listSites(db, { organizationId: null }), // Will get user's orgs
          getEffectivePlanForOrganization(db, null), // Will get user's effective plan
        ]);
        sites = siteResults;
        effectivePlanId = planResults.planId;
      } else {
        // No auth - just empty sites
        sites = [];
        effectivePlanId = 'free';
      }
    }

    return Response.json({ success: true, sites, effectivePlanId });
  }

  return new Response('Method Not Allowed', { status: 405 });
}