// handlers/scanPending.js
// GET  /api/scan-pending?siteId=X  → { pending: bool }
// POST /api/scan-pending            → { siteId, action:'request'|'clear' }

import { ensureSchema } from '../services/db.js';
import { getSiteSubscriptionEnded, subscriptionEndedResponse } from '../services/siteSubscriptionEnded.js';

export async function handleScanPending(request, env) {
  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);

  const url = new URL(request.url);

  if (request.method === 'GET') {
    const siteId = (url.searchParams.get('siteId') || '').trim();
    if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

    const row = await db
      .prepare('SELECT pendingScan FROM Site WHERE id = ?1')
      .bind(siteId)
      .first();

    return Response.json({ success: true, pending: row?.pendingScan === 1 });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }

    const siteId = String(body?.siteId || '').trim();
    const action = String(body?.action || 'request').trim();
    if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

    if (action === 'request') {
      // Same gate as /api/scan-site. This queues a BROWSER scan — pendingScan=1 makes the
      // next visit to the site run a full cookie+script report — so leaving it open meant
      // an ended plan could still start scans by the other route, which is exactly what
      // happened: /api/scan-site returned 402 while this one returned 200.
      //
      // Only 'request' is gated. 'clear' below must stay open so a site can always cancel
      // a queued scan, and the GET is a read.
      const ended = await getSiteSubscriptionEnded(db, siteId);
      if (ended.ended) {
        console.warn('[ScanPending] blocked — subscription ended', { siteId, status: ended.status });
        return subscriptionEndedResponse('run');
      }

      await db.prepare('UPDATE Site SET pendingScan = 1, updatedAt = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), siteId)
        .run();
      return Response.json({ success: true });
    }

    if (action === 'clear') {
      await db.prepare('UPDATE Site SET pendingScan = 0, updatedAt = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), siteId)
        .run();
      return Response.json({ success: true });
    }

    return Response.json({ success: false, error: 'Unknown action' }, { status: 400 });
  }

  return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
}
