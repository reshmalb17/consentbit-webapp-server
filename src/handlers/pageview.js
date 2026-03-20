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
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const siteId = body?.siteId;
  const pageUrl = body?.pageUrl;

  if (!siteId) {
    return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
  }

  await ensureSchema(db);

  const site = await getSiteById(db, siteId);
  const organizationId = site ? (site.organizationId ?? site.organizationid) : null;

  const usage = await incrementPageviewUsage(db, siteId);

  let overLimit = false;
  if (organizationId) {
    const orgUsage = await getPageviewUsageForOrganization(db, organizationId);
    const { plan } = await getEffectivePlanForOrganization(db, organizationId);
    const limit = plan ? (plan.pageviewsIncluded ?? plan.pageviewsincluded ?? 7500) : 7500;
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
