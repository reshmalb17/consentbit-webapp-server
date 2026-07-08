// src/services/scanReport.js
//
// Cookie-scan report → PDF → email.
//
// When a visitor scans their site on the cookie-scanner landing page and then
// signs up / logs in, the scan id rides along in the verify-code body. This
// module reads that scan row DIRECTLY from the shared cookie-scanner D1
// (binding COOKIE_SCANNER_DB — no cross-worker HTTP), renders the report to a
// PDF with the worker's own browser binding, and emails it as an attachment.

import puppeteer from '@cloudflare/puppeteer';
import { sendBrevoEmail } from './email.js';

// Minimal HTML escaping for values interpolated into the report.
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Format an ISO date as "27 June 2026".
function formatDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Build a printable HTML report from a saved scan's report_data object.
// Mirrors the on-site compliance report layout.
function buildScanReportHtml(data, meta) {
  const c = data.counts || {};
  const dom = data.domSignal || {};
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  const trackers = Array.isArray(data.trackers) ? data.trackers : [];

  const domain = data.scannedDomain || data.scannedUrl || meta.scanned_url || '-';
  const vendorsDetected = trackers.length + (Number(data.totalUnknown) || 0);
  const dateStr = formatDate(meta.scan_date);
  const bannerFound = dom.cookieBanner === true;
  const cmpList = Array.isArray(dom.cmp) ? dom.cmp : [];
  const cmpText = cmpList.length ? `Detected CMP: ${cmpList.map((x) => x.name).join(', ')}` : 'No CMP detected';

  // "Vendors that need attention" = cookies that require consent (everything except
  // strictly necessary). Columns: Cookie Name · Domain · Category · Provider.
  const attention = cookies.filter((ck) => !String(ck.category || '').toLowerCase().includes('necessary'));
  const attentionRows = (attention.length ? attention : cookies).slice(0, 200).map((ck) => `
    <tr>
      <td><b>${esc(ck.name)}</b></td>
      <td>${esc((ck.domain || '').replace(/^\./, '') || '-')}</td>
      <td><span class="cat">${esc(ck.category || 'other')}</span></td>
      <td>${esc(String(ck.provider || '').trim().replace(/^-+$/, '') || 'Not Available')}</td>
    </tr>`).join('');

  const chip = (label, n, color) =>
    `<span class="chip"><span class="d" style="background:${color}"></span>${label} · ${esc(n || 0)}</span>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
    * { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { color:#0b1324; margin:32px; }
    h1 { font-size:30px; font-weight:800; margin:0 0 8px; }
    .sub { color:#6b7280; font-size:13px; margin:0 0 26px; }
    .sub b { color:#0b1324; }
    .cards { display:flex; gap:14px; margin-bottom:30px; }
    .card { flex:1; border:1px solid #e6e8ec; border-radius:14px; padding:16px 18px; }
    .card .lbl { font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:#6b7280; font-weight:700; margin-bottom:12px; }
    .card .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; vertical-align:middle; }
    .card .big { font-size:30px; font-weight:800; line-height:1; }
    .card .meta { font-size:12px; color:#6b7280; margin-top:8px; }
    .red { color:#ef4444; } .amber { color:#f59e0b; }
    h2 { font-size:18px; font-weight:800; margin:24px 0 12px; }
    .chips { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
    .chip { background:#eef2f8; border-radius:999px; padding:8px 16px; font-size:13px; font-weight:600; color:#0b1324; }
    .chip .d { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:7px; vertical-align:middle; }
    .desc { color:#6b7280; font-size:13px; margin:0 0 12px; }
    table { width:100%; border-collapse:collapse; font-size:12px; margin-top:6px; }
    th { text-align:left; padding:9px 10px; background:#f8f9fc; color:#6b7280; text-transform:uppercase; font-size:10px; letter-spacing:.05em; border-bottom:1px solid #eef0f3; }
    td { text-align:left; padding:9px 10px; border-bottom:1px solid #eef0f3; vertical-align:top; }
    .cat { background:#eef2f8; border-radius:999px; padding:2px 10px; font-size:11px; text-transform:capitalize; }
  </style></head><body>
    <h1>Cookie compliance report</h1>
    <p class="sub"><b>${esc(domain)}</b> &nbsp;·&nbsp; ${esc(vendorsDetected)} vendors detected &nbsp;·&nbsp; ${esc(dateStr)}</p>

    <div class="cards">
      <div class="card">
        <div class="lbl"><span class="dot" style="background:${bannerFound ? '#22c55e' : '#ef4444'}"></span>Cookie Banner</div>
        <div class="big ${bannerFound ? '' : 'red'}">${bannerFound ? 'Found' : 'Not found'}</div>
        <div class="meta">${esc(cmpText)}</div>
      </div>
      <div class="card">
        <div class="lbl"><span class="dot" style="background:#0b1324"></span>Vendors</div>
        <div class="big">${esc(vendorsDetected)}</div>
        <div class="meta">across all pages</div>
      </div>
      <div class="card">
        <div class="lbl"><span class="dot" style="background:#ef4444"></span>Cookies</div>
        <div class="big red">${esc(data.totalCookies ?? cookies.length)}</div>
        <div class="meta">across all pages</div>
      </div>
      <div class="card">
        <div class="lbl"><span class="dot" style="background:#f59e0b"></span>Compliance Score</div>
        <div class="big amber">${esc(data.grade || '-')}</div>
        <div class="meta">grade</div>
      </div>
    </div>

    <h2>Identified cookies by category</h2>
    <div class="chips">
      ${chip('Necessary', c.necessary, '#3b82f6')}
      ${chip('Functional', c.functional, '#3b82f6')}
      ${chip('Analytics', c.analytics, '#3b82f6')}
      ${chip('Advertisement', c.advertisement, '#3b82f6')}
      ${chip('Other', c.other, '#3b82f6')}
    </div>

    <h2>Cookie Details</h2>
    <table>
      <thead><tr><th>Cookie Name</th><th>Domain</th><th>Category</th><th>Provider</th></tr></thead>
      <tbody>${attentionRows || '<tr><td colspan="4">None detected</td></tr>'}</tbody>
    </table>
  </body></html>`;
}

