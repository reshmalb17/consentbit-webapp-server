import {
  createSite,
  listSites,
  getEffectivePlanForOrganization,
  getSessionById,
  getUserById,
  getOrCreateOrganizationForUser,
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
    // New app: infer organizationId from authenticated user (one-org-per-user)
    const sid = getSessionIdFromCookie(request);
    if (!sid) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    const session = await getSessionById(db, sid);
    if (!session) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    const userId = session.userId ?? session.user_id;
    const user = await getUserById(db, userId);
    if (!user) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

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
    const orgName = user?.name ? `${user.name}'s Organization` : 'My Organization';
    const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
    const organizationId = (org?.id || '').trim();

    if (!name || !domain || !organizationId) {
      return Response.json(
        { success: false, error: 'name and domain required' },
        { status: 400 },
      );
    }

    const existingSites = await listSites(db, { organizationId });
    const isUpdate = existingSites.some((s) => (s.domain || '').trim().toLowerCase() === domain.toLowerCase());
    if (!isUpdate) {
      const { planId: effectivePlanId, plan } = await getEffectivePlanForOrganization(db, organizationId);
      const sitesLimit = plan ? (plan.domainsIncluded ?? plan.domainsincluded ?? 1) : 1;
      if (existingSites.length >= sitesLimit) {
        const message = effectivePlanId === 'free'
          ? 'Free plan allows only 1 site. Upgrade to add more sites.'
          : `Your plan allows ${sitesLimit} site(s). Upgrade to add more.`;
        return Response.json(
          { success: false, error: message, code: 'SITE_LIMIT_REACHED' },
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
    // New app: default to the authenticated user's org sites.
    // Old dashboard can still pass ?organizationId=... for admin/backcompat.
    let organizationId = url.searchParams.get('organizationId') || null;
    if (!organizationId) {
      const sid = getSessionIdFromCookie(request);
      if (sid) {
        const session = await getSessionById(db, sid);
        const userId = session?.userId ?? session?.user_id;
        const user = userId ? await getUserById(db, userId) : null;
        if (user?.id) {
          const orgName = user?.name ? `${user.name}'s Organization` : 'My Organization';
          const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
          organizationId = org?.id || null;
        }
      }
    }

    const sites = await listSites(db, { organizationId: organizationId || undefined });
    // Include effective plan so UI can restrict features (e.g., GDPR+CCPA only for paid plans)
    const { planId: effectivePlanId } = await getEffectivePlanForOrganization(db, organizationId);
    return Response.json({ success: true, sites, effectivePlanId });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
