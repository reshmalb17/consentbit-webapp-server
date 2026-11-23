// src/services/combinedInvoice.js
//
// Monthly combined invoice for customers who pay per site (one Stripe subscription
// per site) but want ONE invoice for all of them. Platan Hotels (15 sites) was the
// first: the October 2026 invoice was built by hand
// (Customer Issues/Platan Hotels - Combined Invoice October 2026.html); this sends
// the same document automatically every month.
//
// On RUN_DAY of each month, from RUN_HOUR_UTC, for each customer below:
//   1. list the Stripe subscription invoices created since the previous run day
//      (14 Platan sites renew on the 2nd and Aries Wisła on the 10th; every one of them
//      appears in exactly one combined invoice, the one sent on the 11th),
//   2. render one invoice (HTML email body + PDF attachment when BROWSER is bound),
//   3. email it to the customer's billing recipients and a copy to INTERNAL_COPY_TO.
// Claimed in CombinedInvoiceSent before sending, so each month goes out once.
//
// These customers are on the email mute list (services/email.js), so the send goes
// through sendBrevoEmail directly, which does not check the mute.
//
// Switch: COMBINED_INVOICES = "off" | "dry-run" | "on". Test and production share
// one D1 and one claim table, so set it on ONE worker (production), which also has
// the live Stripe key.
//
// Test send: COMBINED_INVOICE_TEST_TO = "you@example.com" sends ONLY to that address
// (subject marked [TEST], no customer, no internal copy), on the next tick whatever the
// day, for the most recent invoice month (on 26 Oct that is October). Once per month
// per address. Remove it before the 11th, or the real invoice will not go out.

import puppeteer from '@cloudflare/puppeteer';
import { sendBrevoEmail } from './email.js';
import { INVOICE_LOGO_DATA_URI } from './combinedInvoiceLogo.js';

// 11th, not the 3rd: 14 Platan sites renew on the 2nd and Aries Wisła on the 10th, so the
// window has to close after the 10th for all 15 renewals to land on one invoice.
export const RUN_DAY = 11;
const RUN_HOUR_UTC = 9;
const INTERNAL_COPY_TO = 'web@consentbit.com';

