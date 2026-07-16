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
//   → { success: true }   (distinct_id resolved server-side — see resolveDistinctId)
//
// Events that already fire from a real backend handler (oauth_completed, banner_verified,
// banner_settings_updated, cookie_scan_started, consent_logs_viewed,
// banner_changes_published, upgrade_initiated, ownership_transfer_sent) are intentionally
// NOT accepted here — they're captured where the action actually hits the backend.
// plan_selected is the one split case: its free/paid outcomes fire server-side from their
// own handlers, but "Skip for now" has no backend call, so it is client-sent.

import { capturePostHogEvent } from '../services/posthog.js';

// Resolve the PostHog distinct_id for a Webflow site id.
//
// Mirrors the chain the launch-status endpoint uses (webflowOAuth.js) — the D1 org
// owner is authoritative, but that row only exists once a plan has been taken. Events
// fired BEFORE registration have no Site row to join: plan_selected with
// plan_tier:'skipped' is only ever reachable while the site is unregistered, since the
// Select Plan screen is shown precisely when `registered` is false. Requiring the Site
// join there dropped every skip on the floor. Fall back to the OAuth/billing email
// mirrored into KV at authorize time, then to the Webflow userKey — the same last
// resort oauth_completed uses — so pre-registration events still merge into the one
// PostHog person rather than vanishing.
async function resolveDistinctId(env, webflowSiteId) {
  if (!webflowSiteId) return { distinctId: null, source: 'none' };

  // 1. Registered site → the organization's owner user (authoritative).
  try {
    if (env.CONSENT_WEBAPP) {
      const row = await env.CONSENT_WEBAPP.prepare(
        `SELECT u.email AS email, s.platform AS platform FROM Site s
           JOIN OrganizationMember om ON om.organizationId = s.organizationId AND lower(om.role) = 'owner'
           JOIN User u ON u.id = om.userId
          WHERE s.platformSiteId = ?1 ORDER BY s.createdAt ASC LIMIT 1`
      ).bind(webflowSiteId).first();
      if (row?.email && String(row.platform || '').toLowerCase() === 'webflow') {
        return { distinctId: String(row.email).trim().toLowerCase(), source: 'site_owner' };
      }
    }
  } catch { /* non-fatal */ }

  // 2. Pre-registration → the OAuth email mirrored into KV at authorize time, or the
  //    billing email stamped at checkout. Keyed by Webflow site id, so it is present
  //    from OAuth onward. This also covers paid-but-not-yet-stamped sites, whose Site
  //    row exists with a domain but no platformSiteId for step 1 to match on.
  try {
    const raw = await env.WEBFLOW_AUTHENTICATION?.get(webflowSiteId);
    if (raw) {
      const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const kvEmail = entry?.billingEmail || entry?.email;
      if (kvEmail) return { distinctId: String(kvEmail).trim().toLowerCase(), source: 'oauth_kv' };
    }
  } catch { /* non-fatal */ }

  // 3. KV miss → the D1 OAuth record: siteId → userKey → the authorizedBy blob.
  try {
    if (env.CONSENT_WEBAPP) {
      const row = await env.CONSENT_WEBAPP.prepare(
        `SELECT t.userKey AS userKey, t.authorizedBy AS authorizedBy
           FROM WebflowOAuthSite s JOIN WebflowOAuthToken t ON t.userKey = s.userKey
          WHERE s.siteId = ?1 LIMIT 1`
      ).bind(webflowSiteId).first();
      if (row) {
        let oauthEmail = null;
        try {
          const authorizedBy = row.authorizedBy ? JSON.parse(row.authorizedBy) : null;
          oauthEmail = authorizedBy?.email || authorizedBy?.user?.email || null;
        } catch { /* malformed blob — fall through to userKey */ }
        if (oauthEmail) return { distinctId: String(oauthEmail).trim().toLowerCase(), source: 'oauth_d1' };
        if (row.userKey) return { distinctId: String(row.userKey), source: 'oauth_userkey' };
      }
    }
  } catch { /* non-fatal */ }

  return { distinctId: null, source: 'none' };
}

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

  // Resolve the distinct_id — registered owner, else the pre-registration OAuth identity.
  const { distinctId, source } = await resolveDistinctId(env, webflowSiteId);

  // Forward only primitive props (never client-supplied objects / PII).
  const safeProps = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) safeProps[k] = v;
  }

  if (distinctId) {
    await capturePostHogEvent(env, distinctId, event, {
      ...safeProps,
      platform: 'webflow',
      wf_site_id: webflowSiteId,
    });
  } else {
    // Nothing identified this site — the event is lost. Log it: a silent 200 here is
    // what hid the dropped skip events in the first place.
    console.warn(`[wf/track] no distinct_id for site ${webflowSiteId || '(none)'} — dropped ${event}`);
  }
  console.log(`[wf/track] ${event} site=${webflowSiteId || '(none)'} identity=${source}`);

  // Always 200 so best-effort client telemetry never surfaces an error to the user.
  return Response.json({ success: true });
}
