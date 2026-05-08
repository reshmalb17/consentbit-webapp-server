// POST /api/admin/inject-script?wfSiteId=<wfSiteId>
// Manually injects the CDN script into a Webflow site's <head> using the stored accessToken.
// Used to fix sites where checkout completed but script injection failed.

import { checkAdminAuth } from '../utils/adminAuth.js';
import { buildEmbedScriptUrl } from '../services/db.js';
import { injectScriptIntoWebflowHead } from './webflowFreeRegister.js';

export async function handleAdminInjectScript(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const wfSiteId = url.searchParams.get('wfSiteId');
  if (!wfSiteId) {
    return Response.json({ success: false, error: 'wfSiteId is required' }, { status: 400 });
  }

  const db = env.CONSENT_WEBAPP;
  const kv = env.WEBFLOW_AUTHENTICATION;
  if (!db || !kv) {
    return Response.json({ success: false, error: 'DB or KV not configured' }, { status: 503 });
  }

  // Get KV entry
  const kvRaw = await kv.get(wfSiteId);
  if (!kvRaw) {
    return Response.json({ success: false, error: `No KV entry for wfSiteId=${wfSiteId}` }, { status: 404 });
  }
  const kvEntry = JSON.parse(kvRaw);
  const accessToken = kvEntry.accessToken;
  if (!accessToken) {
    return Response.json({ success: false, error: 'No accessToken in KV entry' }, { status: 400 });
  }

  // Resolve site from D1
  const siteRow = await db.prepare(
    'SELECT id, cdnScriptId FROM Site WHERE platformSiteId = ?1 LIMIT 1'
  ).bind(wfSiteId).first();

  if (!siteRow) {
    return Response.json({ success: false, error: `No Site found with platformSiteId=${wfSiteId}` }, { status: 404 });
  }

  const cdnScriptId = siteRow.cdnScriptId;
  const embedOrigin = String(env?.CDN_BASE_URL || env?.API_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
  const scriptUrl = buildEmbedScriptUrl(embedOrigin, cdnScriptId);

  if (!scriptUrl) {
    return Response.json({ success: false, error: `Could not build script URL for cdnScriptId=${cdnScriptId}` }, { status: 500 });
  }

  const result = await injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, '[AdminInjectScript]', kvEntry.webflowScriptId ?? null);

  if (result.success) {
    // Update KV
    const updatedKv = {
      ...kvEntry,
      webappSiteId: siteRow.id,
      webappScriptUrl: scriptUrl,
      cdnScriptId,
      isWebappMigrated: true,
      ...(result.webflowScriptId ? { webflowScriptId: result.webflowScriptId } : {}),
    };
    await kv.put(wfSiteId, JSON.stringify(updatedKv));
  }

  return Response.json({
    success: result.success,
    wfSiteId,
    siteId: siteRow.id,
    cdnScriptId,
    scriptUrl,
    webflowScriptId: result.webflowScriptId ?? null,
  });
}