export const COMBINED_INVOICE_CUSTOMERS = [
  {
    key: 'PLATAN',
    stripeCustomerId: 'cus_V9NAuC9WclpLUd',
    displayName: 'Platan Hotels & Resorts',
    billTo: [
      'PLATAN HOTELS &amp; RESORTS',
      'Poleczki 23',
      '02-822 Warszawa',
      'Poland',
      'rodrigo.rejman@platanhotels.pl',
      'PL VAT PL9512354237',
    ],
    taxNote: 'Reverse charge',
    recipients: [
      { email: 'rodrigo.rejman@platanhotels.pl', name: 'Rodrigo Rejman' },
      { email: 'magdalena.tomalska@platanhotels.pl', name: 'Magdalena Tomalska' },
    ],
  },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map(m => m.slice(0, 3));

export function combinedInvoiceMode(env) {
  const raw = String(env?.COMBINED_INVOICES || '').trim().toLowerCase();
  return raw === 'on' || raw === 'dry-run' ? raw : 'off';
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/**
 * The invoice month for a run on `now` (the latest month whose RUN_DAY is not after
 * `now`), and the [start, end) window it covers.
 */
export function invoiceWindow(now) {
  const first = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth() - (now.getUTCDate() < RUN_DAY ? 1 : 0), 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth();
  return {
    period: `${y}-${String(m + 1).padStart(2, '0')}`,
    label: `${MONTHS[m]} ${y}`,
    start: Date.UTC(y, m - 1, RUN_DAY) / 1000,
    end: Date.UTC(y, m, RUN_DAY) / 1000,
    issued: `${RUN_DAY} ${MONTHS[m]} ${y}`,
  };
}

function shortDate(unix) {
  const d = new Date(unix * 1000);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

function shortDateYear(unix) {
  const d = new Date(unix * 1000);
  return `${shortDate(unix)} ${d.getUTCFullYear()}`;
}

function money(cents, currency = 'usd') {
  const sign = cents < 0 ? '−' : '';
  const prefix = currency.toLowerCase() === 'usd' ? 'US$' : `${currency.toUpperCase()} `;
  return `${sign}${prefix}${(Math.abs(cents) / 100).toFixed(2)}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Stripe + D1 ─────────────────────────────────────────────────────────────

async function listSubscriptionInvoices(env, customerId, start, end) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      customer: customerId,
      'created[gte]': String(start),
      'created[lt]': String(end),
      limit: '100',
    });
    if (startingAfter) q.set('starting_after', startingAfter);
    const res = await fetch(`https://api.stripe.com/v1/invoices?${q}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.error) {
      throw new Error(`Stripe invoices list failed (${res.status}): ${json?.error?.message || ''}`);
    }
    out.push(...(json.data || []));
    if (!json.has_more || !json.data?.length) break;
    startingAfter = json.data[json.data.length - 1].id;
  }
  // Subscription charges only; drafts and voids are not bills.
  return out.filter(inv => {
    const sub = inv.subscription || inv.parent?.subscription_details?.subscription;
    return sub && (inv.status === 'paid' || inv.status === 'open') && inv.total > 0;
  });
}

function invoiceSubscriptionId(inv) {
  const sub = inv.subscription || inv.parent?.subscription_details?.subscription;
  return typeof sub === 'string' ? sub : sub?.id || null;
}

/** stripeSubscriptionId → { name, domain } from Subscription + Site. */
async function siteLabels(db, subIds) {
  const labels = new Map();
  if (!db || !subIds.length) return labels;
  const marks = subIds.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await db
    .prepare(
      `SELECT s.stripeSubscriptionId AS subId, st.name, st.domain
         FROM Subscription s LEFT JOIN Site st ON st.id = s.siteId
        WHERE s.stripeSubscriptionId IN (${marks})`,
    )
    .bind(...subIds)
    .all();
  for (const r of results || []) labels.set(r.subId, { name: r.name, domain: r.domain });
  return labels;
}

// ─── Invoice model + rendering ───────────────────────────────────────────────

export function buildInvoiceModel(customer, win, invoices, labels) {
  const lines = invoices
    .map(inv => {
      const subId = invoiceSubscriptionId(inv);
      const line = inv.lines?.data?.[0] || {};
      const site = labels.get(subId) || {};
      const domain = String(site.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const planName = line.price?.nickname || line.plan?.nickname
        || (line.description || '').replace(/^\d+\s*×\s*/, '').replace(/\s*\(at .*\)$/, '')
        || 'Subscription';
      return {
        subId,
        site: [site.name, domain].filter(Boolean).join(', ') || subId,
        plan: planName,
        periodStart: line.period?.start || inv.period_start,
        periodEnd: line.period?.end || inv.period_end,
        unit: inv.subtotal,
        discount: inv.subtotal - (inv.total_excluding_tax ?? inv.total),
        amount: inv.total,
        status: inv.status,
        paidAt: inv.status_transitions?.paid_at || null,
        currency: inv.currency || 'usd',
      };
    })
    .sort((a, b) => a.periodStart - b.periodStart || a.site.localeCompare(b.site));

  const currency = lines[0]?.currency || 'usd';
  const subtotal = lines.reduce((s, l) => s + l.unit, 0);
  const discount = lines.reduce((s, l) => s + l.discount, 0);
  const total = lines.reduce((s, l) => s + l.amount, 0);

  // One "Paid <date>" row per payment day, listing the line numbers it covered.
  const paidByDay = new Map();
  lines.forEach((l, i) => {
    if (l.status !== 'paid' || !l.paidAt) return;
    const day = shortDateYear(l.paidAt);
    const e = paidByDay.get(day) || { day, at: l.paidAt, nums: [], sum: 0 };
    e.nums.push(i + 1);
    e.sum += l.amount;
    paidByDay.set(day, e);
  });
  const payments = [...paidByDay.values()].sort((a, b) => a.at - b.at);
  const outstanding = lines.filter(l => l.status !== 'paid').reduce((s, l) => s + l.amount, 0);

  return {
    customer, win, lines, currency, subtotal, discount, total, payments, outstanding,
    reference: `${customer.key}-${win.period}`,
  };
}

function numList(nums) {
  // [1,3,4,5] → "1, 3–5"
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return parts.join(', ');
}

export function renderInvoiceHtml(model) {
  const { customer, win, lines, currency, subtotal, discount, total, payments, outstanding, reference } = model;
  const siteWord = lines.length === 1 ? 'website' : 'websites';
  const rows = lines.map((l, i) => `      <tr><td>${i + 1}</td><td>${esc(l.site)}<br><span class="sub">${esc(l.plan)} · <code>${esc(l.subId)}</code></span></td><td>${shortDate(l.periodStart)} – ${shortDateYear(l.periodEnd)}</td><td class="num">${money(l.unit, currency)}</td><td class="num">${l.discount ? money(-l.discount, currency) : '—'}</td><td class="num">${money(l.amount, currency)}</td></tr>`).join('\n');
  const paidRows = payments.map(p => `    <tr><td>Paid ${p.day} (${p.nums.length === lines.length ? 'all sites' : `site${p.nums.length > 1 ? 's' : ''} ${numList(p.nums)}`})</td><td>${money(p.sum, currency)}</td></tr>`).join('\n');
  const outstandingRow = outstanding > 0
    ? `\n    <tr><td><strong>Amount outstanding</strong></td><td><strong>${money(outstanding, currency)}</strong></td></tr>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice – ${esc(customer.displayName)} – ${win.label}</title>
<style>
  :root { --ink:#111827; --muted:#6b7280; --line:#e5e7eb; --accent:#1d4ed8; }
  * { box-sizing:border-box; }
  body { margin:0; background:#fff; color:var(--ink); font:13px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .page { max-width:820px; margin:32px auto; padding:0 32px; }
  .bar { height:4px; background:var(--accent); margin-bottom:28px; }
  header { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  h1 { font-size:26px; margin:0 0 12px; }
  .logo { height:40px; width:auto; display:block; }
  .meta td { padding:1px 12px 1px 0; }
  .meta td:first-child { font-weight:600; }
  .parties { display:flex; gap:48px; margin:28px 0; }
  .parties div { flex:1; }
  .label { font-weight:700; margin-bottom:4px; }
  .due { font-size:17px; font-weight:700; margin:8px 0 18px; }
  table.items { width:100%; border-collapse:collapse; }
  table.items th { text-align:left; font-weight:600; color:var(--muted); font-size:11.5px; border-bottom:1px solid var(--ink); padding:6px 6px; }
  table.items td { border-bottom:1px solid var(--line); padding:7px 6px; vertical-align:top; }
  table.items .num { text-align:right; white-space:nowrap; }
  .sub { color:var(--muted); font-size:11.5px; }
  code { font:11px/1.4 Consolas,Menlo,monospace; color:#374151; }
  .totals { margin-left:auto; width:330px; margin-top:14px; border-collapse:collapse; }
  .totals td { padding:5px 6px; border-bottom:1px solid var(--line); }
  .totals td:last-child { text-align:right; white-space:nowrap; }
  .totals tr.grand td { font-weight:700; border-bottom:2px solid var(--ink); }
  footer { margin:28px 0 40px; color:var(--muted); font-size:11.5px; }
  @page { margin:10mm 10mm 16mm; }
  @media print { .page { margin:0 auto; } }
</style>
</head>
<body>
<div class="page">
  <div class="bar"></div>

  <header>
    <div>
      <h1>Invoice</h1>
      <table class="meta">
        <tr><td>Reference</td><td>${esc(reference)}</td></tr>
        <tr><td>Billing period</td><td>${win.label}</td></tr>
        <tr><td>Date of issue</td><td>${win.issued}</td></tr>
      </table>
    </div>
    <img class="logo" alt="ConsentBit" src="${INVOICE_LOGO_DATA_URI}">
  </header>

  <div class="parties">
    <div>
      <div class="label">ConsentBit</div>
      5608 17th Avenue Northwest<br>
      Seattle, Washington 98107<br>
      United States<br>
      +1 206-414-9687
    </div>
    <div>
      <div class="label">Bill to</div>
      ${customer.billTo.join('<br>\n      ')}
    </div>
  </div>

  <div class="due">${money(total, currency)} for ${lines.length} ${siteWord}, ${win.label}</div>

  <table class="items">
    <thead>
      <tr>
        <th>#</th>
        <th>Website / Subscription</th>
        <th>Service period</th>
        <th class="num">Unit price</th>
        <th class="num">Discount</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td>${money(subtotal, currency)}</td></tr>
    <tr><td>Discount</td><td>${discount ? money(-discount, currency) : '—'}</td></tr>
    <tr><td>Tax</td><td>${esc(customer.taxNote || '—')}</td></tr>
    <tr class="grand"><td>Total</td><td>${money(total, currency)}</td></tr>
${paidRows}${outstandingRow}
  </table>

  <footer>
    ConsentBit · Cookie Consent Management · consentbit.com · Questions: web@consentbit.com
  </footer>
</div>
</body>
</html>`;
}

async function renderPdfBase64(env, html) {
  if (!env.BROWSER) return null;
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    // 'load' not 'networkidle0': the HTML is self-contained (inline CSS, data: logo), and on
    // Cloudflare Browser Rendering networkidle0 never fires -> 30 s navigation timeout
    // (seen live 2026-11-04: "Navigation timeout of 30000 ms exceeded"). If even 'load' is
    // late, render whatever is in the DOM rather than failing the download.
    await page.setContent(html, { waitUntil: 'load', timeout: 15000 }).catch((e) => {
      console.warn('[pdf] setContent wait timed out, rendering anyway:', e?.message);
    });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    let bin = '';
    const bytes = new Uint8Array(pdf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  } catch (err) {
    console.warn('[CombinedInvoice] PDF render failed, sending without attachment:', err?.message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Claim table ─────────────────────────────────────────────────────────────

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS CombinedInvoiceSent (
         customerKey TEXT NOT NULL, period TEXT NOT NULL, mode TEXT NOT NULL,
         invoiceCount INTEGER, totalCents INTEGER, recipients TEXT,
         createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (customerKey, period, mode))`,
    )
    .run();
  tableReady = true;
}

async function claim(db, key, period, mode) {
  const r = await db
    .prepare(`INSERT OR IGNORE INTO CombinedInvoiceSent (customerKey, period, mode) VALUES (?1, ?2, ?3)`)
    .bind(key, period, mode)
    .run();
  return (r?.meta?.changes || 0) > 0;
}

async function release(db, key, period, mode) {
  await db
    .prepare(`DELETE FROM CombinedInvoiceSent WHERE customerKey = ?1 AND period = ?2 AND mode = ?3`)
    .bind(key, period, mode)
    .run();
}

// ─── Entry point (cron) ──────────────────────────────────────────────────────

export async function runCombinedInvoices(env, { now = new Date() } = {}) {
  const mode = combinedInvoiceMode(env);
  if (mode === 'off') return;
  const testTo = String(env.COMBINED_INVOICE_TEST_TO || '').trim().toLowerCase();
  if (!testTo && (now.getUTCDate() !== RUN_DAY || now.getUTCHours() < RUN_HOUR_UTC)) return;
  // Test sends claim under their own mode, so they never block the real invoice.
  const claimMode = testTo ? `test:${testTo}` : mode;
  const db = env.CONSENT_WEBAPP;
  if (!db || !env.STRIPE_SECRET_KEY) return;
  await ensureTable(db);

  const win = invoiceWindow(now);
  for (const customer of COMBINED_INVOICE_CUSTOMERS) {
    if (!(await claim(db, customer.key, win.period, claimMode))) continue;
    try {
      const invoices = await listSubscriptionInvoices(env, customer.stripeCustomerId, win.start, win.end);
      if (!invoices.length) {
        console.log(`[CombinedInvoice] ${customer.key} ${win.period}: no subscription invoices in window — nothing sent`);
        continue;
      }
      const labels = await siteLabels(db, [...new Set(invoices.map(invoiceSubscriptionId).filter(Boolean))]);
      const model = buildInvoiceModel(customer, win, invoices, labels);
      const recipients = testTo
        ? [{ email: testTo, name: testTo }]
        : [...customer.recipients, { email: INTERNAL_COPY_TO, name: 'ConsentBit' }];

      await db
        .prepare(`UPDATE CombinedInvoiceSent SET invoiceCount = ?4, totalCents = ?5, recipients = ?6
                   WHERE customerKey = ?1 AND period = ?2 AND mode = ?3`)
        .bind(customer.key, win.period, claimMode, model.lines.length, model.total, recipients.map(r => r.email).join(','))
        .run();

      if (mode === 'dry-run') {
        console.log(`[CombinedInvoice] DRY-RUN ${model.reference}: ${model.lines.length} invoices, total ${money(model.total, model.currency)}, outstanding ${money(model.outstanding, model.currency)}, would email ${recipients.map(r => r.email).join(', ')}`);
        continue;
      }

      const html = renderInvoiceHtml(model);
      const pdf = await renderPdfBase64(env, html);
      const subject = `${testTo ? '[TEST] ' : ''}ConsentBit invoice ${model.reference} – ${customer.displayName} – ${win.label}`;
      const text = `Invoice ${model.reference} for ${win.label}: ${money(model.total, model.currency)} for ${model.lines.length} websites. `
        + (model.outstanding > 0 ? `Amount outstanding: ${money(model.outstanding, model.currency)}. ` : 'Paid in full. ')
        + 'Questions: web@consentbit.com';
      const attachment = pdf ? [{ name: `ConsentBit-Invoice-${model.reference}.pdf`, content: pdf }] : undefined;

      for (const r of recipients) {
        await sendBrevoEmail(env, { to: r.email, name: r.name, subject, html, text, attachment });
      }
      console.log(`[CombinedInvoice] sent ${model.reference} (${model.lines.length} invoices, ${money(model.total, model.currency)}) to ${recipients.map(r => r.email).join(', ')}`);
    } catch (err) {
      // Let the next tick retry rather than skipping the month.
      console.error(`[CombinedInvoice] ${customer.key} ${win.period} failed:`, err?.message);
      await release(db, customer.key, win.period, claimMode).catch(() => {});
    }
  }
}
