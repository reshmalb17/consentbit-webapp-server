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
  const platform = ['framer', 'webapp'].includes(body.platform) ? body.platform : 'webflow';
  const db = env.CONSENT_WEBAPP;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // For webapp: users who signed up directly (platform IS NULL or 'webapp')
  // For webflow/framer: filter by platform column
  const isWebapp = platform === 'webapp';
  const rows = await db.prepare(isWebapp ? `
    SELECT
      s.id        AS siteId,
      s.domain,
      NULL        AS wfSiteId,
      u.createdAt,
      o.id        AS orgId,
      u.email
    FROM User u
    JOIN OrganizationMember om ON om.userId = u.id
    JOIN Organization o ON o.id = om.organizationId
    LEFT JOIN Site s ON s.organizationId = o.id
    WHERE u.createdAt >= ?1
      AND u.email NOT LIKE '%@seattlenewmedia.com'
      AND (u.passwordHash NOT LIKE 'webflow:%' AND u.passwordHash NOT LIKE 'framer:%')
    GROUP BY o.id
    ORDER BY u.createdAt ASC
  ` : `
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
  `).bind(...(isWebapp ? [cutoff] : [cutoff, platform])).all();

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

      // Webapp uses email as distinct_id (matches client-side); webflow/framer use orgId
      const distinctId = isWebapp ? row.email : row.orgId;
      const eventName = isWebapp ? 'account_created' : 'app_installed';

      await capturePostHogEvent(env, distinctId, eventName, {
        platform,
        domain: row.domain,
        site_id: row.siteId,
        ...(isWebapp ? {} : { wf_site_id: row.wfSiteId || null }),
        backfilled: true,
      });

      // Send paid_plan_activated if they have/had a subscription
      if (sub && ['active', 'trialing', 'past_due'].includes(subStatus)) {
        await capturePostHogEvent(env, distinctId, 'paid_plan_activated', {
          status: subStatus,
          plan: planId,
          interval,
          platform,
          site_id: row.siteId,
          backfilled: true,
        });
      }

      // Set person properties with real subscription status
      await identifyPostHogPerson(env, distinctId, {
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

      // Alias email ↔ orgId so server events and client events merge into one person
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
