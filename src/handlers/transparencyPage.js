// src/handlers/transparencyPage.js
//
// Hosted cookie transparency page — a public, always-current list of the cookies a
// site uses, built from its latest ConsentBit scan. Parity with Captain Compliance's
// "Cookie Transparency Page" (costsegregation.cookietransparency.com), but path-based
// on this worker instead of a wildcard subdomain:
//
//   GET  /cookie-list/<domain>                 → HTML page (public, opt-in per site)
//   GET  /cookie-list/<domain>?format=json     → the same data as JSON
//   GET  /api/transparency-page?siteId=…       → the site's settings (session + site access)
//   POST /api/transparency-page { siteId, enabled, intro }  → save (owner / team Admin)
//
// TEST-ONLY: everything answers 404 unless TRANSPARENCY_PAGE = "1" (wrangler.toml
// [vars] only). Settings live in their own table, TransparencyPage, so no banner save
// path can clobber them. The D1 is shared with production, but the production worker
// has the flag off and never reads the table.
//
// Cookie VALUES are never stored or shown — only name, provider, domain, duration and
// description. The cookie list is the same one the dashboard's Scan tab shows (it
// calls handleCookies), so published custom cookie rules apply here too.

import { getSessionById, normalizeDomain } from '../services/db.js';
import { userCanAccessSite, userCanAdminSite } from '../services/team.js';
import { handleCookies } from './cookies.js';

const INTRO_MAX = 1000;

