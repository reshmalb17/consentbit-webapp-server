// TEMPORARY diagnostic — verifies the GA4 Measurement Protocol wiring end to end.
// POST /api/admin/ga4-test
// Header: X-Admin-Key: <ADMIN_SECRET>
// Body: { email?: string, event?: string }
//
// Sends the event twice: once to GA4's /debug/mp/collect (which returns
// validationMessages explaining exactly what is wrong with a payload) and once
// to the real /mp/collect so it shows up in Realtime. The live endpoint always
// returns 204 even for invalid payloads, which is why the debug pass exists.
//
// Delete this handler and its route once GA4 tracking is confirmed.

import { ga4IdentityForEmail } from '../services/ga4.js';

export async function handleAdminGa4Test(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const adminKey = request.headers.get('X-Admin-Key');
  if (!adminKey || adminKey !== (env.ADMIN_SECRET || env.ADMIN_KEY)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const email = body.email || 'ga4-test@consentbit.com';
  const eventName = body.event || 'ga4_connection_test';

  const measurementId = env.GA4_MEASUREMENT_ID;
  const apiSecret = env.GA4_API_SECRET;

  // Report config state before attempting anything — a missing secret is the
  // single most common reason events silently never arrive.
  const config = {
    measurement_id: measurementId || null,
    measurement_id_set: Boolean(measurementId),
    api_secret_set: Boolean(apiSecret),
    api_secret_length: apiSecret ? String(apiSecret).length : 0,
  };

  if (!measurementId || !apiSecret) {
    return Response.json({
      ok: false,
      reason: 'GA4_MEASUREMENT_ID or GA4_API_SECRET is not set on this worker env',
      config,
    }, { status: 200 });
  }

  const identity = await ga4IdentityForEmail(email);
  const payload = {
    client_id: identity.clientId,
    user_id: identity.userId,
    events: [
      {
        name: eventName,
        params: {
          platform: 'webapp',
          source: 'admin_ga4_test',
          engagement_time_msec: 1,
          // Makes this specific event visible in GA4 DebugView, unlike the
          // normal server-side events which do not set it.
          debug_mode: true,
        },
      },
    ],
  };

  const qs = `measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  let validation = null;
  let debugStatus = null;
  try {
    const debugRes = await fetch(`https://www.google-analytics.com/debug/mp/collect?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    debugStatus = debugRes.status;
    validation = await debugRes.json().catch(() => null);
  } catch (e) {
    validation = { error: e?.message };
  }

  let liveStatus = null;
  try {
    const liveRes = await fetch(`https://www.google-analytics.com/mp/collect?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    liveStatus = liveRes.status;
  } catch (e) {
    liveStatus = `error: ${e?.message}`;
  }

  const messages = validation?.validationMessages ?? [];
  const valid = Array.isArray(messages) && messages.length === 0;

  return Response.json({
    ok: valid && liveStatus === 204,
    config,
    event_name: eventName,
    identity: { client_id: identity.clientId, user_id_prefix: identity.userId.slice(0, 12) },
    debug_endpoint: { status: debugStatus, validationMessages: messages },
    live_endpoint: { status: liveStatus, expected: 204 },
    hint: valid
      ? 'Payload is valid. Check GA4 Realtime and DebugView for the event within ~30s.'
      : 'GA4 rejected the payload — see validationMessages above.',
  });
}
