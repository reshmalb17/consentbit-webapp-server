// Single endpoint that returns user + orgs + sites in one Worker call,
// replacing the two separate /api/auth/me and /api/sites round trips.
import {
  getSessionById,
  getUserById,
  getOrganizationsForUser,
  getOrCreateOrganizationForUser,
  listSites,
  getSubscriptionsBySiteIds,
  getLatestSubscriptionsBySiteIds,
  getEffectivePlanForOrganization,
  buildEmbedScriptUrl,
  canonicalEmbedOrigin,
} from '../services/db.js';
import { listMemberSiteGrants, hasPendingInviteForEmail } from '../services/team.js';

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

  // Sites reached as a team member of someone else's account (services/team.js).
  const teamGrants = await listMemberSiteGrants(db, user.id);

  if (!orgs || orgs.length === 0) {
    // Someone who only joined another account's team (or is about to accept an
    // invite) should not be handed an empty organization of their own — they would
    // show up as "Account Owner" of nothing. Onboarding still creates one if they
    // add a site themselves.
    const teamOnly = teamGrants.length > 0 || (await hasPendingInviteForEmail(db, user.email));
    if (teamOnly) {
      orgs = [];
      organizationId = null;
    } else {
      const orgName = user.name ? `${user.name}'s Organization` : 'My Organization';
      const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
      orgs = [org];
      organizationId = org?.id ?? null;
    }
  }

  // Fetch sites for ALL orgs the user belongs to (guards against multi-org edge cases)
  const allOrgIds = [...new Set(orgs.map(o => o.id ?? o.organizationId).filter(Boolean))];
  if (organizationId && !allOrgIds.includes(organizationId)) allOrgIds.unshift(organizationId);

  const embedOrigin = canonicalEmbedOrigin(request, env);
  // `subscription` is destructured alongside planId because getEffectivePlanForOrganization
  // falls back to ANY subscription for the org when none is active — so a lapsed org still
  // reports planId 'basic' from its cancelled subscription. Without the status, the webapp's
  // org-level fallback makes a dead account look paid and routes it into the in-place tier
  // change, which cannot work against a terminal Stripe subscription.
  const [sitesNested, { planId: effectivePlanId, subscription: effectivePlanSub }] = await Promise.all([
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

  // Owner access wins when a site is reachable both ways.
  const teamRoleBySite = {};
  for (const s of sites) teamRoleBySite[String(s.id)] = 'owner';
  const memberSiteIds = [...new Set(teamGrants.map(g => String(g.siteId)))].filter(id => !seenIds.has(id));
  if (memberSiteIds.length > 0) {
    try {
      const ph = memberSiteIds.map((_, i) => `?${i + 1}`).join(',');
      const { results: memberSites } = await db
        .prepare(`SELECT * FROM Site WHERE id IN (${ph}) ORDER BY createdAt DESC`)
        .bind(...memberSiteIds)
        .all();
      for (const s of memberSites || []) {
        if (!s?.id || seenIds.has(s.id)) continue;
        seenIds.add(s.id);
        sites.push(s);
      }
    } catch (e) {
      console.warn('[DashboardInit] team site load failed:', e?.message);
    }
  }
  for (const g of teamGrants) {
    const id = String(g.siteId);
    if (!teamRoleBySite[id]) teamRoleBySite[id] = g.role;
  }

  // Batch-fetch all subscriptions in a single D1 query (eliminates N+1)
  const siteIds = (sites || []).map(s => s?.id ?? s?.siteId ?? s?.site_id).filter(Boolean);
  const subscriptionMap = await getSubscriptionsBySiteIds(db, siteIds);
  // Separate from the entitlement map above: the site's own latest subscription whatever
  // its status, so an ENDED plan can be told apart from never having had one. Only the
  // status/date/id fields below read from it — planId still comes from the entitlement
  // map, so a dead subscription can never present as a live plan.
  const latestSubMap = await getLatestSubscriptionsBySiteIds(db, siteIds);

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
    // planId ('basic'/'essential'/'growth') takes precedence over planType ('tier'/'single') —
    // tier subscriptions store the tier name in planId, not planType.
    const sitePlanId = (sub?.planId ?? sub?.planid ?? sub?.planType ?? sub?.plantype ?? null)?.toLowerCase() ?? null;
    // Subscription status per site. Added so the webapp can tell a LAPSED account
    // (site exists, subscription terminal) apart from a FREE one — without it the
    // upgrade page reads the stale planId, routes into the in-place tier change and
    // fails against a cancelled Stripe subscription. Additive: planId is unchanged,
    // so every existing consumer behaves exactly as before.
    // Read from the site's OWN latest row, not the entitlement map. `sub` is null once a
    // cancelled plan's paid period passes (getSubscriptionsBySiteIds drops it by design),
    // which reported the site as having no subscription at all — so the dashboard showed
    // "Active"/"Free" and the billing card fell through to a sibling site's plan. `hist`
    // keeps the ended subscription visible; `planId` above still comes from `sub`, so
    // entitlement is unchanged.
    const hist = siteId ? (latestSubMap[siteId] ?? null) : null;
    const siteSubStatus = (hist?.status ?? hist?.Status ?? sub?.status ?? sub?.Status ?? null)?.toLowerCase() ?? null;

    const stats = cookieStatsMap[siteId] ?? {};
    const pageStats = pageStatsMap[siteId] ?? pageStatsMap[String(siteId)] ?? {};
    return {
      ...site,
      scriptUrl,
      licenseKey: sub?.licenseKey ?? sub?.licensekey ?? null,
      planId: sitePlanId,
      plan_id: sitePlanId,
      subscriptionStatus: siteSubStatus,
      subscription_status: siteSubStatus,
      // All four follow the status above and come from the site's own latest row, so an
      // ended subscription still reports its id and dates. Without them the frontend
      // cannot say WHEN a plan ended, and Resume/Cancel lose the subscription they act on.
      subscriptionId: (hist ?? sub)?.id ?? null,
      stripeSubscriptionId: (hist ?? sub)?.stripeSubscriptionId ?? (hist ?? sub)?.stripesubscriptionid ?? null,
      subscriptionCurrentPeriodEnd: (hist ?? sub)?.currentPeriodEnd ?? (hist ?? sub)?.currentperiodend ?? null,
      subscriptionCancelAtPeriodEnd: Number((hist ?? sub)?.cancelAtPeriodEnd ?? (hist ?? sub)?.cancelatperiodend ?? 0) === 1 ? 1 : 0,
      interval: sub?.interval ?? sub?.billing_interval ?? null,
      cookieCount: stats.cookieCount ?? 0,
      cookieCategories: stats.cookieCategories ?? 0,
      pagesScanned: pageStats.pagesScanned ?? 0,
      // 'owner' | 'admin' | 'member' — the dashboard hides billing/plan actions for members.
      teamRole: teamRoleBySite[siteId] ?? 'owner',
    };
  });

  // Fetch subscriptions with a licenseKey but no site assigned yet (unactivated keys)
  let unassignedRows = [];
  if (allOrgIds.length > 0) try {
    const placeholders = allOrgIds.map((_, i) => `?${i + 1}`).join(',');
    const { results: unassignedSubs } = await db
      .prepare(
        `SELECT * FROM Subscription
         WHERE organizationId IN (${placeholders})
           AND licenseKey IS NOT NULL
           AND (siteId IS NULL OR siteId = '')
         ORDER BY createdAt DESC`
      )
      .bind(...allOrgIds)
      .all();

    unassignedRows = (unassignedSubs || []).map(sub => {
      const planId = (sub.planId ?? sub.planid ?? sub.planType ?? sub.plantype ?? null)?.toLowerCase() ?? null;
      const interval = sub.interval ?? sub.billing_interval ?? null;
      return {
        id: `unassigned_${sub.id}`,
        _isUnassigned: true,
        domain: null,
        name: null,
        organizationId: sub.organizationId ?? sub.organizationid,
        verified: 0,
        createdAt: sub.createdAt ?? sub.createdat,
        licenseKey: sub.licenseKey ?? sub.licensekey,
        planId,
        plan_id: planId,
        subscriptionId: sub.id,
        stripeSubscriptionId: sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null,
        subscriptionCurrentPeriodEnd: sub.currentPeriodEnd ?? sub.currentperiodend ?? null,
        subscriptionCancelAtPeriodEnd: Number(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend ?? 0) === 1 ? 1 : 0,
        interval,
        status: sub.status ?? 'active',
        cookieCount: 0,
        cookieCategories: 0,
        pagesScanned: 0,
      };
    });
  } catch (_) { /* non-critical — table may not have these columns yet */ }

  // One entry per account the user is a team member of (for the Team tab + labels).
  const teamMemberships = [];
  const seenTeamOrgs = new Set();
  for (const g of teamGrants) {
    const key = `${g.organizationId}:${g.role}`;
    if (seenTeamOrgs.has(key)) continue;
    seenTeamOrgs.add(key);
    teamMemberships.push({ organizationId: g.organizationId, role: g.role });
  }

  return Response.json({
    authenticated: true,
    success: true,
    user: { id: user.id, email: user.email, name: user.name, billingEmail: user.billingEmail ?? null },
    organizations: orgs,
    sites: [...sitesWithPlan, ...unassignedRows],
    effectivePlanId: effectivePlanId ?? null,
    effectivePlanStatus:
      (effectivePlanSub?.status ?? effectivePlanSub?.Status ?? null)?.toLowerCase() ?? null,
    teamMemberships,
  }, { status: 200 });
}
