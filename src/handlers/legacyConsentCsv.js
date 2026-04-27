// handlers/legacyConsentCsv.js
import { getSessionById } from '../services/db.js';
import { buildSearchKeys, getConsentRowsFromR2, getConsentRowsFromKV } from './legacyConsentHelpers.js';
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

  const site = await db
    .prepare(
      `SELECT s.id, s.domain, s.platformSiteId as platformsiteid, s.legacySource
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerUserId
       WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2 AND s.isLegacy = 1`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);

  if (!site) return new Response('Legacy site not found', { status: 404 });

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  const kv = env.WEBFLOW_AUTHENTICATION;
  const r2 = env.R2;

  const searchKeys = await buildSearchKeys(kv, platformSiteId, site.domain);

  let entries = r2 ? await getConsentRowsFromR2(r2, searchKeys) : [];
  if (entries.length === 0 && platformSiteId && kv) {
    entries = await getConsentRowsFromKV(kv, platformSiteId);
  }

  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');
  if (year && month) {
    const paddedMonth = month.padStart(2, '0');
    entries = entries.filter((e) => {
      const ts = e.timestamp || e.preferences?.lastUpdated || e.metadata?.timestamp;
      if (!ts) return false;
      const d = new Date(ts);
      return String(d.getFullYear()) === String(year) && String(d.getMonth() + 1).padStart(2, '0') === paddedMonth;
    });
  }

  entries.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

  // PDF links go directly to the worker (token handles auth — no proxy/cookie needed)
  const workerOrigin = new URL(request.url).origin;

  const headers = ['#', 'Visitor ID', 'Timestamp (UTC)', 'Status', 'Banner Type', 'Country', 'Region', 'IP Address', 'User Agent', 'Necessary', 'Analytics', 'Marketing', 'Personalization', 'Do Not Share', 'Do Not Sell', 'Download PDF'];

  const headerRow = `<Row>${headers.map(h => `<Cell ss:StyleID="header"><Data ss:Type="String">${x(h)}</Data></Cell>`).join('')}</Row>`;

  const dataRows = await Promise.all(entries.map(async (entry, i) => {
    const p = entry.preferences || {};
    const meta = entry.metadata || {};
    const isCcpa = entry.bannerType === 'CCPA' || entry.lawType === 'CCPA';
    const hasMarketing = p.marketing || p.Marketing;
    const hasAnalytics = p.analytics || p.Analytics;
    const hasPersonalization = p.personalization || p.Personalization;
    const isAccepted = entry.action === 'acceptance' || !!(hasAnalytics || hasMarketing || hasPersonalization);
    const doNotShare = p.doNotShare ?? p.donotshare;
    const doNotSell = p.doNotSell ?? p.donotselldata;
    const visitorId = entry._visitorId || entry.visitorId || '';
    const token = await createDownloadToken(env.JWT_SECRET, siteId, visitorId);
    const pdfUrl = `${workerOrigin}/api/legacy-consent-pdf?siteId=${encodeURIComponent(siteId)}&visitorId=${encodeURIComponent(visitorId)}&token=${encodeURIComponent(token)}`;

    return `<Row>
      ${cell(i + 1)}
      ${cell(visitorId)}
      ${cell(entry.timestamp || '')}
      ${cell(isAccepted ? 'Accepted' : 'Rejected')}
      ${cell(entry.bannerType || entry.lawType || 'GDPR')}
      ${cell(entry.country || meta.country || '')}
      ${cell(entry.state || meta.state || '')}
      ${cell(meta.ip || p.ip || '')}
      ${cell(meta.userAgent || '')}
      ${cell(isCcpa ? '' : (Boolean(p.necessary ?? true) ? 'Yes' : 'No'))}
      ${cell(isCcpa ? '' : (hasAnalytics ? 'Yes' : 'No'))}
      ${cell(isCcpa ? '' : (hasMarketing ? 'Yes' : 'No'))}
      ${cell(isCcpa ? '' : (hasPersonalization ? 'Yes' : 'No'))}
      ${cell(isCcpa ? (doNotShare !== undefined ? (doNotShare ? 'Yes' : 'No') : '') : '')}
      ${cell(isCcpa ? (doNotSell !== undefined ? (doNotSell ? 'Yes' : 'No') : '') : '')}
      ${linkCell(pdfUrl, 'Download PDF')}
    </Row>`;
  }));

  const date = new Date().toISOString().split('T')[0];
  const suffix = (year && month) ? `_${year}-${month.padStart(2, '0')}` : `_${date}`;
  const filename = `legacy_consent_${siteId}${suffix}.xls`;

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
    <Style ss:ID="link">
      <Font ss:Color="#1D4ED8" ss:Underline="Single"/>
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
