// handlers/consentPdf.js
import puppeteer from '@cloudflare/puppeteer';
import { getSessionById } from '../services/db.js';
import { verifyDownloadToken } from '../utils/signedToken.js';

// favicon1.png embedded as base64 — Workers cannot fetch their own origin (522 loop).
const LOGO_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAFIGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDUgNzkuMTYzNDk5LCAyMDE4LzA4LzEzLTE2OjQwOjIyICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOSAoTWFjaW50b3NoKSIgeG1wOkNyZWF0ZURhdGU9IjIwMjUtMDItMTlUMTk6NDM6MTQrMDU6MzAiIHhtcDpNb2RpZnlEYXRlPSIyMDI1LTAyLTE5VDE5OjQzOjU4KzA1OjMwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDI1LTAyLTE5VDE5OjQzOjU4KzA1OjMwIiBkYzpmb3JtYXQ9ImltYWdlL3BuZyIgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjMyMTFhNTBjLWYz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';

export async function fetchImageAsDataUrl(_url) {
  return LOGO_DATA_URL;
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function normalizeCategories(cats) {
  if (!cats || typeof cats !== 'object') return cats;
  return cats.categories && typeof cats.categories === 'object' ? cats.categories : cats;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cookieDuration(expires) {
  if (!expires || expires.toLowerCase() === 'session') return 'session';
  try {
    const d = new Date(expires);
    if (isNaN(d.getTime())) return expires;
    const now = new Date();
    if (d.getTime() < now.getTime()) return 'expired';
    const days = Math.round((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (days <= 1) return '1 day';
    if (days < 365) return `${days} days`;
    return `${(days / 365).toFixed(1)} years`;
  } catch {
    return expires || 'session';
  }
}

export function buildHtml(consent, cookies, customCookieRules, siteDomain, logoUrl = null) {
  const cats = normalizeCategories(consent.categories) || {};
  const isCcpa = consent.regulation === 'ccpa' ||
    (!consent.regulation && cats.ccpa !== undefined && cats.essential === undefined && cats.analytics === undefined);
  const isGiven = ['given', 'accepted'].includes((consent.status || '').toLowerCase());

  // Format consent date
  const ts = consent.createdAt
    ? (() => {
        const d = new Date(consent.createdAt);
        const month = d.toLocaleString('en-US', { month: 'long' });
        const day = d.getDate();
        const year = d.getFullYear();
        const time = d.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
        return `${month} ${day}, ${year} at ${time} UTC`;
      })()
    : '—';

  // Anonymize IP (zero out last octet for IPv4)
  const rawIp = consent.ipAddress || '';
  const anonIp = (() => {
    const s = rawIp.trim();
    if (!s) return '—';
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s)) {
      const parts = s.split('.');
      parts[3] = '0';
      return parts.join('.');
    }
    if (s.includes(':')) return s.split(':').slice(0, 4).join(':') + '::';
    return s;
  })();

  // Build accepted categories list
  const acceptedCats = [];
  if (!isCcpa) {
    if (cats.essential !== false) acceptedCats.push('Essential');
    if (cats.analytics === true) acceptedCats.push('Analytics');
    if (cats.marketing === true) acceptedCats.push('Marketing');
    if (cats.preferences === true) acceptedCats.push('Preferences');
  }
  const acceptedLabels = isCcpa
    ? (cats.ccpa?.doNotSell === false ? 'All (CCPA accepted)' : 'None (Do Not Sell)')
    : (acceptedCats.length ? acceptedCats.join(', ') : 'Essential');

  // Filter cookies to accepted categories
  const acceptedSet = new Set(acceptedCats.map(c => c.toLowerCase()));
  acceptedSet.add('necessary');

  const relevantCookies = isCcpa
    ? (cats.ccpa?.doNotSell === false ? cookies : [])
    : cookies.filter(c => {
        const cat = (c.category || '').toLowerCase();
        return acceptedSet.has(cat) || cat === 'essential';
      });

  const relevantCustomRules = isCcpa
    ? (cats.ccpa?.doNotSell === false ? customCookieRules : [])
    : customCookieRules.filter(r => {
        const cat = (r.category || '').toLowerCase();
        if (cat === 'necessary' || cat === 'essential') return true;
        if (cat === 'analytics') return !!cats.analytics;
        if (cat === 'marketing' || cat === 'advertisement') return !!cats.marketing;
        if (cat === 'functional' || cat === 'performance' || cat === 'preferences') return !!cats.preferences;
        return false;
      });

  const cookieRows = (() => {
    const scanned = relevantCookies.map(c => `
      <tr>
        <td class="proof-td">${escapeHtml(c.name || '—')}</td>
        <td class="proof-td">${escapeHtml(cookieDuration(c.expires))}</td>
        <td class="proof-td">${escapeHtml(c.description || '—')}</td>
      </tr>`);
    const custom = relevantCustomRules.map(r => `
      <tr>
        <td class="proof-td">${escapeHtml(r.name || '—')} <span style="font-size:10px;color:#6b7280">(custom)</span></td>
        <td class="proof-td">${escapeHtml(r.duration || '—')}</td>
        <td class="proof-td">${escapeHtml(r.description || '—')}</td>
      </tr>`);
    const all = [...scanned, ...custom];
    return all.length > 0
      ? all.join('')
      : `<tr><td class="proof-td" colspan="3" style="color:#6b7280;text-align:center">No cookies recorded for accepted categories.</td></tr>`;
  })();

  const consentStatusLabel = isGiven ? 'Accepted' : 'Rejected';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 16mm 14mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111827; padding: 24px 28px 32px; background: #fff; font-size: 12px; line-height: 1.45; }

  .proof-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid #dbe5f3; }
  .proof-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; color: #007aff; }
  .proof-brand { flex-shrink: 0; display: flex; align-items: center; gap: 5px; padding-top: 4px; }
  .proof-brand svg { width: 18px; height: 18px; }
  .proof-brand-name { font-size: 18px; font-weight: 700; color: #111827; }

  .proof-meta { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  .proof-label { padding: 6px 12px 6px 0; vertical-align: top; font-weight: 600; color: #374151; width: 200px; }
  .proof-value { padding: 6px 0; color: #111827; word-break: break-word; }

  .proof-section-box { border: 1px solid #93c5fd; border-radius: 8px; overflow: hidden; margin-bottom: 14px; }
  .proof-categories-header { background: linear-gradient(180deg, #f0f7ff 0%, #ffffff 100%); padding: 12px 14px 14px; border-bottom: 1px solid #93c5fd; }
  .proof-categories-title { font-size: 14px; font-weight: 700; color: #007aff; margin-bottom: 4px; }
  .proof-categories-line { color: #374151; font-size: 12px; }

  .proof-cookie-table { border-collapse: collapse; width: 100%; }
  .proof-th { border: 1px solid #bfdbfe; padding: 10px 12px; text-align: left; vertical-align: top; background: #e6f1fd; color: #1e3a5f; font-weight: 600; font-size: 12px; }
  .proof-td { border: 1px solid #bfdbfe; padding: 10px 12px; text-align: left; vertical-align: top; color: #111827; font-size: 11.5px; }

  .proof-footer { margin-top: 20px; font-size: 11px; color: #6b7280; }
</style>
</head>
<body>
  <div class="proof-header">
    <h1 class="proof-title">Proof of consent</h1>
    <div class="proof-brand">
      ${logoUrl
        ? `<img src="${logoUrl}" style="width:28px;height:28px;object-fit:contain;" alt="ConsentBit" />`
        : `<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px;"><circle cx="9" cy="9" r="9" fill="#007aff"/><path d="M4.5 9.5L7.5 12.5L13.5 6" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
      <span class="proof-brand-name">ConsentBit</span>
    </div>
  </div>

  <table class="proof-meta" role="presentation">
    <tr><td class="proof-label">Consented domain</td><td class="proof-value">${escapeHtml(siteDomain)}</td></tr>
    <tr><td class="proof-label">Consent date</td><td class="proof-value">${escapeHtml(ts)}</td></tr>
    <tr><td class="proof-label">Consent ID</td><td class="proof-value">${escapeHtml(consent.id || '—')}</td></tr>
    <tr><td class="proof-label">Country</td><td class="proof-value">${escapeHtml(consent.country || '—')}</td></tr>
    <tr><td class="proof-label">Anonymized IP address</td><td class="proof-value">${escapeHtml(anonIp)}</td></tr>
    <tr><td class="proof-label">Consent status</td><td class="proof-value">${escapeHtml(consentStatusLabel)}</td></tr>
  </table>

  <div class="proof-section-box">
    <div class="proof-categories-header">
      <p class="proof-categories-title">Accepted Categories</p>
      <p class="proof-categories-line">${escapeHtml(acceptedLabels)}</p>
    </div>
    <table class="proof-cookie-table">
      <thead>
        <tr>
          <th class="proof-th">Cookie Name</th>
          <th class="proof-th">Duration</th>
          <th class="proof-th">Description</th>
        </tr>
      </thead>
      <tbody>${cookieRows}</tbody>
    </table>
  </div>

  <p class="proof-footer">Page 1 of 1</p>
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

  const logoUrl = await fetchImageAsDataUrl();
  const html = buildHtml(consent, cookies, customCookieRules, site.domain || siteId, logoUrl);

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
