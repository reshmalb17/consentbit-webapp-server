// handlers/webflowTrack.js
//
// First-party telemetry endpoint for the Webflow Designer extension. The plugin
// posts UI-only funnel events here — the ones that have NO other backend call, e.g.
// profile_settings_viewed and installation_code_copied — and the WORKER emits them to
// PostHog server-side. This keeps analytics off the client: the extension never calls a
// third-party analytics host and no PostHog key ships in the bundle.
//
//   POST /api/wf/track   (authenticated Webflow Designer route; identity carries siteId)
//   body: { event, properties?, wfSiteId? }
//   → { success: true }   (distinct_id resolved server-side from the account owner)
//
// Events that already fire from a real backend handler (oauth_completed, plan_selected,
// banner_verified, banner_settings_updated, cookie_scan_started, consent_logs_viewed,
// banner_changes_published, upgrade_initiated, ownership_transfer_sent) are intentionally
// NOT accepted here — they're captured where the action actually hits the backend.

import { capturePostHogEvent } from '../services/posthog.js';

// Only these UI-only Webflow funnel events may be sent from the client — the ones with
// no backend action to hang the event on (a settings view, a copy-to-clipboard click).
const ALLOWED_EVENTS = new Set([
  'profile_settings_viewed',
  'installation_code_copied',
  // Only the "Skip for now" outcome of plan_selected is client-sent (it has no backend
  // call). The free/paid plan choices fire server-side from their own handlers.
  'plan_selected',
]);

export async function handleWebflowTrack(request, env, ctx, identity) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const event = typeof body?.event === 'string' ? body.event : '';
  const properties = (body && typeof body.properties === 'object' && body.properties) || {};
  if (!ALLOWED_EVENTS.has(event)) {
    return Response.json({ success: false, error: 'Event not allowed' }, { status: 400 });
  }

  const webflowSiteId = identity?.webflowSiteId
    || request.headers.get('X-Webflow-Site-Id')
    || request.headers.get('x-webflow-site-id')
    || (typeof body?.wfSiteId === 'string' ? body.wfSiteId : '');

  // Resolve the account owner email (distinct_id) and confirm the site is Webflow.
  let email = null;
  try {
    if (webflowSiteId && env.CONSENT_WEBAPP) {
      const row = await env.CONSENT_WEBAPP.prepare(
        `SELECT u.email AS email, s.platform AS platform FROM Site s
           JOIN OrganizationMember om ON om.organizationId = s.organizationId AND lower(om.role) = 'owner'
           JOIN User u ON u.id = om.userId
          WHERE s.platformSiteId = ?1 ORDER BY s.createdAt ASC LIMIT 1`
      ).bind(webflowSiteId).first();
      if (row?.email && String(row.platform || '').toLowerCase() === 'webflow') {
        email = String(row.email).trim().toLowerCase();
      }
    }
  } catch { /* non-fatal */ }

  // Forward only primitive props (never client-supplied objects / PII).
  const safeProps = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) safeProps[k] = v;
  }

  if (email) {
    await capturePostHogEvent(env, email, event, {
      ...safeProps,
      platform: 'webflow',
      wf_site_id: webflowSiteId,
    });
  }

  // Always 200 so best-effort client telemetry never surfaces an error to the user.
  return Response.json({ success: true });
}
