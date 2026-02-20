// handlers/pageview.js

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

  // Log pageview (you can extend this to store in database if needed)
  console.log('[Pageview]', { siteId, pageUrl, timestamp: new Date().toISOString() });

  // For now, just return success
  // In the future, you might want to store pageviews in a database
  return Response.json({ success: true }, { status: 200 });
}
