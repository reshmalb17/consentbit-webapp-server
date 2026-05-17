// handlers/legacyConsentPdfFramer.js
//
// Framer variant of legacyConsentPdf.js. Reads the consent array from
// CONSENT_STORE_FRAMER (key = platformSiteId), finds the entry matching
// visitorId, and renders a PDF with the same layout as the Webflow legacy PDF.

import puppeteer from '@cloudflare/puppeteer';
import { getSessionById } from '../services/db.js';
import { verifyDownloadToken } from '../utils/signedToken.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function yesNo(val) {
  if (val === undefined || val === null) return '—';
  return val ? 'Yes' : 'No';
}

async function getFramerConsentRows(kv, platformSiteId) {
  if (!kv || !platformSiteId) return [];
  try {
    const raw = await kv.get(`consent:${platformSiteId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => ({
      ...entry,
      _visitorId: entry._visitorId || entry.visitorId || null,
    }));
  } catch (err) {
    console.error('[legacyConsentPdfFramer] KV parse failed', err?.message);
    return [];
  }
}

function buildHtml(entry, siteDomain) {
  const p = entry.preferences || {};
  const meta = entry.metadata || {};
  const isCcpa = entry.bannerType === 'CCPA' || entry.lawType === 'CCPA' || p.bannerType === 'CCPA';
  const hasMarketing = p.marketing || p.Marketing;
  const hasAnalytics = p.analytics || p.Analytics;
  const hasPersonalization = p.personalization || p.Personalization;
  const isAccepted = (p.action === 'acceptance') || (entry.action === 'acceptance') || !!(hasAnalytics || hasMarketing || hasPersonalization);
  const doNotShare = p.doNotShare ?? p.donotshare;
  const doNotSell = p.doNotSell ?? p.donotselldata;
  const ts = entry.timestamp ? new Date(entry.timestamp).toUTCString() : '—';
  const visitorId = entry._visitorId || entry.visitorId || '—';

  const cookieRows = Array.isArray(entry.expectedCookies) && entry.expectedCookies.length > 0
    ? entry.expectedCookies.map((c) => `
        <tr>
          <td>${c.name || '—'}</td>
          <td>${c.toolname || c.dataCategory || '—'}</td>
          <td>${c.duration || '—'}</td>
          <td>${c.description || '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="color:#6b7280;text-align:center">No cookie details recorded</td></tr>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; padding: 40px; background: #fff; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #007AFF; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 22px; color: #007AFF; }
  .header .meta { font-size: 12px; color: #6b7280; text-align: right; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; }
  .badge-given { background: #dcfce7; color: #15803d; }
  .badge-rejected { background: #fee2e2; color: #b91c1c; }
  .badge-gdpr { background: #dbeafe; color: #1d4ed8; }
  .badge-ccpa { background: #fef9c3; color: #a16207; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; }
  .field { padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
  .field .label { font-size: 11px; color: #9ca3af; margin-bottom: 2px; }
  .field .value { font-size: 13px; color: #111827; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f9fafb; text-align: left; padding: 8px 10px; font-weight: 600; color: #374151; border-bottom: 1px solid #e5e7eb; }
  td { padding: 8px 10px; border-bottom: 1px solid #f3f4f6; color: #374151; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Consent Record</h1>
      <p style="font-size:13px;color:#374151;margin-top:4px">${siteDomain}</p>
    </div>
    <div class="meta">
      <div>Generated: ${new Date().toUTCString()}</div>
      <div style="margin-top:4px">
        <span class="badge ${isAccepted ? 'badge-given' : 'badge-rejected'}">${isAccepted ? 'Consent Given' : 'Consent Rejected'}</span>
        &nbsp;
        <span class="badge ${isCcpa ? 'badge-ccpa' : 'badge-gdpr'}">${isCcpa ? 'CCPA' : 'GDPR'}</span>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Visitor Information</h2>
    <div class="grid">
      <div class="field"><div class="label">Visitor ID</div><div class="value">${visitorId}</div></div>
      <div class="field"><div class="label">Timestamp (UTC)</div><div class="value">${ts}</div></div>
      <div class="field"><div class="label">IP Address</div><div class="value">${meta.ip || p.ip || '—'}</div></div>
      <div class="field"><div class="label">Country</div><div class="value">${entry.country || meta.country || '—'}</div></div>
      <div class="field"><div class="label">Region</div><div class="value">${entry.state || meta.state || '—'}</div></div>
      <div class="field"><div class="label">Platform</div><div class="value">${meta.platform || '—'}</div></div>
      <div class="field"><div class="label">Language</div><div class="value">${meta.language || '—'}</div></div>
      <div class="field"><div class="label">Timezone</div><div class="value">${meta.timezone || '—'}</div></div>
      <div class="field" style="grid-column:1/-1"><div class="label">User Agent</div><div class="value">${meta.userAgent || '—'}</div></div>
    </div>
  </div>

  <div class="section">
    <h2>Consent Preferences</h2>
    <div class="grid">
      ${isCcpa ? `
      <div class="field"><div class="label">Do Not Share</div><div class="value">${yesNo(doNotShare)}</div></div>
      <div class="field"><div class="label">Do Not Sell</div><div class="value">${yesNo(doNotSell)}</div></div>
      ` : `
      <div class="field"><div class="label">Necessary</div><div class="value">${yesNo(p.necessary ?? true)}</div></div>
      <div class="field"><div class="label">Analytics</div><div class="value">${yesNo(hasAnalytics)}</div></div>
      <div class="field"><div class="label">Marketing</div><div class="value">${yesNo(hasMarketing)}</div></div>
      <div class="field"><div class="label">Personalization</div><div class="value">${yesNo(hasPersonalization)}</div></div>
      `}
    </div>
  </div>

  <div class="section">
    <h2>Cookies Set</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Category</th><th>Duration / Expires</th><th>Description</th></tr>
      </thead>
      <tbody>${cookieRows}</tbody>
    </table>
  </div>

  <div class="footer">ConsentBit &mdash; Consent Record for ${siteDomain} &mdash; Visitor ${visitorId}</div>
</body>
</html>`;
}

/**
 * GET /api/legacy-consent-pdf-framer?siteId=...&visitorId=...
 * Same auth model as legacyConsentPdf.js (signed token OR session cookie).
 * Pulls consent array from CONSENT_STORE_FRAMER.
 */
export async function handleLegacyConsentPdfFramer(request, env) {
  const db = env.CONSENT_WEBAPP;

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  const visitorId = url.searchParams.get('visitorId');
  const token = url.searchParams.get('token');
  if (!siteId || !visitorId) return new Response('siteId and visitorId required', { status: 400 });

  let userId = null;
  if (token) {
    const valid = await verifyDownloadToken(env.JWT_SECRET, token, siteId, visitorId);
    if (!valid) return new Response('Link expired or invalid', { status: 401 });
  } else {
    const sid = getSessionIdFromCookie(request);
    if (!sid) return new Response('Unauthorized', { status: 401 });
    const session = await getSessionById(db, sid).catch(() => null);
    if (!session) return new Response('Unauthorized', { status: 401 });
    userId = session.userId ?? session.user_id;
  }

  const site = await (userId
    ? db.prepare(
        `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid
         FROM Site s
         INNER JOIN Organization o ON o.id = s.organizationId
         INNER JOIN User u ON u.id = o.ownerUserId
         WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2`,
      ).bind(siteId, userId).first()
    : db.prepare(
        `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid
         FROM Site s WHERE (s.id = ?1 OR s.platformSiteId = ?1)`,
      ).bind(siteId).first()
  ).catch(() => null);

  if (!site) return new Response('Site not found', { status: 404 });

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  if (!platformSiteId) return new Response('Site missing platformSiteId', { status: 400 });

  const kv = env.CONSENT_STORE_FRAMER;
  if (!kv) return new Response('CONSENT_STORE_FRAMER KV not configured', { status: 503 });

  const entries = await getFramerConsentRows(kv, platformSiteId);
  const entry = entries.find((e) => (e._visitorId || e.visitorId) === visitorId);
  if (!entry) return new Response('Visitor not found', { status: 404 });

  const html = buildHtml(entry, site.domain || siteId);

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    await browser.close();

    const filename = `consent_${visitorId.slice(0, 8)}_${new Date().toISOString().split('T')[0]}.pdf`;
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[legacyConsentPdfFramer]', err?.message);
    return new Response('PDF generation failed', { status: 500 });
  }
}
