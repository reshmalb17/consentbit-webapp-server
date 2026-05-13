// src/handlers/adminResetLegacyWebflow.js
// Deletes all Webflow-migrated legacy records from D1 and strips migration
// fields from ACTIVE_SITES_CONSENTBIT + WEBFLOW_AUTHENTICATION KV so the
// migration can be re-run cleanly (e.g. after adding userEmail to the KV write).
//
// Supports ?dryRun=true — reports what would be deleted without touching data.
// DELETE /api/admin/reset-legacy-webflow
import { checkAdminAuth } from '../utils/adminAuth.js';

// Tables with a siteId FK — deleted first before Site row is removed.
const SITE_CHILD_TABLES = [
  'BannerCustomization',
  'Consent',
  'Cookie',
  'Script',
  'ScanHistory',
  'ScanUsage',
  'ScheduledScan',
  'PageviewUsage',
  'CustomCookieRule',
  'Feedback',
  'LicenseActivation',
  'Subscription',
  'PaymentEvent',
  'ProcessedPaymentIntent',
  'SubscriptionQueue',
];

export async function handleAdminResetLegacyWebflow(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  // ── 1. Collect all legacy Webflow sites ──────────────────────────────────
  const sites = await db.prepare(
    `SELECT s.id AS siteId, s.domain, s.platformSiteId AS wfSiteId,
            s.organizationId,
            o.ownerUserId AS userId,
            u.email
     FROM Site s
     JOIN Organization o ON s.organizationId = o.id
     JOIN User u ON o.ownerUserId = u.id
     WHERE s.isLegacy = 1 AND s.legacySource = 'webflow'`
  ).all();

  const rows = sites.results ?? [];

  if (rows.length === 0) {
    return Response.json({ success: true, dryRun, deleted: 0, message: 'No legacy Webflow sites found.' });
  }

  const report = [];

  for (const row of rows) {
    const { siteId, domain, wfSiteId, organizationId, userId, email } = row;
    const entry = { siteId, domain, wfSiteId, organizationId, userId, email };

    if (dryRun) {
      report.push({ ...entry, status: 'dry-run' });
      continue;
    }

    try {
      // ── 2a. Delete child rows referencing this site ──────────────────────
      for (const table of SITE_CHILD_TABLES) {
        try {
          await db.prepare(`DELETE FROM ${table} WHERE siteId = ?1`).bind(siteId).run();
        } catch (_) {
          // Column may be named differently in some tables — best effort
        }
      }

      // ── 2b. Delete the Site row itself ───────────────────────────────────
      await db.prepare('DELETE FROM Site WHERE id = ?1').bind(siteId).run();

      // ── 2c. Delete Organization if it owns no other sites ────────────────
      const otherSites = await db.prepare(
        'SELECT id FROM Site WHERE organizationId = ?1 LIMIT 1'
      ).bind(organizationId).first();
      if (!otherSites) {
        await db.prepare('DELETE FROM OrganizationMember WHERE organizationId = ?1').bind(organizationId).run();
        await db.prepare('DELETE FROM Organization WHERE id = ?1').bind(organizationId).run();

        // ── 2d. Delete User if legacy and owns no other organizations ──────
        const otherOrgs = await db.prepare(
          'SELECT id FROM Organization WHERE ownerUserId = ?1 LIMIT 1'
        ).bind(userId).first();
        const userRow = await db.prepare(
          'SELECT isLegacy FROM User WHERE id = ?1'
        ).bind(userId).first();
        if (!otherOrgs && userRow?.isLegacy === 1) {
          await db.prepare('DELETE FROM Session WHERE userId = ?1').bind(userId).run();
          await db.prepare('DELETE FROM EmailVerificationCode WHERE email = ?1').bind(email).run();
          await db.prepare('DELETE FROM User WHERE id = ?1').bind(userId).run();
        }
      }

      // ── 3a. Strip migration fields from ACTIVE_SITES_CONSENTBIT ─────────
      const activeKv = env.ACTIVE_SITES_CONSENTBIT;
      if (activeKv && domain) {
        try {
          const raw = await activeKv.get(domain, { type: 'json' });
          if (raw) {
            const { webappSiteId: _a, cdnScriptId: _b, orgId: _c, userEmail: _d, ...stripped } = raw;
            await activeKv.put(domain, JSON.stringify(stripped));
          }
        } catch (_) {}
      }

      // ── 3b. Strip migration fields from WEBFLOW_AUTHENTICATION ───────────
      const authKv = env.WEBFLOW_AUTHENTICATION;
      if (authKv && wfSiteId) {
        try {
          const raw = await authKv.get(wfSiteId);
          if (raw) {
            const existing = typeof raw === 'string' ? JSON.parse(raw) : raw;
            const {
              cdnScriptId: _a, webappSiteId: _b, organizationId: _c,
              userId: _d, isLegacyUser: _e, upgradedThroughApp: _f,
              userEmail: _g,
              ...stripped
            } = existing;
            await authKv.put(wfSiteId, JSON.stringify(stripped));
          }
        } catch (_) {}
      }

      report.push({ ...entry, status: 'deleted' });
    } catch (err) {
      report.push({ ...entry, status: 'error', reason: err?.message });
    }
  }

  const deleted = report.filter(r => r.status === 'deleted').length;
  const errors  = report.filter(r => r.status === 'error').length;

  return Response.json({ success: true, dryRun, total: rows.length, deleted, errors, results: report });
}
