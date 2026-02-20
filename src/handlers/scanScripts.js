// src/handlers/scanScripts.js
import { ensureScanSchema, insertScripts, recordScanHistory } from '../services/db.js';

export async function handleScanScripts(request, env) {
  let body = null;

  try {
    body = await request.json();
  } catch (e) {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const siteId = body?.siteId;
  const scripts = (body?.scripts) || [];
  const pageUrl = body?.pageUrl ? body.pageUrl.trim() : null;

  if (!siteId || !Array.isArray(scripts) || scripts.length === 0) {
    return Response.json(
      { success: false, error: 'siteId and scripts are required' },
      { status: 400 }
    );
  }

  try {
    const db = env.CONSENT_WEBAPP;
    const now = new Date().toISOString();
    const scanStartTime = Date.now();

    // Use separate DB module
    await ensureScanSchema(db);
    const scriptsFound = await insertScripts(db, siteId, scripts);
    const scanDuration = Date.now() - scanStartTime;
    const scanHistoryId = await recordScanHistory(
      db,
      siteId,
      pageUrl,
      scriptsFound,
      0, // cookiesFound (you can pass from payload if needed)
      scanDuration
    );

    return Response.json({
      success: true,
      scanHistoryId,
      scriptsFound,
      scanDuration,
    });
  } catch (err) {
    console.error('[ScanScripts] Error:', err);
    return Response.json(
      {
        success: false,
        error:
          err && err.message ? err.message : 'Failed to record scripts',
      },
      { status: 500 }
    );
  }
}
