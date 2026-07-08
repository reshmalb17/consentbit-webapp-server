// POST /api/admin/test-scan-report
// Renders a stored cookie-scan report to PDF and emails it to an arbitrary
// address — for QA/testing only. Bypasses the emailed_at guard (force) and
// does NOT mark the scan as emailed, so the real user flow is unaffected.
//
// Body (JSON): { to: string, name?: string, scanId?: string }
//   - to:     required recipient email
//   - scanId: optional; defaults to the most recent scan_reports row
import { checkAdminAuth } from '../utils/adminAuth.js';
import { sendScanReportForId } from '../services/scanReport.js';

export async function handleAdminTestScanReport(request, env, ctx) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.COOKIE_SCANNER_DB;
  if (!db) return Response.json({ success: false, error: 'COOKIE_SCANNER_DB not bound' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const to = String(body?.to || '').trim();
  const name = String(body?.name || '').trim();
  let scanId = String(body?.scanId || '').trim();

  if (!to) return Response.json({ success: false, error: 'to (email) is required' }, { status: 400 });

  // Default to the most recent stored scan when no scanId is given.
  if (!scanId) {
    try {
      const row = await db
        .prepare(`SELECT id FROM scan_reports ORDER BY scan_date DESC LIMIT 1`)
        .first();
      scanId = row?.id ? String(row.id) : '';
    } catch (e) {
      return Response.json({ success: false, error: `lookup failed: ${e?.message}` }, { status: 500 });
    }
  }
  if (!scanId) return Response.json({ success: false, error: 'no scan_reports rows found' }, { status: 404 });

  // Render + send in the background so the response returns immediately.
  if (ctx?.waitUntil) {
    ctx.waitUntil(sendScanReportForId(env, { to, name, scanId, force: true }));
  } else {
    await sendScanReportForId(env, { to, name, scanId, force: true });
  }

  return Response.json({ success: true, to, scanId, note: 'render + send dispatched' });
}
