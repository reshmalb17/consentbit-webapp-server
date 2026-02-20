// handlers/markVerified.js
import { markSiteVerified } from '../services/db.js';

export async function handleMarkVerified(request, env) {
  const db = env.CONSENT_WEBAPP;
  
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body = null;

  try {
    body = await request.json();
  } catch (e) {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const siteId = body?.siteId;
  const scriptUrl = body?.scriptUrl || '';

  if (!siteId) {
    return Response.json(
      { success: false, error: 'siteId is required' },
      { status: 400 },
    );
  }

  try {
    await markSiteVerified(db, siteId, scriptUrl);
    
    return Response.json({
      success: true,
      message: 'Site marked as verified successfully',
    });
  } catch (err) {
    console.error('[MarkVerified] Error:', err);
    return Response.json(
      { success: false, error: err?.message || 'Failed to mark site as verified' },
      { status: 500 },
    );
  }
}