// Convert PDF bytes to a base64 string (for Brevo's attachment `content` field).
function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Render a stored scan as a PDF and email it. Awaitable — call inside
 * ctx.waitUntil() so it never blocks the signup/login response.
 *
 * @param {object} env
 * @param {{ to: string, name?: string, scanId: string }} opts
 */
export async function sendScanReportForId(env, { to, name, scanId, force = false }) {
  if (!scanId) return;
  console.log('[ScanReport] start — scanId:', scanId, '| to:', to);

  const db = env.COOKIE_SCANNER_DB;
  if (!db) { console.warn('[ScanReport] COOKIE_SCANNER_DB not bound — skipping'); return; }
  if (!env.BROWSER) { console.warn('[ScanReport] BROWSER not bound — skipping'); return; }

  // Read the scan row directly from the shared cookie-scanner D1.
  let row;
  try {
    row = await db
      .prepare(`SELECT id, scanned_url, scan_date, report_data, emailed_at FROM scan_reports WHERE id = ?1`)
      .bind(scanId)
      .first();
  } catch (e) {
    console.error('[ScanReport] lookup failed:', e?.message);
    return;
  }
  if (!row) { console.warn('[ScanReport] no scan_reports row for id', scanId); return; }

  // Already emailed for this scan and no newer scan has reset the flag — don't resend.
  // `force` (admin test sends) bypasses this guard.
  if (row.emailed_at && !force) {
    console.log('[ScanReport] already emailed at', row.emailed_at, '— skipping scanId', scanId);
    return;
  }

  let data;
  try { data = JSON.parse(row.report_data); } catch { data = {}; }

  const domain = data.scannedDomain || data.scannedUrl || row.scanned_url || '';
  const html = buildScanReportHtml(data, row);

  // Render the PDF with the worker's own browser binding (same pattern as consentPdf.js).
  let browser;
  let pdfBase64;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px' } });
    pdfBase64 = bytesToBase64(pdf);
  } catch (e) {
    console.error('[ScanReport] PDF render failed:', e?.message);
    if (browser) await browser.close().catch(() => {});
    return;
  }
  if (browser) await browser.close().catch(() => {});

  // Compose + send the email with the PDF attached (base64 content).
  const displayName = name || 'there';
  const displayDomain = domain || 'your website';
  const subject = `Your cookie scan report${domain ? ` for ${displayDomain}` : ''}`;

  const html_email = `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${esc(displayName)},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Thanks for scanning <strong style="color:#111827;">${esc(displayDomain)}</strong> with ConsentBit.
      Your full cookie compliance report is attached to this email as a PDF.
    </p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      It lists every cookie and tracker we detected, grouped by category, along with your compliance grade.
      Log in any time to set up a consent banner that brings your site into compliance.
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>`;

  const text = `Hi ${displayName},

Thanks for scanning ${displayDomain} with ConsentBit. Your full cookie compliance report is attached to this email as a PDF.

It lists every cookie and tracker we detected, grouped by category, along with your compliance grade.

Best regards,
ConsentBit Team
`;

  await sendBrevoEmail(env, {
    to,
    name,
    subject,
    html: html_email,
    text,
    attachment: [{ content: pdfBase64, name: 'cookie-scan-report.pdf' }],
  });

  // Mark this scan as emailed so a repeat login/signup with the same scanId doesn't resend.
  // A fresh scan of the site resets emailed_at to NULL, so new reports still get emailed.
  // Skip for forced test sends so the real user still receives their report.
  if (force) { console.log('[ScanReport] forced test send — not marking emailed for', scanId); return; }
  try {
    await db
      .prepare(`UPDATE scan_reports SET emailed_at = ?1 WHERE id = ?2`)
      .bind(new Date().toISOString(), scanId)
      .run();
    console.log('[ScanReport] sent + marked emailed — scanId', scanId);
  } catch (e) {
    console.error('[ScanReport] failed to mark emailed:', e?.message);
  }
}
