// handlers/pageview.js
import {
  ensureSchema,
  incrementPageviewUsage,
  incrementBlockedPageviewUsage,
  getSiteById,
  getEffectivePlanForOrganization,
  getPageviewUsageForOrganization,
} from '../services/db.js';
import { createAdminNotification } from '../services/adminNotifications.js';

export async function handlePageview(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return Response.json(
      { success: false, error: 'Method Not Allowed' },
      { status: 405 },
    );
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

  const siteId = body?.siteId;
  // pageUrl is currently not used for aggregation (we only count pageviews per site per month),
  // but we keep it for future breakdowns/debugging.
  const pageUrl = body?.pageUrl;

  if (!siteId) {
    return Response.json(
      { success: false, error: 'siteId is required' },
      { status: 400 },
    );
  }

  await ensureSchema(db);

  const site = await getSiteById(db, siteId);
  if (!site) {
    return Response.json(
      { success: false, error: 'Site not found' },
      { status: 404 },
    );
  }

  // Origin validation: only accept pageviews from the site's own origin (or its subdomains).
  // This prevents cross-origin abuse (e.g. evil.com injecting fake analytics for another site).
  function normalizeHost(raw) {
    const s = String(raw || '').trim().toLowerCase();
    return s.replace(/^www\./, '').replace(/\.+$/, '');
  }
  function hostMatchesSite(host, siteDomain) {
    const h = normalizeHost(host);
    const d = normalizeHost(siteDomain);
    if (!h || !d) return false;
    if (h === d) return true;
    return h.endsWith(`.${d}`);
  }
  const originHeader = request.headers.get('Origin') || '';
  const refererHeader = request.headers.get('Referer') || '';
  let requestHost = '';
  try {
    if (originHeader) requestHost = new URL(originHeader).hostname;
    else if (refererHeader) requestHost = new URL(refererHeader).hostname;
    else if (pageUrl) requestHost = new URL(String(pageUrl)).hostname;
  } catch {
    requestHost = '';
  }

  const siteDomain = site.domain || site.siteDomain || site.sitedomain || '';
  if (requestHost && !hostMatchesSite(requestHost, siteDomain)) {
    return Response.json(
      { success: false, error: 'Origin not allowed for this site' },
      { status: 403 },
    );
  }

  const organizationId = site ? (site.organizationId ?? site.organizationid) : null;

  // Check limit BEFORE incrementing — if already over limit, skip storage
  let preCheckOverLimit = false;
  let limit = 7500;
  if (organizationId) {
    const [orgUsage, { plan }] = await Promise.all([
      getPageviewUsageForOrganization(db, organizationId),
      getEffectivePlanForOrganization(db, organizationId, env),
    ]);
    limit = plan ? (plan.pageviewsIncluded ?? plan.pageviewsincluded ?? 7500) : 7500;
    preCheckOverLimit = orgUsage.pageviewCount >= limit;
  }

  if (preCheckOverLimit) {
    // Behaviour is unchanged — the view is still NOT counted against the plan, and the
    // response is the same as before. We only tally it separately so we can see how much
    // traffic a site is actually doing past its quota. Never let this break the request.
    await incrementBlockedPageviewUsage(db, siteId).catch(() => null);
    return Response.json(
      { success: true, overLimit: true, pageviewCount: limit },
      { status: 200 },
    );
  }

  const usage = await incrementPageviewUsage(db, siteId);

  if (!site.verified) {
    db.prepare(`UPDATE Site SET verified = 1, verified_at = datetime('now') WHERE id = ?1`)
      .bind(siteId).run().catch(() => {});
  }

  let overLimit = false;
  if (organizationId) {
    const orgUsage = await getPageviewUsageForOrganization(db, organizationId);
    overLimit = orgUsage.pageviewCount >= limit;

    // Raise the operator notification ONLY on the request that crosses the line.
    // This is the hot path — every pageview runs it — so keying off the crossing
    // means one write per org per month instead of one attempted insert per view
    // for the rest of the month. Requests that arrive already over the limit
    // return early above and never reach here.
    if (overLimit && !preCheckOverLimit) {
      await createAdminNotification(db, {
        type: 'limit.pageviews',
        severity: 'warning',
        title: `Pageview limit reached — ${siteDomain || siteId}`,
        message: `${orgUsage.pageviewCount} of ${limit} pageviews used this month. Further pageviews on this organization are no longer recorded until the quota resets.`,
        siteId,
        domain: siteDomain || null,
        organizationId,
        detail: {
          resource: 'pageviews',
          used: orgUsage.pageviewCount,
          limit,
          yearMonth: orgUsage.yearMonth,
        },
        // Org-scoped, because the pageview allowance is pooled across its sites.
        dedupeKey: `limit:pageviews:${organizationId}:${orgUsage.yearMonth}`,
      }).catch(() => null);
    }
  }

  return Response.json(
    {
      success: true,
      yearMonth: usage.yearMonth,
      pageviewCount: usage.pageviewCount,
      overLimit,
    },
    { status: 200 }
  );
}
