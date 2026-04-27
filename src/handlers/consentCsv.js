// handlers/consentCsv.js
import { getSessionById } from '../services/db.js';
import { createDownloadToken } from '../utils/signedToken.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function x(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cell(value) {
  return `<Cell><Data ss:Type="String">${x(value)}</Data></Cell>`;
}

function linkCell(url, text) {
  return `<Cell ss:HRef="${x(url)}"><Data ss:Type="String">${x(text)}</Data></Cell>`;
}

function yesNo(val) {
  if (val === undefined || val === null) return '—';
  return val ? 'Yes' : 'No';
}

/**
 * GET /api/consent-csv?siteId=...&year=...&month=...
 * Exports ALL consent records as a SpreadsheetML .xls file with clickable PDF links.
 */
export async function handleConsentCsv(request, env) {
  const db = env.CONSENT_WEBAPP;

  const sid = getSessionIdFromCookie(request);
  if (!sid) return new Response('Unauthorized', { status: 401 });

  const session = await getSessionById(db, sid).catch(() => null);
  if (!session) return new Response('Unauthorized', { status: 401 });
  const userId = session.userId ?? session.user_id;

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  if (!siteId) return new Response('siteId required', { status: 400 });

  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');

  const site = await db
    .prepare(
      `SELECT s.id, s.domain
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerUserId
       WHERE s.id = ?1 AND u.id = ?2 AND (s.isLegacy = 0 OR s.isLegacy IS NULL)`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);

  if (!site) return new Response('Site not found', { status: 404 });

  const hasDateFilter = year && month;
  const paddedMonth = hasDateFilter ? month.padStart(2, '0') : '';

  const { results: rows } = hasDateFilter
    ? await db
        .prepare(
          `SELECT id, ipAddress, userAgent, country, region, createdAt, regulation, bannerType, consentMethod, status, consent_categories
           FROM Consent WHERE siteId = ?1
             AND strftime('%Y', createdAt) = ?2
             AND strftime('%m', createdAt) = ?3
           ORDER BY createdAt DESC`,
        )
        .bind(siteId, year, paddedMonth)
        .all()
    : await db
        .prepare(
          `SELECT id, ipAddress, userAgent, country, region, createdAt, regulation, bannerType, consentMethod, status, consent_categories
           FROM Consent WHERE siteId = ?1 ORDER BY createdAt DESC`,
        )
        .bind(siteId)
        .all();

  // PDF links go directly to the worker (token handles auth — no proxy/cookie needed)
  const workerOrigin = new URL(request.url).origin;

  const headers = ['#', 'Consent ID', 'Timestamp (UTC)', 'Status', 'Regulation', 'Country', 'Region', 'IP Address', 'User Agent', 'Necessary', 'Analytics', 'Marketing', 'Preferences', 'Do Not Sell', 'Download PDF'];

  const headerRow = `<Row>${headers.map(h => `<Cell ss:StyleID="header"><Data ss:Type="String">${x(h)}</Data></Cell>`).join('')}</Row>`;

  const dataRows = await Promise.all((rows || []).map(async (row, i) => {
    let cats = null;
    if (row.consent_categories) {
      try {
        const parsed = typeof row.consent_categories === 'string' ? JSON.parse(row.consent_categories) : row.consent_categories;
        cats = parsed && typeof parsed.categories === 'object' ? parsed.categories : parsed;
      } catch { /* ignore */ }
    }

    const isCcpa = (row.regulation || '').toLowerCase() === 'ccpa' || (cats && cats.ccpa !== undefined);
    const isAccepted = (row.status || '').toLowerCase() === 'given';
    const token = await createDownloadToken(env.JWT_SECRET, siteId, row.id || '');
    const pdfUrl = `${workerOrigin}/api/consent-pdf?siteId=${encodeURIComponent(siteId)}&consentId=${encodeURIComponent(row.id || '')}&token=${encodeURIComponent(token)}`;

    return `<Row>
      ${cell(i + 1)}
      ${cell(row.id || '')}
      ${cell(row.createdAt ? new Date(row.createdAt).toUTCString() : '')}
      ${cell(isAccepted ? 'Accepted' : 'Rejected')}
      ${cell((row.regulation || 'gdpr').toUpperCase())}
      ${cell(row.country || '')}
      ${cell(row.region || '')}
      ${cell(row.ipAddress || '')}
      ${cell(row.userAgent || '')}
      ${cell(isCcpa ? '' : yesNo(cats?.essential ?? true))}
      ${cell(isCcpa ? '' : yesNo(cats?.analytics))}
      ${cell(isCcpa ? '' : yesNo(cats?.marketing))}
      ${cell(isCcpa ? '' : yesNo(cats?.preferences))}
      ${cell(isCcpa ? yesNo(cats?.ccpa?.doNotSell) : '')}
      ${linkCell(pdfUrl, 'Download PDF')}
    </Row>`;
  }));

  const date = new Date().toISOString().split('T')[0];
  const filename = `consent_${siteId}_${date}${hasDateFilter ? `_${year}-${paddedMonth}` : ''}.xls`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="header">
      <Font ss:Bold="1"/>
      <Interior ss:Color="#E6F1FD" ss:Pattern="Solid"/>
    </Style>
  </Styles>
  <Worksheet ss:Name="Consent Logs">
    <Table>
      ${headerRow}
      ${dataRows.join('\n')}
    </Table>
  </Worksheet>
</Workbook>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.ms-excel',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
