// handlers/consentPdf.js
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

function normalizeCategories(cats) {
  if (!cats || typeof cats !== 'object') return cats;
  return cats.categories && typeof cats.categories === 'object' ? cats.categories : cats;
}

function buildHtml(consent, cookies, customCookieRules, siteDomain) {
  const cats = normalizeCategories(consent.categories) || {};
  const isCcpa = consent.regulation === 'ccpa' || (cats.ccpa !== undefined);
  const isAccepted = consent.status === 'given';
  const ts = consent.createdAt ? new Date(consent.createdAt).toUTCString() : '—';

  // Filter cookies by accepted categories
  const acceptedSet = new Set();
  if (!isCcpa) {
    if (cats.essential) acceptedSet.add('essential');
    if (cats.analytics) acceptedSet.add('analytics');
    if (cats.marketing) acceptedSet.add('marketing');
    if (cats.preferences) acceptedSet.add('preferences');
  }

  const relevantCookies = isCcpa
    ? (cats.ccpa?.doNotSell === false ? cookies : [])
    : cookies.filter(c => acceptedSet.has((c.category || '').toLowerCase()) || (c.category || '').toLowerCase() === 'necessary');

  const relevantCustomRules = isCcpa
    ? (cats.ccpa?.doNotSell === false ? customCookieRules : [])
    : customCookieRules.filter(r => {
        const cat = (r.category || '').toLowerCase();
        if (cat === 'necessary') return true;
        if (cat === 'analytics') return !!cats.analytics;
        if (cat === 'marketing' || cat === 'advertisement') return !!cats.marketing;
        if (cat === 'functional' || cat === 'performance' || cat === 'preferences') return !!cats.preferences;
        return false;
      });

  const cookieRows = (() => {
    const scanned = relevantCookies.map(c => `
      <tr>
        <td>${c.name || '—'}</td>
        <td>${c.category || '—'}</td>
        <td>${c.expires || '—'}</td>
        <td>${c.description || '—'}</td>
      </tr>`);
    const custom = relevantCustomRules.map(r => `
      <tr>
        <td>${r.name || '—'} <span style="font-size:10px;color:#6b7280">(custom)</span></td>
        <td>${r.category || '—'}</td>
        <td>${r.duration || '—'}</td>
        <td>${r.description || '—'}</td>
      </tr>`);
    const all = [...scanned, ...custom];
    return all.length > 0
      ? all.join('')
      : `<tr><td colspan="4" style="color:#6b7280;text-align:center">No cookies recorded for accepted categories</td></tr>`;
  })();

  const consentPrefs = isCcpa
    ? `
      <div class="field"><div class="label">Do Not Sell</div><div class="value">${yesNo(cats.ccpa?.doNotSell)}</div></div>
    `
    : `
      <div class="field"><div class="label">Necessary</div><div class="value">${yesNo(cats.essential ?? true)}</div></div>
      <div class="field"><div class="label">Analytics</div><div class="value">${yesNo(cats.analytics)}</div></div>
      <div class="field"><div class="label">Marketing</div><div class="value">${yesNo(cats.marketing)}</div></div>
      <div class="field"><div class="label">Preferences</div><div class="value">${yesNo(cats.preferences)}</div></div>
    `;

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
      <div class="field"><div class="label">Consent ID</div><div class="value">${consent.id || '—'}</div></div>
      <div class="field"><div class="label">Timestamp (UTC)</div><div class="value">${ts}</div></div>
      <div class="field"><div class="label">IP Address</div><div class="value">${consent.ipAddress || '—'}</div></div>
      <div class="field"><div class="label">Country</div><div class="value">${consent.country || '—'}</div></div>
      <div class="field"><div class="label">Region</div><div class="value">${consent.region || '—'}</div></div>
      <div class="field"><div class="label">Regulation</div><div class="value">${(consent.regulation || 'gdpr').toUpperCase()}</div></div>
      <div class="field" style="grid-column:1/-1"><div class="label">User Agent</div><div class="value">${consent.userAgent || '—'}</div></div>
    </div>
  </div>

  <div class="section">
    <h2>Consent Preferences</h2>
    <div class="grid">
      ${consentPrefs}
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

  <div class="footer">ConsentBit &mdash; Consent Record for ${siteDomain} &mdash; ID ${consent.id}</div>
</body>
</html>`;
}

/**
 * GET /api/consent-pdf?siteId=...&consentId=...
 * Generates a PDF consent record for a single non-legacy consent entry.
 */
export async function handleConsentPdf(request, env) {
  const db = env.CONSENT_WEBAPP;

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  const consentId = url.searchParams.get('consentId');
  const token = url.searchParams.get('token');
  if (!siteId || !consentId) return new Response('siteId and consentId required', { status: 400 });

  // No session or token check — open endpoint, scoped only by siteId + consentId.
  const site = await db
    .prepare(
      `SELECT s.id, s.domain FROM Site s
       WHERE s.id = ?1 AND (s.isLegacy = 0 OR s.isLegacy IS NULL)`,
    )
    .bind(siteId)
    .first()
    .catch(() => null);

  if (!site) return new Response('Site not found', { status: 404 });

  // Fetch the specific consent record
  const consentRow = await db
    .prepare(
      `SELECT id, siteId, deviceId, ipAddress, userAgent, country, region, is_eu,
              createdAt, updatedAt, regulation, bannerType, consentMethod, status, expiresAt, consent_categories
       FROM Consent WHERE id = ?1 AND siteId = ?2`,
    )
    .bind(consentId, siteId)
    .first()
    .catch(() => null);

  if (!consentRow) return new Response('Consent record not found', { status: 404 });

  let categories = null;
  if (consentRow.consent_categories) {
    try {
      const parsed = typeof consentRow.consent_categories === 'string'
        ? JSON.parse(consentRow.consent_categories)
        : consentRow.consent_categories;
      categories = parsed && typeof parsed.categories === 'object' ? parsed.categories : parsed;
    } catch { /* ignore */ }
  }

  const consent = { ...consentRow, categories };

  // Fetch cookies for this site
  const { results: cookieRows } = await db
    .prepare(
      `SELECT id, name, domain, category, provider, description, expires FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
        FROM Cookie
        WHERE siteId = ?1 AND (isExpected = 0 OR isExpected IS NULL)
      ) WHERE rn = 1
      ORDER BY category, name`,
    )
    .bind(siteId)
    .all()
    .catch(() => ({ results: [] }));

  const cookies = cookieRows || [];

  // Fetch custom cookie rules
  const { results: customRuleRows } = await db
    .prepare(
      `SELECT id, name, category, duration, description
       FROM CustomCookieRule WHERE siteId = ?1 AND published = 1
       ORDER BY category, name`,
    )
    .bind(siteId)
    .all()
    .catch(() => ({ results: [] }));

  const customCookieRules = customRuleRows || [];

  const html = buildHtml(consent, cookies, customCookieRules, site.domain || siteId);

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    await browser.close();

    const filename = `consent_${consentId.slice(0, 8)}_${new Date().toISOString().split('T')[0]}.pdf`;
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[consentPdf]', err?.message);
    return new Response('PDF generation failed', { status: 500 });
  }
}