export function transparencyEnabled(env) {
  return String(env?.TRANSPARENCY_PAGE || '') === '1';
}

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS TransparencyPage (
      siteId TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      intro TEXT,
      updatedAt TEXT
    )
  `).run();
  tableReady = true;
}

async function readSettings(db, siteId) {
  await ensureTable(db);
  const row = await db
    .prepare('SELECT enabled, intro, updatedAt FROM TransparencyPage WHERE siteId = ?1')
    .bind(siteId)
    .first();
  return {
    enabled: !!(row && Number(row.enabled) === 1),
    intro: row?.intro || '',
    updatedAt: row?.updatedAt || null,
  };
}

function publicBase(env, request) {
  const configured = String(env?.TRANSPARENCY_BASE_URL || '').trim().replace(/\/+$/, '');
  return configured || new URL(request.url).origin;
}

function publicUrlFor(env, request, domain) {
  return `${publicBase(env, request)}/cookie-list/${encodeURIComponent(domain)}`;
}

// ── Settings (dashboard) ────────────────────────────────────────────────────

function sidFromCookie(request) {
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? m[1].trim() : null;
}

async function sessionCan(db, request, siteId, { manage = false } = {}) {
  if (!db || !siteId) return false;
  const sid = sidFromCookie(request);
  if (!sid) return false;
  const session = await getSessionById(db, sid);
  const userId = session?.userId ?? session?.user_id;
  if (!userId) return false;
  return manage ? userCanAdminSite(db, userId, siteId) : userCanAccessSite(db, userId, siteId);
}

async function describe(db, env, request, siteId) {
  const site = await db.prepare('SELECT domain FROM Site WHERE id = ?1').bind(siteId).first();
  const domain = normalizeDomain(site?.domain || '');
  const settings = await readSettings(db, siteId);
  return {
    success: true,
    siteId,
    domain,
    ...settings,
    publicUrl: domain ? publicUrlFor(env, request, domain) : null,
  };
}

export async function handleTransparencySettings(request, env) {
  if (!transparencyEnabled(env)) {
    return Response.json({ success: false, error: 'Not Found' }, { status: 404 });
  }
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const siteId = url.searchParams.get('siteId');
    if (!siteId) return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    if (!(await sessionCan(db, request, siteId))) {
      return Response.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }
    try {
      return Response.json(await describe(db, env, request, siteId));
    } catch (err) {
      console.warn('[Transparency][GET] failed:', err?.message);
      return Response.json({ success: false, error: 'Could not load transparency page settings.' }, { status: 500 });
    }
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    const siteId = String(body?.siteId || '').trim();
    if (!siteId) return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    if (!(await sessionCan(db, request, siteId, { manage: true }))) {
      return Response.json(
        { success: false, error: 'Only the site owner or a team Admin can change this.' },
        { status: 403 },
      );
    }
    const enabled = body?.enabled === true ? 1 : 0;
    const intro = String(body?.intro ?? '').trim().slice(0, INTRO_MAX);
    try {
      await ensureTable(db);
      await db
        .prepare(
          `INSERT INTO TransparencyPage (siteId, enabled, intro, updatedAt) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(siteId) DO UPDATE SET
             enabled = excluded.enabled, intro = excluded.intro, updatedAt = excluded.updatedAt`,
        )
        .bind(siteId, enabled, intro || null, new Date().toISOString())
        .run();
      return Response.json(await describe(db, env, request, siteId));
    } catch (err) {
      console.warn('[Transparency][POST] failed:', err?.message);
      return Response.json({ success: false, error: 'Could not save.' }, { status: 500 });
    }
  }

  return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
}

// ── Public page ─────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ['necessary', 'functional', 'preferences', 'analytics', 'behavioral', 'marketing'];

const CATEGORY_INFO = {
  necessary: {
    label: 'Strictly necessary',
    text: 'Needed for the website to work — security, load balancing, remembering your cookie choices. These cannot be switched off.',
  },
  functional: {
    label: 'Functional',
    text: 'Remember choices you make, such as language or region, and enable features like embedded videos or chat.',
  },
  preferences: {
    label: 'Preferences',
    text: 'Remember choices you make, such as language or region, to give you a more personal experience.',
  },
  analytics: {
    label: 'Analytics',
    text: 'Help us understand how visitors use the website — which pages are visited and how long visits last — so we can improve it.',
  },
  behavioral: {
    label: 'Personalization',
    text: 'Record how you interact with the website to personalize what you see.',
  },
  marketing: {
    label: 'Marketing',
    text: 'Used by us and our advertising partners to show relevant ads and measure campaigns, often across other websites.',
  },
  uncategorized: {
    label: 'Unclassified',
    text: 'Cookies we are still reviewing. They are blocked until you accept all cookies.',
  },
};

function categoryKey(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (!c || c === 'unknown' || c === 'other' || c === 'unclassified') return 'uncategorized';
  if (c === 'essential' || c === 'strictly_necessary' || c === 'strictly necessary') return 'necessary';
  if (c === 'functionality') return 'functional';
  if (c === 'performance' || c === 'statistics') return 'analytics';
  if (c === 'advertising' || c === 'targeting') return 'marketing';
  return c;
}

function categoryInfo(key) {
  if (CATEGORY_INFO[key]) return CATEGORY_INFO[key];
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return { label, text: '' };
}

function cookieHost(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    .replace(/^\.+/, '').replace(/^www\./, '');
}

function isFirstParty(cookieDomain, siteHost) {
  const h = cookieHost(cookieDomain);
  if (!h) return true;
  return h === siteHost || h.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${h}`);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpUrl(u) {
  try {
    const parsed = new URL(String(u || '').trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch (_) {
    return null;
  }
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

async function loadPageData(env, siteId, siteHost) {
  const db = env.CONSENT_WEBAPP;

  // Reuse the dashboard's cookie list (latest scan, rule overlay, manual cookies).
  const res = await handleCookies(
    new Request(`https://internal/api/cookies?siteId=${encodeURIComponent(siteId)}`),
    env,
  );
  const data = await res.json().catch(() => null);
  const rows = data?.success && Array.isArray(data.cookies) ? data.cookies : [];

  const lastScan = await db
    .prepare(
      `SELECT createdAt FROM ScanHistory
       WHERE siteId = ?1 AND scanStatus = 'completed' AND (scanUrl NOT LIKE '%client-detection%')
       ORDER BY createdAt DESC LIMIT 1`,
    )
    .bind(siteId)
    .first()
    .catch(() => null);

  const custom = await db
    .prepare('SELECT privacyPolicyUrl FROM BannerCustomization WHERE siteId = ?1')
    .bind(siteId)
    .first()
    .catch(() => null);

  const cookies = rows.map((c) => ({
    name: String(c.name || ''),
    category: categoryKey(c.category),
    provider: c.provider ? String(c.provider) : '',
    domain: cookieHost(c.domain) || siteHost,
    party: isFirstParty(c.domain, siteHost) ? 'first' : 'third',
    duration: c.expires ? String(c.expires) : '',
    description: c.description ? String(c.description) : '',
  }));
  cookies.sort((a, b) => a.name.localeCompare(b.name));

  const keys = [...new Set(cookies.map((c) => c.category))];
  const ordered = [
    ...CATEGORY_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !CATEGORY_ORDER.includes(k) && k !== 'uncategorized').sort(),
    ...(keys.includes('uncategorized') ? ['uncategorized'] : []),
  ];

  return {
    cookies,
    categories: ordered.map((key) => ({
      key,
      ...categoryInfo(key),
      cookies: cookies.filter((c) => c.category === key),
    })),
    lastScanAt: lastScan?.createdAt || null,
    privacyPolicyUrl: safeHttpUrl(custom?.privacyPolicyUrl),
  };
}

function renderNotFound() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Cookie list not found</title>
<style>body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:64px 16px;text-align:center;color:#334155;background:#f8fafc}</style>
</head><body><h1 style="font-size:20px;color:#0f172a">No cookie list here</h1>
<p>This website hasn't published a cookie list.</p></body></html>`;
}

function renderPage({ siteHost, settings, data }) {
  const total = data.cookies.length;
  const firstCount = data.cookies.filter((c) => c.party === 'first').length;
  const thirdCount = total - firstCount;
  const max = Math.max(1, ...data.categories.map((c) => c.cookies.length));
  const scanned = formatDate(data.lastScanAt);
  const intro = settings.intro
    ? escapeHtml(settings.intro).replace(/\r?\n/g, '<br>')
    : `This page lists the cookies and similar technologies used on ${escapeHtml(siteHost)}, what each one does and how long it lasts. It is generated from regular automated scans of the website.`;

  const bars = data.categories.map((c) => `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(c.label)}</span>
        <span class="bar-track"><span class="bar-fill cat-${escapeHtml(c.key)}" style="width:${Math.round((c.cookies.length / max) * 100)}%"></span></span>
        <span class="bar-count">${c.cookies.length}</span>
      </div>`).join('');

  const sections = data.categories.map((c) => `
    <section class="cat card" id="${escapeHtml(c.key)}">
      <h2><span class="dot cat-${escapeHtml(c.key)}"></span>${escapeHtml(c.label)} <span class="count">${c.cookies.length}</span></h2>
      ${c.text ? `<p class="cat-text">${escapeHtml(c.text)}</p>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Cookie</th><th>Provider</th><th>Domain</th><th>Duration</th><th>Purpose</th></tr></thead>
        <tbody>${c.cookies.map((k) => `
          <tr>
            <td data-label="Cookie"><code>${escapeHtml(k.name)}</code></td>
            <td data-label="Provider">${escapeHtml(k.provider || '—')}</td>
            <td data-label="Domain">${escapeHtml(k.domain)} <span class="party">${k.party === 'first' ? '1st party' : '3rd party'}</span></td>
            <td data-label="Duration">${escapeHtml(k.duration || '—')}</td>
            <td data-label="Purpose">${escapeHtml(k.description || 'No description available yet.')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </section>`).join('');

  const policyLink = data.privacyPolicyUrl
    ? `<a href="${escapeHtml(data.privacyPolicyUrl)}" rel="noopener">Privacy policy</a> · `
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cookie list — ${escapeHtml(siteHost)}</title>
<meta name="description" content="The cookies used on ${escapeHtml(siteHost)}, what they do and how long they last.">
<style>
:root{--bg:#f8fafc;--card:#fff;--text:#334155;--head:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#007aff;
--c-necessary:#16a34a;--c-functional:#0891b2;--c-preferences:#0891b2;--c-analytics:#7c3aed;--c-behavioral:#db2777;--c-marketing:#ea580c;--c-other:#94a3b8}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#111a2b;--text:#cbd5e1;--head:#f1f5f9;--muted:#94a3b8;--line:#1f2a3d;--accent:#4da3ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 16px 64px}
h1{color:var(--head);font-size:28px;line-height:1.2;margin:0 0 6px}
h2{color:var(--head);font-size:18px;margin:0 0 6px;display:flex;align-items:center;gap:8px}
.meta{color:var(--muted);font-size:13px;margin:0 0 20px}
.intro{margin:0 0 28px;max-width:760px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:20px}
.stats{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:18px}
.stat b{display:block;font-size:24px;color:var(--head)}
.stat span{color:var(--muted);font-size:13px}
.bar-row{display:grid;grid-template-columns:150px 1fr 32px;gap:12px;align-items:center;margin:6px 0;font-size:14px}
.bar-track{background:var(--line);border-radius:99px;height:10px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:99px;background:var(--c-other)}
.bar-count{text-align:right;color:var(--head);font-variant-numeric:tabular-nums}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:var(--c-other)}
.cat-necessary{background:var(--c-necessary)}.cat-functional{background:var(--c-functional)}.cat-preferences{background:var(--c-preferences)}
.cat-analytics{background:var(--c-analytics)}.cat-behavioral{background:var(--c-behavioral)}.cat-marketing{background:var(--c-marketing)}
.count{color:var(--muted);font-weight:500;font-size:14px}
.cat-text{margin:0 0 14px;color:var(--muted);font-size:14px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--head);word-break:break-all}
.party{display:inline-block;margin-left:4px;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:0 6px;white-space:nowrap}
.empty{color:var(--muted)}
footer{color:var(--muted);font-size:13px;margin-top:28px}
a{color:var(--accent)}
@media (max-width:640px){
  .bar-row{grid-template-columns:110px 1fr 28px}
  thead{display:none}
  tr{display:block;padding:10px 0;border-bottom:1px solid var(--line)}
  td{display:grid;grid-template-columns:90px 1fr;gap:8px;border:0;padding:4px 0}
  td::before{content:attr(data-label);color:var(--muted);font-size:12px}
}
</style>
</head>
<body>
<main>
  <h1>Cookies on ${escapeHtml(siteHost)}</h1>
  <p class="meta">${scanned ? `Last scanned ${escapeHtml(scanned)}` : 'Not scanned yet'}</p>
  <p class="intro">${intro}</p>

  <div class="card">
    <div class="stats">
      <div class="stat"><b>${total}</b><span>Cookies</span></div>
      <div class="stat"><b>${firstCount}</b><span>First party</span></div>
      <div class="stat"><b>${thirdCount}</b><span>Third party</span></div>
    </div>
    ${total ? bars : '<p class="empty">No cookies were found in the latest scan.</p>'}
  </div>

  ${sections}

  <footer>
    ${policyLink}You can change your cookie choices at any time from the cookie settings link on ${escapeHtml(siteHost)}.
    <br>Cookie list generated by <a href="https://www.consentbit.com/" rel="noopener">ConsentBit</a>.
  </footer>
</main>
</body>
</html>`;
}

function htmlResponse(html, status, env) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'public, max-age=60',
    // No scripts at all; inline styles only. Framing allowed so customers can embed
    // the list in their own cookie-policy page.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (String(env?.TRANSPARENCY_INDEX || '') !== '1') headers['X-Robots-Tag'] = 'noindex';
  return new Response(html, { status, headers });
}

export async function handleTransparencyPublic(request, env, url) {
  if (!transparencyEnabled(env) || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return Response.json({ success: false, error: 'Not Found' }, { status: 404 });
  }
  const wantsJson = url.searchParams.get('format') === 'json';
  const notFound = () => (wantsJson
    ? Response.json({ success: false, error: 'Not Found' }, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
    : htmlResponse(renderNotFound(), 404, env));

  let slug = '';
  try {
    slug = decodeURIComponent(url.pathname.slice('/cookie-list/'.length)).replace(/\/+$/, '');
  } catch (_) {
    return notFound();
  }
  const siteHost = normalizeDomain(slug);
  if (!siteHost || !/^[a-z0-9.-]+$/.test(siteHost)) return notFound();

  try {
    const db = env.CONSENT_WEBAPP;
    const site = await db.prepare('SELECT id, domain FROM Site WHERE domain = ?1').bind(siteHost).first();
    if (!site?.id) return notFound();
    const settings = await readSettings(db, site.id);
    if (!settings.enabled) return notFound();

    const data = await loadPageData(env, site.id, siteHost);

    if (wantsJson) {
      return Response.json(
        {
          success: true,
          domain: siteHost,
          lastScanAt: data.lastScanAt,
          totalCookies: data.cookies.length,
          categories: data.categories.map((c) => ({
            key: c.key,
            label: c.label,
            description: c.text,
            cookies: c.cookies.map(({ category, ...rest }) => rest),
          })),
        },
        { headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } },
      );
    }
    return htmlResponse(renderPage({ siteHost, settings, data }), 200, env);
  } catch (err) {
    console.warn('[Transparency][public] failed:', err?.message);
    return wantsJson
      ? Response.json({ success: false, error: 'Unavailable' }, { status: 503 })
      : htmlResponse(renderNotFound(), 503, env);
  }
}
