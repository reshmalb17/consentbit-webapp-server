// handlers/scheduledScan.js
import { ensureSchema, getScheduledScans, createScheduledScan, deleteScheduledScan } from '../services/db.js';

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
