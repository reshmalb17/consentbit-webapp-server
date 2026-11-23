// src/services/newTrackerAlerts.js — "a new tracker showed up on your site" emails.
//
// After a SCHEDULED scan finishes, compare it with the site's previous completed scan
// and email the owner (plus team Admins) when new tracking cookies or scripts appeared.
// Manual "Scan now" runs are not alerted: the owner is already looking at the result.
//
// Flag NEW_TRACKER_ALERTS: "off" (default, no-op), "dry-run" (log what would be sent,
// nothing emailed) or "on". Test and production share one D1, so turn it on in ONE
// worker only, like RETENTION_REMINDERS.
//
// Growth plan only: other plans get their scheduled scans as before, just no email.
const ALERT_PLANS = new Set(['growth']);

// Additive: three guarded columns on ScanHistory (triggeredBy, alertedAt, alertSummary).
// Nothing else in the scan path changes. A scan is claimed (alertedAt set) before any
// email goes out, so overlapping cron ticks cannot send twice.

import { getOrgOwnerEmail, getEffectivePlanForOrganization } from './db.js';
import { listSiteAdminRecipients } from './team.js';
import { sendNewTrackerEmail } from './email.js';

const SCANS_PER_TICK = 3;
// Scans older than this are left alone: the alert would be stale, and it keeps a freshly
// enabled flag from mailing every customer about weeks-old scans.
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_LISTED = 25;

// Cookies in these categories are not trackers; a new one is not worth an email.
const QUIET_COOKIE_CATEGORIES = new Set(['necessary', 'essential', 'strictly necessary', 'strictly-necessary']);

let columnsReady = null;

/** Adds the alert columns once per isolate. Safe to call on every tick. */
export async function ensureAlertColumns(db) {
  if (!columnsReady) {
    columnsReady = (async () => {
      for (const col of ['triggeredBy TEXT', 'alertedAt TEXT', 'alertSummary TEXT']) {
        await db
          .prepare(`ALTER TABLE ScanHistory ADD COLUMN ${col}`)
          .run()
          .catch((e) => {
            if (!/duplicate column/i.test(String(e?.message || e))) throw e;
          });
      }
    })().catch((e) => {
      columnsReady = null;
      throw e;
    });
  }
  return columnsReady;
}

/** Called by the scheduled-scan runner right after it starts a scan. */
export async function markScheduledScan(db, scanHistoryId) {
  if (!db || !scanHistoryId) return;
  await ensureAlertColumns(db);
  await db.prepare(`UPDATE ScanHistory SET triggeredBy = 'scheduled' WHERE id = ?1`).bind(scanHistoryId).run();
}

/**
 * Pure: decide what to report from the rows that first appeared in this scan.
 * Returns null when there is nothing worth an email.
 */
export function buildAlert({ cookies = [], scripts = [] } = {}) {
  const trackerCookies = cookies.filter((c) => !QUIET_COOKIE_CATEGORIES.has(String(c?.category || '').toLowerCase()));
  const seenScripts = new Set();
  const newScripts = scripts.filter((s) => {
    const u = String(s?.scriptUrl || '').trim();
    if (!u || seenScripts.has(u)) return false;
    seenScripts.add(u);
    return true;
  });
  if (!trackerCookies.length && !newScripts.length) return null;
  return {
    cookies: trackerCookies.slice(0, MAX_LISTED).map((c) => ({
      name: String(c.name || ''),
      domain: String(c.domain || ''),
      category: String(c.category || 'uncategorized').toLowerCase(),
      provider: c.provider ? String(c.provider) : '',
    })),
    scripts: newScripts.slice(0, MAX_LISTED).map((s) => ({
      url: String(s.scriptUrl || ''),
      category: String(s.category || 'uncategorized').toLowerCase(),
    })),
    cookieCount: trackerCookies.length,
    scriptCount: newScripts.length,
  };
}

export async function runNewTrackerAlerts(env, ctx, { now = new Date() } = {}) {
  const mode = String(env?.NEW_TRACKER_ALERTS || 'off').trim().toLowerCase();
  if (mode !== 'on' && mode !== 'dry-run') return { skipped: 'off' };
  const db = env.CONSENT_WEBAPP;
  if (!db) return { skipped: 'no-db' };
  await ensureAlertColumns(db);

  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const { results: scans = [] } = await db
    .prepare(
      `SELECT id, siteId, createdAt FROM ScanHistory
        WHERE triggeredBy = 'scheduled' AND scanStatus = 'completed' AND alertedAt IS NULL AND createdAt >= ?1
        ORDER BY createdAt ASC LIMIT ${SCANS_PER_TICK}`
    )
    .bind(since)
    .all();

  const out = { checked: 0, emailed: 0, baseline: 0, quiet: 0, notGrowth: 0 };
  for (const scan of scans) {
    try {
      const r = await handleScan(db, env, ctx, scan, mode, now);
      out.checked += 1;
      if (r === 'emailed') out.emailed += 1;
      else if (r === 'baseline') out.baseline += 1;
      else if (r === 'quiet') out.quiet += 1;
      else if (r === 'not-growth') out.notGrowth += 1;
    } catch (e) {
      console.warn('[NewTrackerAlerts] scan', scan.id, 'failed:', e?.message || e);
    }
  }
  return out;
}

