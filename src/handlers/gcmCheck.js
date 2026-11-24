// handlers/gcmCheck.js
//
// Google Consent Mode status check — the webapp's "Check GCM status → Check now".
//
//   POST /api/gcm-check { siteId }   runs a check now and returns it
//   GET  /api/gcm-check?siteId=…     returns the last stored check (or null)
//
// The check loads the site's live homepage in Browser Rendering with
// ?consentbit_debug=1, so the Debug Mode script we prepend to every served banner
// script (utils/debugMode.js) runs its own checks: consent default present, set
// before Google tags, all four v2 signals, Google requests sent before the default
// or without a consent state, TCF API timing. We read window.consentbitDebug.results.
// If the page has no ConsentBit debug data (script missing / legacy script), a
// minimal dataLayer check runs instead so the customer still gets an answer.
//
// No banner button is clicked, so no consent row is written. Gated on GCM_TOOLS
// (test only). Site access is checked by middleware/teamSiteAccess.js; this handler
// additionally requires a signed-in web-app session.

import puppeteer from '@cloudflare/puppeteer';
import { getSiteById, getSessionById } from '../services/db.js';
import { sidFromCookie } from '../services/team.js';

const MIN_INTERVAL_MS = 30 * 1000; // a repeat click inside 30s returns the last result

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS GcmCheck (
       siteId TEXT PRIMARY KEY,
       checkedAt TEXT NOT NULL,
       status TEXT NOT NULL,
       url TEXT,
       results TEXT,
       error TEXT
     )`
  ).run();
  tableReady = true;
}

function rowToResult(row) {
  if (!row) return null;
  let results = [];
  try { results = JSON.parse(row.results || '[]'); } catch (_) { results = []; }
  return {
    checkedAt: row.checkedAt,
    status: row.status,
    url: row.url || null,
    results,
    error: row.error || null,
  };
}

async function readLast(db, siteId) {
  const row = await db.prepare('SELECT * FROM GcmCheck WHERE siteId = ?1 LIMIT 1').bind(siteId).first();
  return rowToResult(row);
}

async function saveResult(db, siteId, r) {
  await db.prepare(
    `INSERT INTO GcmCheck (siteId, checkedAt, status, url, results, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(siteId) DO UPDATE SET checkedAt = excluded.checkedAt, status = excluded.status,
       url = excluded.url, results = excluded.results, error = excluded.error`
  ).bind(siteId, r.checkedAt, r.status, r.url, JSON.stringify(r.results || []), r.error || null).run();
}

function withDebugParam(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('consentbit_debug', '1');
    return u.toString();
  } catch (_) {
    return url + (url.includes('?') ? '&' : '?') + 'consentbit_debug=1';
  }
}

/** Load the page and collect the Debug Mode results (or a minimal fallback). */
async function runCheck(browserBinding, pageUrl) {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.goto(withDebugParam(pageUrl), { waitUntil: 'load', timeout: 25000 }).catch(async (e) => {
      // Tracking-heavy pages can miss 'load'; carry on if the DOM is there.
      const ok = await page.evaluate(() => !!document.body).catch(() => false);
      if (!ok) throw e;
    });

    // Debug Mode first runs 1.5s after load and re-runs every 1.5s. Wait for its
    // results (up to ~8s) so late Google requests are included.
    let out = null;
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      out = await page.evaluate(() => {
        const d = window.consentbitDebug;
        return d && Array.isArray(d.results) ? d.results : null;
      }).catch(() => null);
      if (out && i >= 9) break; // ~5s+ after load with results in hand
    }
    if (out) {
      return {
        source: 'debug',
        results: out
          .filter((r) => !r.consoleOnly)
          .map((r) => ({ s: r.s, title: r.title, detail: r.detail, code: r.code || '', fix: !!r.fix })),
      };
    }

    // Fallback: no ConsentBit debug data on the page.
    const fb = await page.evaluate(() => {
      const L = Array.isArray(window.dataLayer) ? window.dataLayer : [];
      let def = null, defIdx = -1, gIdx = -1;
      for (let i = 0; i < L.length; i++) {
        const it = L[i];
        if (!it) continue;
        if (it[0] === 'consent' && it[1] === 'default' && def === null) { def = it[2] || {}; defIdx = i; }
        else if ((it[0] === 'js' || it[0] === 'config' || it.event === 'gtm.js') && gIdx < 0) gIdx = i;
      }
      const hasCb = !!(window.__CONSENT_SITE__ || document.querySelector('script[src*="consentbit"]'));
      return { def, defIdx, gIdx, hasCb };
    }).catch(() => ({ def: null, defIdx: -1, gIdx: -1, hasCb: false }));

    const REQUIRED = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
    const results = [];
    if (!fb.hasCb) {
      results.push({ s: 'warn', title: 'ConsentBit script', detail: 'The ConsentBit script was not found on this page. Install it in <head> and publish the site.', code: '', fix: false });
    }
    if (!fb.def) {
      results.push({ s: 'warn', title: 'Consent default', detail: 'No consent default found on this page.', code: '', fix: true });
    } else {
      if (fb.gIdx >= 0 && fb.defIdx > fb.gIdx) {
        results.push({ s: 'warn', title: 'Consent default', detail: 'Google tag commands ran before the consent default. Load ConsentBit first in <head>.', code: '', fix: true });
      }
      const miss = REQUIRED.filter((k) => !fb.def[k]);
      if (miss.length) results.push({ s: 'warn', title: 'Consent signals', detail: 'Required consent types are missing from the default.', code: miss.join('  '), fix: false });
      else if (!(fb.gIdx >= 0 && fb.defIdx > fb.gIdx)) results.push({ s: 'pass', title: 'Consent default', detail: 'Set with all four Consent Mode v2 signals.', code: '', fix: false });
    }
    return { source: fb.hasCb ? 'fallback' : 'not_found', results };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function handleGcmCheck(request, env) {
  if (env.GCM_TOOLS !== '1') {
    return Response.json({ success: false, error: 'Not found' }, { status: 404 });
  }
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 500 });

  // Signed-in web-app users only (the team gate lets cookie-less Framer calls through).
  const sid = sidFromCookie(request);
  const session = sid ? await getSessionById(db, sid).catch(() => null) : null;
  if (!(session?.userId ?? session?.user_id)) {
    return Response.json({ success: false, error: 'Please log in.', code: 'LOGIN_REQUIRED' }, { status: 401 });
  }

  const url = new URL(request.url);
  let siteId = url.searchParams.get('siteId');
  if (request.method === 'POST') {
    try { const b = await request.json(); siteId = b?.siteId || siteId; } catch (_) {}
  }
  siteId = siteId ? String(siteId).trim() : '';
  if (!siteId) return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });

  await ensureTable(db);

  if (request.method === 'GET') {
    return Response.json({ success: true, check: await readLast(db, siteId) });
  }
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const site = await getSiteById(db, siteId);
  if (!site) return Response.json({ success: false, error: 'Site not found' }, { status: 404 });

  const last = await readLast(db, siteId);
  if (last && Date.now() - Date.parse(last.checkedAt) < MIN_INTERVAL_MS) {
    return Response.json({ success: true, check: last, cached: true });
  }

  const domain = String(site.domain ?? site.DOMAIN ?? '').trim();
  const pageUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const checkedAt = new Date().toISOString();

  let record;
  if (!env.BROWSER) {
    record = { checkedAt, status: 'failed', url: pageUrl, results: [], error: 'The checker is not available right now.' };
  } else {
    try {
      const { source, results } = await runCheck(env.BROWSER, pageUrl);
      const hasWarn = results.some((r) => r.s === 'warn');
      const status = source === 'not_found' ? 'not_found' : hasWarn ? 'issues' : 'ok';
      record = { checkedAt, status, url: pageUrl, results, error: null };
    } catch (err) {
      console.warn('[GcmCheck] check failed', { siteId, pageUrl, err: err?.message });
      record = {
        checkedAt, status: 'failed', url: pageUrl, results: [],
        error: 'We could not load your site to check it. Make sure it is published and reachable, then try again.',
      };
    }
  }

  try { await saveResult(db, siteId, record); } catch (e) { console.warn('[GcmCheck] save failed', e?.message); }
  return Response.json({ success: true, check: record });
}
