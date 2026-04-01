// Single endpoint that returns user + orgs + sites in one Worker call,
// replacing the two separate /api/auth/me and /api/sites round trips.
import {
  getSessionById,
  getUserById,
  getOrganizationsForUser,
  getOrCreateOrganizationForUser,
  listSites,
  getSubscriptionsBySiteIds,
  getEffectivePlanForOrganization,
  buildEmbedScriptUrl,
  canonicalEmbedOrigin,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function pickSiteLicenseKey(site) {
  const k =
    site?.apiKey ?? site?.apikey ?? site?.api_key ??
    site?.licenseKey ?? site?.licensekey ?? site?.license_key ?? '';
  return k != null ? String(k).trim() : '';
}

function embedScriptUrlNeedsRepair(embedUrl) {
  return /YOUR-ACCOUNT|YOUR_ACCOUNT/i.test(String(embedUrl || ''));
}

export async function handleAuthDashboardInit(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json(
      { authenticated: false, success: false, error: 'Login required', sites: [], effectivePlanId: 'free', organizations: [] },
      { status: 401 },
    );
  }

  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json(
      { authenticated: false, success: false, error: 'Login required', sites: [], effectivePlanId: 'free', organizations: [] },
      { status: 401 },
    );
  }

  const userId = session.userId ?? session.user_id;

  // Fetch user + orgs in parallel — both only need userId
  const [user, orgsInitial] = await Promise.all([
    getUserById(db, userId),
    getOrganizationsForUser(db, userId),
  ]);

  if (!user) {
    return Response.json(
      { authenticated: false, success: false, error: 'Login required', sites: [], effectivePlanId: 'free', organizations: [] },
      { status: 401 },
    );
  }

  let orgs = orgsInitial;
  let organizationId = orgs?.[0]?.id ?? orgs?.[0]?.organizationId ?? null;

  if (!orgs || orgs.length === 0) {
    const orgName = user.name ? `${user.name}'s Organization` : 'My Organization';
    const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
    orgs = [org];
    organizationId = org?.id ?? null;
  }

  // Fetch sites for ALL orgs the user belongs to (guards against multi-org edge cases)
  const allOrgIds = [...new Set(orgs.map(o => o.id ?? o.organizationId).filter(Boolean))];
  if (organizationId && !allOrgIds.includes(organizationId)) allOrgIds.unshift(organizationId);

  const embedOrigin = canonicalEmbedOrigin(request, env);
  const [sitesNested, { planId: effectivePlanId }] = await Promise.all([
    Promise.all(allOrgIds.map(oid => listSites(db, { organizationId: oid }))),
    getEffectivePlanForOrganization(db, organizationId, env),
  ]);
  // Flatten and deduplicate by site id
  const seenIds = new Set();
  const sites = sitesNested.flat().filter(s => {
    const id = s?.id;
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });

  // Batch-fetch all subscriptions in a single D1 query (eliminates N+1)
  const siteIds = (sites || []).map(s => s?.id ?? s?.siteId ?? s?.site_id).filter(Boolean);
  const subscriptionMap = await getSubscriptionsBySiteIds(db, siteIds);

  // Repair stale embed URLs (fire-and-forget — don't block the response)
  const staleRepairs = (sites || [])
    .map(site => {
      const siteId = site?.id ?? site?.siteId ?? site?.site_id;
      const cdnId = site?.cdnScriptId ?? site?.cdnscriptid;
      const embed = site?.embedScriptUrl ?? site?.embedscripturl;
      if (siteId && cdnId && embedOrigin && (!embed || embedScriptUrlNeedsRepair(embed))) {
        const fixed = buildEmbedScriptUrl(embedOrigin, cdnId);
        site.embedScriptUrl = fixed;
        return db
          .prepare(`UPDATE Site SET embedScriptUrl = ?1, updatedAt = datetime('now') WHERE id = ?2`)
          .bind(fixed, siteId)
          .run()
          .catch(() => {/* ignore */});
      }
      return null;
    })
    .filter(Boolean);
  if (staleRepairs.length > 0) Promise.all(staleRepairs); // fire-and-forget

  // Fetch cookie counts + category counts per site in a single batch
  const cookieStatsMap = {};
  /** Distinct scan URLs with completed status per site (for "Pages scanned" on dashboard). */
  const pageStatsMap = {};
  if (siteIds.length > 0) {
    try {
      const placeholders = siteIds.map((_, i) => `?${i + 1}`).join(',');
      const { results: cookieRows } = await db
        .prepare(
          `SELECT siteId, COUNT(*) as total, COUNT(DISTINCT category) as cats
           FROM Cookie
           WHERE siteId IN (${placeholders}) AND (isExpected = 0 OR isExpected IS NULL)
           GROUP BY siteId`
        )
        .bind(...siteIds)
        .all();
      for (const row of cookieRows || []) {
        const sid = row.siteId ?? row.siteid;
        if (sid == null) continue;
        cookieStatsMap[String(sid)] = {
          cookieCount: Number(row.total ?? row.TOTAL) || 0,
          cookieCategories: Number(row.cats ?? row.CATS) || 0,
        };
      }
    } catch (_) { /* ignore — table may not exist yet */ }

    try {
      const placeholders = siteIds.map((_, i) => `?${i + 1}`).join(',');
      const { results: pageRows } = await db
        .prepare(
          `SELECT siteId, COUNT(*) as pagesScanned
           FROM ScanHistory
           WHERE siteId IN (${placeholders})
             AND LOWER(TRIM(COALESCE(scanStatus, ''))) IN ('completed', '')
             AND strftime('%Y-%m', createdAt) = strftime('%Y-%m', 'now')
           GROUP BY siteId`
        )
        .bind(...siteIds)
        .all();
      for (const row of pageRows || []) {
        const sid = row.siteId ?? row.siteid;
        if (sid == null) continue;
        const n = Number(row.pagesScanned ?? row.pagesscanned ?? 0);
        pageStatsMap[String(sid)] = { pagesScanned: Number.isFinite(n) ? n : 0 };
      }
    } catch (_) { /* ScanHistory may not exist yet */ }
  }

  // Enrich sites with subscription data (no extra DB queries needed)
  const sitesWithPlan = (sites || []).map(site => {
    const siteId = String(site?.id ?? site?.siteId ?? site?.site_id ?? '');
    const cdnId = site?.cdnScriptId ?? site?.cdnscriptid;
    const embed = site?.embedScriptUrl ?? site?.embedscripturl;
    const scriptUrl = embed || buildEmbedScriptUrl(embedOrigin, cdnId);
    const sub = siteId ? (subscriptionMap[siteId] ?? null) : null;
    const sitePlanId = String(sub?.planId ?? sub?.planid ?? 'free').toLowerCase();

    const stats = cookieStatsMap[siteId] ?? {};
    const pageStats = pageStatsMap[siteId] ?? pageStatsMap[String(siteId)] ?? {};
    return {
      ...site,
      scriptUrl,
      licenseKey: pickSiteLicenseKey(site),
      planId: sitePlanId,
      plan_id: sitePlanId,
      subscriptionId: sub?.id ?? null,
      stripeSubscriptionId: sub?.stripeSubscriptionId ?? sub?.stripesubscriptionid ?? null,
      subscriptionCurrentPeriodEnd: sub?.currentPeriodEnd ?? sub?.currentperiodend ?? null,
      subscriptionCancelAtPeriodEnd: Number(sub?.cancelAtPeriodEnd ?? sub?.cancelatperiodend ?? 0) === 1 ? 1 : 0,
      cookieCount: stats.cookieCount ?? 0,
      cookieCategories: stats.cookieCategories ?? 0,
      pagesScanned: pageStats.pagesScanned ?? 0,
    };
  });

  return Response.json({
    authenticated: true,
    success: true,
    user: { id: user.id, email: user.email, name: user.name },
    organizations: orgs,
    sites: sitesWithPlan,
    effectivePlanId: effectivePlanId || 'free',
  }, { status: 200 });
}