async function handleScan(db, env, ctx, scan, mode, now) {
  // Claim first. Only the tick that flips alertedAt proceeds.
  const claim = await db
    .prepare(`UPDATE ScanHistory SET alertedAt = ?1 WHERE id = ?2 AND alertedAt IS NULL`)
    .bind(now.toISOString(), scan.id)
    .run();
  if (!claim?.meta?.changes) return 'claimed-elsewhere';

  const site = await db.prepare(`SELECT id, domain, organizationId FROM Site WHERE id = ?1`).bind(scan.siteId).first();
  const organizationId = site?.organizationId ?? site?.organizationid ?? null;
  const { planId } = organizationId ? await getEffectivePlanForOrganization(db, organizationId, env) : { planId: 'free' };
  if (!ALERT_PLANS.has(String(planId || 'free').toLowerCase())) {
    await saveSummary(db, scan.id, { skipped: 'plan', plan: planId || 'free' });
    return 'not-growth';
  }

  const prev = await db
    .prepare(`SELECT id FROM ScanHistory WHERE siteId = ?1 AND scanStatus = 'completed' AND createdAt < ?2 ORDER BY createdAt DESC LIMIT 1`)
    .bind(scan.siteId, scan.createdAt)
    .first();
  if (!prev) {
    // First completed scan of the site: nothing to compare against.
    await saveSummary(db, scan.id, { baseline: true });
    return 'baseline';
  }

  // Rows that first appeared between this scan starting and the next scan (or now).
  // Cookie.firstSeenAt and Script.createdAt survive re-scans (the upserts only touch
  // other columns), so "first seen in this window" is exactly "new in this scan".
  const next = await db
    .prepare(`SELECT createdAt FROM ScanHistory WHERE siteId = ?1 AND createdAt > ?2 ORDER BY createdAt ASC LIMIT 1`)
    .bind(scan.siteId, scan.createdAt)
    .first();
  const until = next?.createdAt || now.toISOString();

  const [{ results: cookies = [] }, { results: scripts = [] }] = await Promise.all([
    db
      .prepare(`SELECT name, domain, category, provider FROM Cookie WHERE siteId = ?1 AND firstSeenAt >= ?2 AND firstSeenAt < ?3 AND name NOT LIKE 'consentbit%' ORDER BY name LIMIT 200`)
      .bind(scan.siteId, scan.createdAt, until)
      .all(),
    db
      .prepare(`SELECT scriptUrl, category FROM Script WHERE siteId = ?1 AND createdAt >= ?2 AND createdAt < ?3 ORDER BY createdAt LIMIT 200`)
      .bind(scan.siteId, scan.createdAt, until)
      .all(),
  ]);

  const alert = buildAlert({ cookies, scripts });
  if (!alert) {
    await saveSummary(db, scan.id, { newCookies: 0, newScripts: 0 });
    return 'quiet';
  }

  const domain = site?.domain || scan.siteId;
  const recipients = await collectRecipients(db, site);
  const dashboardUrl = `${String(env.WEBAPP_PUBLIC_URL || 'https://accounts.consentbit.com').replace(/\/$/, '')}/dashboard/${scan.siteId}/scan`;

  if (mode === 'dry-run') {
    console.log(`[NewTrackerAlerts] dry-run ${domain}: ${alert.cookieCount} new cookie(s), ${alert.scriptCount} new script(s); would email ${recipients.map((r) => r.email).join(', ') || 'nobody'}`);
    await saveSummary(db, scan.id, { newCookies: alert.cookieCount, newScripts: alert.scriptCount, dryRun: true, recipients: recipients.map((r) => r.email) });
    return 'dry-run';
  }

  for (const r of recipients) {
    sendNewTrackerEmail(env, ctx, { to: r.email, name: r.name, domain, alert, dashboardUrl });
  }
  await saveSummary(db, scan.id, { newCookies: alert.cookieCount, newScripts: alert.scriptCount, recipients: recipients.map((r) => r.email) });
  return recipients.length ? 'emailed' : 'no-recipients';
}

async function collectRecipients(db, site) {
  const list = [];
  const seen = new Set();
  const add = (r) => {
    const email = String(r?.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) return;
    seen.add(email);
    list.push({ email, name: r.name || null });
  };
  const organizationId = site?.organizationId ?? site?.organizationid ?? null;
  if (organizationId) add(await getOrgOwnerEmail(db, organizationId));
  if (site?.id) for (const a of await listSiteAdminRecipients(db, site.id)) add(a);
  return list;
}

async function saveSummary(db, scanId, summary) {
  await db.prepare(`UPDATE ScanHistory SET alertSummary = ?1 WHERE id = ?2`).bind(JSON.stringify(summary), scanId).run();
}
