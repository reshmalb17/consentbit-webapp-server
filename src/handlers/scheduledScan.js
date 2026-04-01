// handlers/scheduledScan.js
import {
  ensureSchema,
  getScheduledScans,
  createScheduledScan,
  deleteScheduledScan,
  getSiteById,
  getScanUsageForSite,
  getEffectivePlanForOrganization,
} from '../services/db.js';

export async function handleScheduledScan(request, env) {
  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const siteId = url.searchParams.get('siteId');

    if (!siteId) {
      return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    }

    try {
      const scheduledScans = await getScheduledScans(db, siteId);
      return Response.json({ success: true, scheduledScans });
    } catch (err) {
      console.error('[ScheduledScan] Error fetching:', err);
      return Response.json(
        { success: false, error: err?.message || 'Failed to fetch scheduled scans' },
        { status: 500 }
      );
    }
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const { siteId, scheduledAt, frequency = 'once' } = body;

    if (!siteId || !scheduledAt) {
      return Response.json(
        { success: false, error: 'siteId and scheduledAt are required' },
        { status: 400 }
      );
    }

    // Check scan limit before allowing a new scheduled scan to be created
    try {
      const site = await getSiteById(db, siteId);
      const organizationId = site ? (site.organizationId ?? site.organizationid) : null;
      if (organizationId) {
        const [{ plan }, scanUsage] = await Promise.all([
          getEffectivePlanForOrganization(db, organizationId, env),
          getScanUsageForSite(db, siteId),
        ]);
        const scansLimit = plan ? (plan.scansIncluded ?? plan.scansincluded ?? 100) : 100;
        if (scanUsage.scanCount >= scansLimit) {
          return Response.json(
            {
              success: false,
              error: `Scan limit reached (${scansLimit} scans/month for this site). Upgrade your plan to schedule more scans.`,
              code: 'SCAN_LIMIT_REACHED',
            },
            { status: 402 }
          );
        }
      }
    } catch (limitErr) {
      console.warn('[ScheduledScan] Limit check failed:', limitErr?.message);
    }

    try {
      const result = await createScheduledScan(db, { siteId, scheduledAt, frequency });
      
      if (!result.success) {
        return Response.json(
          { success: false, error: result.error || 'Failed to create scheduled scan' },
          { status: 500 }
        );
      }

      return Response.json({ success: true, scheduledScanId: result.id });
    } catch (err) {
      console.error('[ScheduledScan] Error creating:', err);
      return Response.json(
        { success: false, error: err?.message || 'Failed to create scheduled scan' },
        { status: 500 }
      );
    }
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (!id) {
      return Response.json({ success: false, error: 'id is required' }, { status: 400 });
    }

    try {
      const result = await deleteScheduledScan(db, id);
      
      if (!result.success) {
        return Response.json(
          { success: false, error: result.error || 'Failed to delete scheduled scan' },
          { status: 500 }
        );
      }

      return Response.json({ success: true });
    } catch (err) {
      console.error('[ScheduledScan] Error deleting:', err);
      return Response.json(
        { success: false, error: err?.message || 'Failed to delete scheduled scan' },
        { status: 500 }
      );
    }
  }

  return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
}
