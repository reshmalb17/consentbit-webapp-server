// handlers/legacyConsentCsv.js
import { getSessionById } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * GET /api/legacy-consent-csv?siteId=...
 *
 * Fetches consent data and returns a CSV for a legacy site.
 * Generates the CSV directly from the same data as the consent logs endpoint.
 */
export async function handleLegacyConsentCsv(request, env) {
  const db = env.CONSENT_WEBAPP;

  const sid = getSessionIdFromCookie(request);
  if (!sid) return new Response('Unauthorized', { status: 401 });

  const session = await getSessionById(db, sid).catch(() => null);
  if (!session) return new Response('Unauthorized', { status: 401 });
  const userId = session.userId ?? session.user_id;

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  if (!siteId) return new Response('siteId required', { status: 400 });

  // Verify ownership + legacy flag
  const site = await db
    .prepare(
      `SELECT s.id, s.domain, s.legacySource
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerId
       WHERE s.id = ?1 AND u.id = ?2 AND s.isLegacy = 1`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);

  if (!site) return new Response('Legacy site not found', { status: 404 });

  const domain = site.domain || '';
  const cbServerBase = (env.CB_SERVER_BASE_URL || 'https://app.consentbit.com').replace(/\/$/, '');
  const secret = env.LEGACY_API_SECRET || '';

  // Fetch raw visitor data from cb-server
  const params = new URLSearchParams({ domain });
  const cbUrl = `${cbServerBase}/api/internal/legacy-consent-logs?${params}`;

  let cbData;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(cbUrl, { headers: { 'X-Internal-Token': secret }, signal: controller.signal });
      cbData = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return new Response('Failed to fetch legacy consent data', { status: 502 });
  }

  const rows = cbData?.rows || [];

  function esc(v) {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('\n') || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  const headers = ['#', 'Timestamp (UTC)', 'Status', 'Banner Type', 'Country', 'IP Address', 'Necessary', 'Analytics', 'Marketing', 'Personalization', 'Do Not Share', 'Do Not Sell'];

  const csvRows = rows.map((row, i) => {
    const p = row.preferences || {};
    return [
      i + 1,
      row.timestamp || '',
      row.status || '',
      row.bannerType || '',
      row.country || '',
      row.ipAddress || '',
      p.necessary ? 'Yes' : 'No',
      p.analytics ? 'Yes' : 'No',
      p.marketing ? 'Yes' : 'No',
      p.personalization ? 'Yes' : 'No',
      p.doNotShare !== undefined ? (p.doNotShare ? 'Yes' : 'No') : '',
      p.doNotSell !== undefined ? (p.doNotSell ? 'Yes' : 'No') : '',
    ].map(esc).join(',');
  });

  const csv = [headers.map(esc).join(','), ...csvRows].join('\n');
  const date = new Date().toISOString().split('T')[0];
  const filename = `legacy_consent_${siteId}_${date}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
