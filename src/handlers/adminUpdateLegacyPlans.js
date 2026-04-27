// POST /api/admin/update-legacy-plans
// Sets planType = 'basic' on all Subscription rows linked to legacy Sites.
import { checkAdminAuth } from '../utils/adminAuth.js';

export async function handleAdminUpdateLegacyPlans(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  const now = new Date().toISOString();

  // Find unique subscriptions linked to legacy organizations
  const toUpdate = await db.prepare(`
    SELECT sub.id, sub.planType, sub.organizationId, sub.stripeSubscriptionId
    FROM Subscription sub
    WHERE sub.planType != 'basic'
      AND sub.organizationId IN (
        SELECT DISTINCT organizationId FROM Site WHERE isLegacy = 1
      )
  `).all();

  const rows = toUpdate?.results || [];

  if (!dryRun && rows.length > 0) {
    await db.prepare(`
      UPDATE Subscription
      SET planType = 'basic', updatedAt = ?1
      WHERE planType != 'basic'
        AND organizationId IN (
          SELECT DISTINCT organizationId FROM Site WHERE isLegacy = 1
        )
    `).bind(now).run();
  }

  return Response.json({
    success: true,
    dryRun,
    updated: rows.length,
    subscriptions: rows,
  });
}
