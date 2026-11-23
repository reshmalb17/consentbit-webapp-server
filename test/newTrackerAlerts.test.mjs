// node --test test/newTrackerAlerts.test.mjs
// Runs the alert pass against a real D1 (Miniflare) with the production table shapes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

// The service imports db.js/team.js/email.js, which pull in the rest of the worker.
// We stub the three functions it uses so the test exercises only the alert logic.
const sent = [];
let planId = 'growth';
const dbStub = {
  getOrgOwnerEmail: async () => ({ email: 'Owner@Example.com', name: 'Olive' }),
  getEffectivePlanForOrganization: async () => ({ planId, plan: { id: planId }, subscription: null }),
};
const teamStub = { listSiteAdminRecipients: async () => [{ email: 'owner@example.com', name: 'dup' }, { email: 'admin@example.com', name: 'Ada' }] };
const emailStub = { sendNewTrackerEmail: (env, ctx, args) => { sent.push(args); return Promise.resolve(); } };

let mod, mf, db;

before(async () => {
  // Resolve the service with its three dependencies swapped for stubs.
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  globalThis.__alertStubs = { dbStub, teamStub, emailStub };
  register(pathToFileURL('./test/stub-loader.mjs'), pathToFileURL('./'));
  mod = await import('../src/services/newTrackerAlerts.js');

  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare(`CREATE TABLE Site (id TEXT PRIMARY KEY, domain TEXT, organizationId TEXT)`),
    db.prepare(`CREATE TABLE ScanHistory (id TEXT PRIMARY KEY, siteId TEXT NOT NULL, scanUrl TEXT, scriptsFound INTEGER DEFAULT 0, cookiesFound INTEGER DEFAULT 0, scanDuration INTEGER, scanStatus TEXT DEFAULT 'completed', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, categories TEXT)`),
    db.prepare(`CREATE TABLE Cookie (id TEXT PRIMARY KEY, siteId TEXT NOT NULL, scanHistoryId TEXT, name TEXT NOT NULL, domain TEXT, category TEXT NOT NULL, provider TEXT, firstSeenAt DATETIME, lastSeenAt DATETIME)`),
    db.prepare(`CREATE TABLE Script (id TEXT PRIMARY KEY, siteId TEXT NOT NULL, scriptUrl TEXT NOT NULL, category TEXT NOT NULL, createdAt DATETIME)`),
    db.prepare(`INSERT INTO Site VALUES ('s1', 'shop.example', 'org1')`),
  ]);
});

after(async () => { await mf?.dispose(); });

const env = () => ({ CONSENT_WEBAPP: db, NEW_TRACKER_ALERTS: 'on', WEBAPP_PUBLIC_URL: 'https://accounts.test/' });
const T = (min) => new Date(Date.UTC(2026, 10, 4, 5, min)).toISOString();

test('buildAlert ignores necessary cookies and dedupes scripts', () => {
  assert.equal(mod.buildAlert({ cookies: [{ name: 'sess', category: 'Necessary' }], scripts: [] }), null);
  const a = mod.buildAlert({ cookies: [{ name: '_ga', category: 'analytics', domain: '.shop.example' }], scripts: [{ scriptUrl: 'https://x/a.js', category: 'marketing' }, { scriptUrl: 'https://x/a.js', category: 'marketing' }] });
  assert.equal(a.cookieCount, 1);
  assert.equal(a.scriptCount, 1);
});

test('flag off: nothing happens, no columns needed', async () => {
  const r = await mod.runNewTrackerAlerts({ CONSENT_WEBAPP: db, NEW_TRACKER_ALERTS: 'off' }, null);
  assert.deepEqual(r, { skipped: 'off' });
});

test('first scheduled scan is a baseline: no email, columns added, alertedAt set', async () => {
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('scan1', 's1', 'completed', ?1)`).bind(T(0)).run();
  await mod.markScheduledScan(db, 'scan1');
  await db.prepare(`INSERT INTO Cookie VALUES ('c1', 's1', 'scan1', '_ga', '.shop.example', 'analytics', 'Google', ?1, ?1)`).bind(T(1)).run();
  const r = await mod.runNewTrackerAlerts(env(), null, { now: new Date(T(5)) });
  assert.equal(r.baseline, 1);
  assert.equal(sent.length, 0);
  const row = await db.prepare(`SELECT triggeredBy, alertedAt, alertSummary FROM ScanHistory WHERE id = 'scan1'`).first();
  assert.equal(row.triggeredBy, 'scheduled');
  assert.ok(row.alertedAt);
  assert.match(row.alertSummary, /baseline/);
});

test('second scan with nothing new: quiet, no email', async () => {
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('scan2', 's1', 'completed', ?1)`).bind(T(10)).run();
  await mod.markScheduledScan(db, 'scan2');
  // Same cookie re-seen: firstSeenAt stays, lastSeenAt moves (what upsertCookies does).
  await db.prepare(`UPDATE Cookie SET lastSeenAt = ?1, scanHistoryId = 'scan2' WHERE id = 'c1'`).bind(T(11)).run();
  const r = await mod.runNewTrackerAlerts(env(), null, { now: new Date(T(15)) });
  assert.equal(r.quiet, 1);
  assert.equal(sent.length, 0);
});

