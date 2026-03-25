import {
  createSite,
  listSites,
  getEffectivePlanForOrganization,
  getSubscriptionBySiteId,
  getSessionById,
  getUserById,
  getOrCreateOrganizationForUser,
  buildEmbedScriptUrl,
  canonicalEmbedOrigin,
} from '../services/db.js';

/** Site API key for dashboard "License key" column (D1 field casing may vary). */
function pickSiteLicenseKey(site) {
  const k =
    site?.apiKey ??
    site?.apikey ??
    site?.api_key ??
    site?.licenseKey ??
    site?.licensekey ??
    site?.license_key ??
    '';
  return k != null ? String(k).trim() : '';
}

/** True when Site.embedScriptUrl was saved with wrangler placeholder host (legacy misconfig). */
function embedScriptUrlNeedsRepair(embedUrl) {
  const s = String(embedUrl || '');
  return /YOUR-ACCOUNT|YOUR_ACCOUNT/i.test(s);
}

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
      const { planId: effectivePlanId, plan } = await getEffectivePlanForOrganization(db, organizationId, env);
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

    const embedOrigin = canonicalEmbedOrigin(request, env);
    // create or update site for this org + domain
    const site = await createSite(db, {
      organizationId,
      name,
      domain,
      origin: embedOrigin || url.origin,
      bannerType,
      regionMode,
    });

    return Response.json({
      success: true,
      site: {
        ...site,
        scriptUrl:
          site.embedScriptUrl ||
          buildEmbedScriptUrl(embedOrigin || url.origin, site.cdnScriptId),
        licenseKey: pickSiteLicenseKey(site),
      },
    });
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
    const embedOrigin = canonicalEmbedOrigin(request, env);
    // Persist correct embed URL: missing, or legacy placeholder host in Site.embedScriptUrl (D1).
    for (const row of sites || []) {
      const id = row?.id;
      const embed = row?.embedScriptUrl ?? row?.embedscripturl;
      const cdnId = row?.cdnScriptId ?? row?.cdnscriptid;
      if (!id || !cdnId || !embedOrigin) continue;

      let computed = null;
      if (!embed) {
        computed = buildEmbedScriptUrl(embedOrigin, cdnId);
      } else if (embedScriptUrlNeedsRepair(embed)) {
        computed = buildEmbedScriptUrl(embedOrigin, cdnId);
      }

      if (computed) {
        await db
          .prepare(
            `UPDATE Site SET embedScriptUrl = ?1, updatedAt = datetime('now') WHERE id = ?2`,
          )
          .bind(computed, id)
          .run();
        row.embedScriptUrl = computed;
      }
    }
    // Enrich each site with planId from its active/trialing subscription.
    // If no site subscription exists, treat it as free.
    const sitesWithPlan = await Promise.all(
      (sites || []).map(async (site) => {
        const sid = site?.id ?? site?.siteId ?? site?.site_id;
        const sub = sid ? await getSubscriptionBySiteId(db, sid) : null;
        const sitePlanId = String(sub?.planId ?? sub?.planid ?? 'free').toLowerCase();
        const cdnId = site?.cdnScriptId ?? site?.cdnscriptid;
        const scriptUrl =
          site?.embedScriptUrl ||
          site?.embedscripturl ||
          buildEmbedScriptUrl(embedOrigin, cdnId);
        return {
          ...site,
          scriptUrl,
          licenseKey: pickSiteLicenseKey(site),
          planId: sitePlanId,
          plan_id: sitePlanId,
          subscriptionId: sub?.id ?? null,
          subscription_id: sub?.id ?? null,
          stripeSubscriptionId: sub?.stripeSubscriptionId ?? sub?.stripesubscriptionid ?? null,
          stripe_subscription_id: sub?.stripeSubscriptionId ?? sub?.stripesubscriptionid ?? null,
          subscriptionCurrentPeriodEnd:
            sub?.currentPeriodEnd ?? sub?.currentperiodend ?? null,
          subscription_current_period_end:
            sub?.currentPeriodEnd ?? sub?.currentperiodend ?? null,
          subscriptionCancelAtPeriodEnd:
            Number(sub?.cancelAtPeriodEnd ?? sub?.cancelatperiodend ?? 0) === 1 ? 1 : 0,
          subscription_cancel_at_period_end:
            Number(sub?.cancelAtPeriodEnd ?? sub?.cancelatperiodend ?? 0) === 1 ? 1 : 0,
        };
      })
    );
    // Include effective plan so UI can restrict features (e.g., GDPR+CCPA only for paid plans)
    const { planId: effectivePlanId } = await getEffectivePlanForOrganization(db, organizationId, env);
    return Response.json({ success: true, sites: sitesWithPlan, effectivePlanId });
  }

  return new Response('Method Not Allowed', { status: 405 });
}
