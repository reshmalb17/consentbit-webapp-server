// src/handlers/framerPublished.js
//
// POST /api/framer/published   body { webAppSiteId }   (Authorization: Bearer <plugin token>)
//   → 200 { success:true, welcomeSent:boolean }
//
// The Framer plugin calls this once the banner script has actually landed in the
// project's custom code (after the user confirmed the dialog). It replaces
// framer.consentbit.com /banner/save-2, which received the Framer project id and the
// site URLs on every publish (Marketplace review: minimum data). Here the plugin sends
// only our own site id; everything else is looked up on our side.
//
// Two jobs, both moved from /banner/save-2:
//   1. "You're live" email — once per site, paid sites only (same rule as before).
//      FramerLiveEmail is the claim table: INSERT OR IGNORE lets exactly one publish
//      win, so repeat or concurrent publishes never send a second email. Sites already
//      published under the old route (AUTH_STORE_FRAMER isPublished) were welcomed
//      there, so they are claimed without sending.
//   2. PostHog publish events — email as distinct id, same event names as before, but
//      no domain and no Framer project id.

import { resolveFramerSite, requireFramerRole } from '../services/framerAccess.js';
import { getSubscriptionBySiteId } from '../services/db.js';
import { capturePostHogEvent } from '../services/posthog.js';
import { sendFramerLiveEmail } from '../services/email.js';

const TAG = '[framer-published]';
const PUBLISH_ROLES = ['owner', 'admin', 'member'];

async function claimLiveEmail(db, siteId, email) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS FramerLiveEmail (
      siteId TEXT PRIMARY KEY,
      recipientEmail TEXT,
      sent INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  const res = await db
    .prepare('INSERT OR IGNORE INTO FramerLiveEmail (siteId, recipientEmail, createdAt) VALUES (?1, ?2, ?3)')
    .bind(siteId, email || null, new Date().toISOString())
    .run();
  return Number(res?.meta?.changes ?? 0) > 0;
}

async function readLegacyPublished(env, platformSiteId) {
  if (!env.AUTH_STORE_FRAMER || !platformSiteId) return false;
  try {
    const kv = await env.AUTH_STORE_FRAMER.get(String(platformSiteId), { type: 'json' });
    return kv?.isPublished === true;
  } catch (_) {
    return false;
  }
}

export async function handleFramerPublished(request, env, ctx) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database not available' }, { status: 503 });

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const webAppSiteId = String(body?.webAppSiteId || '').trim();
  if (!webAppSiteId) {
    return Response.json({ success: false, error: 'webAppSiteId is required' }, { status: 400 });
  }

  const site = await resolveFramerSite(db, webAppSiteId);
  const gate = await requireFramerRole(request, env, site, PUBLISH_ROLES);
  if (!gate.ok) return gate.res;

  // Owner gets the email, whoever published. Domain is only used inside the email.
  const owner = await db
    .prepare(
      `SELECT u.email, u.name, s.domain
         FROM Site s
         JOIN Organization o ON o.id = s.organizationId
         JOIN User u ON u.id = o.ownerUserId
        WHERE s.id = ?1
        LIMIT 1`,
    )
    .bind(site.id)
    .first()
    .catch(() => null);
  const ownerEmail = owner?.email ? String(owner.email).trim().toLowerCase() : null;

  const sub = await getSubscriptionBySiteId(db, site.id).catch(() => null);
  const planTier = sub ? String(sub.planId ?? sub.planid ?? 'paid').toLowerCase() : 'free';
  const host = String(owner?.domain || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  // Same rule as /banner/save-2: anything that isn't *.framer.app is a custom domain.
  const isCustomDomain = !!host && !/\.framer\.app$/i.test(host);

  let welcomeSent = false;
  if (sub && ownerEmail) {
    try {
      if (await claimLiveEmail(db, site.id, ownerEmail)) {
        if (await readLegacyPublished(env, site.platformSiteId)) {
          console.log(`${TAG} site=${site.id} already welcomed by the old route — claimed, not sent`);
        } else {
          sendFramerLiveEmail(env, ctx, { to: ownerEmail, name: owner?.name || '' });
          await db.prepare('UPDATE FramerLiveEmail SET sent = 1 WHERE siteId = ?1').bind(site.id).run();
          welcomeSent = true;
        }
      }
    } catch (e) {
      console.error(`${TAG} live email failed:`, e?.message || e);
    }
  }

  const analytics = (async () => {
    await capturePostHogEvent(env, gate.email, 'banner_customized', { platform: 'framer', setting_changed: 'multiple' });
    await capturePostHogEvent(
      env,
      gate.email,
      isCustomDomain ? 'banner_published_custom_domain' : 'banner_published_staging',
      { platform: 'framer', plan_tier: planTier },
    );
  })().catch((e) => console.warn(`${TAG} analytics failed:`, e?.message || e));
  if (ctx?.waitUntil) ctx.waitUntil(analytics);
  else await analytics;

  return Response.json({ success: true, welcomeSent });
}
