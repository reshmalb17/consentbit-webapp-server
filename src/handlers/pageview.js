// handlers/pageview.js
import { ensureSchema, incrementPageviewUsage } from '../services/db.js';

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

  try {
    await ensureSchema(db);
    // Increment monthly counter for this site.
    const result = await incrementPageviewUsage(db, siteId, new Date());

    // Keep console logs minimal to avoid noise in production.
    console.log('[Pageview]', {
      siteId,
      yearMonth: result?.yearMonth,
      // pageUrl intentionally omitted from log
    });

    return Response.json({ success: true, ...result }, { status: 200 });
  } catch (e) {
    console.error('[Pageview] failed', e);
    // Do not block banner rendering; just report failure.
    return Response.json(
      { success: false, error: e?.message || 'Failed to track pageview' },
      { status: 500 },
    );
  }
}