test('third scan with a new marketing cookie and a new script: one email per recipient, deduped', async () => {
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('scan3', 's1', 'completed', ?1)`).bind(T(20)).run();
  await mod.markScheduledScan(db, 'scan3');
  await db.prepare(`INSERT INTO Cookie VALUES ('c2', 's1', 'scan3', '_fbp', '.shop.example', 'marketing', 'Meta', ?1, ?1)`).bind(T(21)).run();
  await db.prepare(`INSERT INTO Cookie VALUES ('c3', 's1', 'scan3', 'csrf', '.shop.example', 'necessary', NULL, ?1, ?1)`).bind(T(21)).run();
  await db.prepare(`INSERT INTO Script VALUES ('x1', 's1', 'https://connect.facebook.net/en_US/fbevents.js', 'marketing', ?1)`).bind(T(21)).run();
  const r = await mod.runNewTrackerAlerts(env(), null, { now: new Date(T(25)) });
  assert.equal(r.emailed, 1);
  assert.equal(sent.length, 2, 'owner + admin, duplicate owner dropped');
  assert.deepEqual(sent.map((s) => s.to).sort(), ['admin@example.com', 'owner@example.com']);
  assert.equal(sent[0].domain, 'shop.example');
  assert.equal(sent[0].alert.cookieCount, 1, 'necessary cookie not counted');
  assert.equal(sent[0].alert.scriptCount, 1);
  assert.equal(sent[0].dashboardUrl, 'https://accounts.test/dashboard/s1/scan');
  const row = await db.prepare(`SELECT alertSummary FROM ScanHistory WHERE id = 'scan3'`).first();
  assert.match(row.alertSummary, /"newCookies":1/);
});

test('already alerted scans are never processed again; manual scans are ignored', async () => {
  sent.length = 0;
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('manual', 's1', 'completed', ?1)`).bind(T(30)).run();
  await db.prepare(`INSERT INTO Cookie VALUES ('c4', 's1', 'manual', '_hjid', '.shop.example', 'analytics', 'Hotjar', ?1, ?1)`).bind(T(31)).run();
  const r = await mod.runNewTrackerAlerts(env(), null, { now: new Date(T(35)) });
  assert.equal(r.checked, 0);
  assert.equal(sent.length, 0);
});

test('dry-run logs and records but does not email', async () => {
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('scan4', 's1', 'completed', ?1)`).bind(T(40)).run();
  await mod.markScheduledScan(db, 'scan4');
  await db.prepare(`INSERT INTO Script VALUES ('x2', 's1', 'https://static.hotjar.com/c/hotjar-1.js', 'analytics', ?1)`).bind(T(41)).run();
  const r = await mod.runNewTrackerAlerts({ ...env(), NEW_TRACKER_ALERTS: 'dry-run' }, null, { now: new Date(T(45)) });
  assert.equal(r.checked, 1);
  assert.equal(sent.length, 0);
  const row = await db.prepare(`SELECT alertSummary FROM ScanHistory WHERE id = 'scan4'`).first();
  assert.match(row.alertSummary, /"dryRun":true/);
});

test('Essential site: scan is marked handled but nobody is emailed', async () => {
  planId = 'essential';
  sent.length = 0;
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('scan5', 's1', 'completed', ?1)`).bind(T(46)).run();
  await mod.markScheduledScan(db, 'scan5');
  await db.prepare(`INSERT INTO Cookie VALUES ('c5', 's1', 'scan5', '_gcl_au', '.shop.example', 'marketing', 'Google', ?1, ?1)`).bind(T(47)).run();
  const r = await mod.runNewTrackerAlerts(env(), null, { now: new Date(T(48)) });
  assert.equal(r.notGrowth, 1);
  assert.equal(sent.length, 0);
  const row = await db.prepare(`SELECT alertedAt, alertSummary FROM ScanHistory WHERE id = 'scan5'`).first();
  assert.ok(row.alertedAt);
  assert.match(row.alertSummary, /"skipped":"plan"/);
  planId = 'growth';
});

test('old scans beyond the look-back window are left alone', async () => {
  await db.prepare(`INSERT INTO ScanHistory (id, siteId, scanStatus, createdAt) VALUES ('old', 's1', 'completed', '2026-10-01T00:00:00.000Z')`).run();
  await mod.markScheduledScan(db, 'old');
  const r = await mod.runNewTrackerAlerts(env(), null, { now: new Date(T(50)) });
  assert.equal(r.checked, 0);
});
