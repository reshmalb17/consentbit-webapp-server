// handlers/pageview.js
import {
  ensureSchema,
  incrementPageviewUsage,
  getSiteById,
  getEffectivePlanForOrganization,
  getPageviewUsageForOrganization,
} from '../services/db.js';

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
    console.log('[Pageview] over limit — skipping storage', { siteId, limit });
    return Response.json(
      { success: true, overLimit: true, pageviewCount: limit },
      { status: 200 },
    );
  }

  const usage = await incrementPageviewUsage(db, siteId);

  let overLimit = false;
  if (organizationId) {
    const orgUsage = await getPageviewUsageForOrganization(db, organizationId);
    overLimit = orgUsage.pageviewCount >= limit;
  }

  console.log('[Pageview]', {
    siteId,
    pageUrl,
    yearMonth: usage.yearMonth,
    pageviewCount: usage.pageviewCount,
    overLimit,
    timestamp: new Date().toISOString(),
  });

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
