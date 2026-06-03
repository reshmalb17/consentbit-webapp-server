// One-time backfill: send app_installed + $identify + $create_alias to PostHog
// for all Webflow sites created in the last N days.
// POST /api/admin/backfill-posthog
// Body: { adminKey, days: 30 }

import { capturePostHogEvent, identifyPostHogPerson } from '../services/posthog.js';

export async function handleAdminBackfillPosthog(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const adminKey = request.headers.get('X-Admin-Key');
  if (!adminKey || adminKey !== (env.ADMIN_SECRET || env.ADMIN_KEY)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const days = Math.min(parseInt(body.days || '30', 10) || 30, 180);
  const platform = body.platform === 'framer' ? 'framer' : 'webflow';
  const db = env.CONSENT_WEBAPP;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all sites for the given platform created within the window
  const rows = await db.prepare(`
    SELECT
      s.id        AS siteId,
      s.domain,
      s.platformSiteId AS wfSiteId,
      s.createdAt,
      o.id        AS orgId,
      u.email
    FROM Site s
    JOIN Organization o ON o.id = s.organizationId
    JOIN OrganizationMember om ON om.organizationId = o.id
    JOIN User u ON u.id = om.userId
    WHERE s.platform = ?2
      AND s.createdAt >= ?1
      AND u.email NOT LIKE '%@seattlenewmedia.com'
    ORDER BY s.createdAt ASC
  `).bind(cutoff, platform).all();

  const sites = rows?.results || [];
  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of sites) {
    try {
      // Look up current subscription for this org from D1
      const sub = await db.prepare(`
        SELECT status, planId, planid, interval, cancelAtPeriodEnd, createdAt
        FROM Subscription
        WHERE organizationId = ?1
        ORDER BY updatedAt DESC LIMIT 1
      `).bind(row.orgId).first().catch(() => null);

      const subStatus = sub?.status || 'none';
      const planId = sub?.planId || sub?.planid || null;
      const interval = sub?.interval || null;

      // Send app_installed
      await capturePostHogEvent(env, row.orgId, 'app_installed', {
        platform,
        domain: row.domain,
        site_id: row.siteId,
        wf_site_id: row.wfSiteId || null,
        backfilled: true,
      });

      // Send paid_plan_activated if they have/had a subscription
      if (sub && ['active', 'trialing', 'past_due'].includes(subStatus)) {
        await capturePostHogEvent(env, row.orgId, 'paid_plan_activated', {
          status: subStatus,
          plan: planId,
          interval,
          platform,
          site_id: row.siteId,
          backfilled: true,
        });
      }

      // Set correct person properties including real subscription status
      await identifyPostHogPerson(env, row.orgId, {
        email: row.email,
        platform,
        subscription_status: subStatus,
        plan_tier: planId || 'free',
        did_install_app: true,
        installed_at: row.createdAt,
        did_convert_to_paid: ['active', 'past_due'].includes(subStatus),
        did_start_trial: subStatus === 'trialing' || ['active', 'past_due', 'canceled'].includes(subStatus),
        lifecycle_stage: subStatus === 'active' ? 'active'
          : subStatus === 'trialing' ? 'trialing'
          : subStatus === 'canceled' ? 'canceled'
          : 'installed',
      });

      // Alias email ↔ orgId
      await capturePostHogEvent(env, row.email, '$create_alias', { alias: row.orgId });

      sent++;
    } catch (e) {
      failed++;
      errors.push({ orgId: row.orgId, domain: row.domain, error: e?.message });
    }
  }

  return Response.json({
    success: true,
    platform,
    days,
    total: sites.length,
    sent,
    failed,
    ...(errors.length ? { errors } : {}),
  });
}
