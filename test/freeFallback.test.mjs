// node --test test/freeFallback.test.mjs
// The Free-fallback rule (services/freeFallback.js) against a real D1 (Miniflare) with
// the production Site / Subscription column names.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

let mod, mf, db;
const envOn = { FREE_FALLBACK: 'on' };

before(async () => {
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  register(pathToFileURL('./test/freeFallback-loader.mjs'), pathToFileURL('./'));
  mod = await import('../src/services/freeFallback.js');

  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  await db.batch([
    db.prepare(`CREATE TABLE Site (id TEXT PRIMARY KEY, organizationId TEXT, name TEXT, domain TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME)`),
    db.prepare(`CREATE TABLE Subscription (id TEXT PRIMARY KEY, organizationId TEXT, siteId TEXT, planId TEXT, status TEXT, currentPeriodEnd DATETIME, stripeSubscriptionId TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME)`),
  ]);
});

after(async () => { await mf?.dispose(); });

beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM Subscription'), db.prepare('DELETE FROM Site')]);
});

const future = new Date(Date.now() + 30 * 86400e3).toISOString();
const past = new Date(Date.now() - 2 * 86400e3).toISOString();
let seq = 0;

async function site(id, org, domain, createdAt = `2026-01-0${(seq++ % 9) + 1}T00:00:00Z`) {
  await db.prepare('INSERT INTO Site (id, organizationId, name, domain, createdAt) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, org, domain, domain, createdAt).run();
}
async function sub(siteId, org, status, planId = 'growth', periodEnd = past, updatedAt = new Date().toISOString()) {
  await db.prepare('INSERT INTO Subscription (id, organizationId, siteId, planId, status, currentPeriodEnd, stripeSubscriptionId, updatedAt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(`sub_${siteId}_${status}_${Math.random().toString(36).slice(2, 6)}`, org, siteId, planId, status, periodEnd, `stripe_${siteId}_${status}`, updatedAt).run();
}

test('mode parsing', () => {
  assert.equal(mod.freeFallbackMode({ FREE_FALLBACK: 'on' }), 'on');
  assert.equal(mod.freeFallbackMode({ FREE_FALLBACK: 'dry-run' }), 'dry-run');
  assert.equal(mod.freeFallbackMode({ FREE_FALLBACK: 'off' }), 'off');
  assert.equal(mod.freeFallbackMode({}), 'off');
});

test('classify: never subscribed → free; live → paid; cancelled with time left → paid; ended → lapsed', async () => {
  await site('s-free', 'org1', 'free.example');
  await site('s-paid', 'org1', 'paid.example');
  await site('s-cancel', 'org1', 'cancel.example');
  await site('s-ended', 'org1', 'ended.example');
  await sub('s-paid', 'org1', 'active');
  await sub('s-cancel', 'org1', 'canceled', 'basic', future);
  await sub('s-ended', 'org1', 'unpaid');
  assert.equal((await mod.classifySiteEntitlement(db, 's-free')).kind, 'free');
  assert.equal((await mod.classifySiteEntitlement(db, 's-paid')).kind, 'paid');
  assert.equal((await mod.classifySiteEntitlement(db, 's-cancel')).kind, 'paid');
  assert.equal((await mod.classifySiteEntitlement(db, 's-ended')).kind, 'lapsed');
});

test('classify: a live row outranks a dead one on the same site (cancel → resubscribe)', async () => {
  await site('s1', 'org1', 'one.example');
  await sub('s1', 'org1', 'canceled', 'basic', past, new Date(Date.now() + 1000).toISOString()); // touched later
  await sub('s1', 'org1', 'active', 'growth', future, new Date(Date.now() - 1000).toISOString());
  assert.equal((await mod.classifySiteEntitlement(db, 's1')).kind, 'paid');
});

test('ended site alone in the account moves to Free; second call is a no-op', async () => {
  await site('s1', 'org1', 'one.example');
  await sub('s1', 'org1', 'unpaid');
  const r1 = await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's1', trigger: 'test' });
  assert.equal(r1.outcome, 'moved');
  assert.ok(r1.freeFallbackAt);
  const row = await db.prepare('SELECT freeFallbackAt, freeFallbackReason FROM Site WHERE id = ?1').bind('s1').first();
  assert.ok(row.freeFallbackAt);
  assert.equal(row.freeFallbackReason, 'test');
  assert.equal((await mod.classifySiteEntitlement(db, 's1')).kind, 'free-fallback');
  assert.equal(await mod.siteIsOnFreeFallback(db, 's1'), true);
  const r2 = await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's1', trigger: 'test-again' });
  assert.equal(r2.outcome, 'already');
  const again = await db.prepare('SELECT freeFallbackReason FROM Site WHERE id = ?1').bind('s1').first();
  assert.equal(again.freeFallbackReason, 'test', 'first stamp is kept');
});

test('ended site is blocked when a sibling never had a plan (the sibling IS the free site)', async () => {
  await site('s-free', 'org1', 'free.example');
  await site('s-ended', 'org1', 'ended.example');
  await sub('s-ended', 'org1', 'canceled', 'growth', past);
  const r = await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-ended', trigger: 'test' });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.blockedBy.domain, 'free.example');
  assert.equal((await mod.classifySiteEntitlement(db, 's-ended')).kind, 'lapsed');
  const fields = await mod.freeFallbackFieldsForSite(db, 's-ended');
  assert.equal(fields.freeFallback, false);
  assert.equal(fields.freeBlockedBy.domain, 'free.example');
  assert.match(mod.freeBlockedMessage(fields.freeBlockedBy), /free\.example already uses the one Free site/);
});

test('a sibling whose plan ended but was NOT moved does not hold the slot; once moved, it does', async () => {
  await site('s-a', 'org1', 'a.example');
  await site('s-b', 'org1', 'b.example');
  await sub('s-a', 'org1', 'unpaid');
  await sub('s-b', 'org1', 'unpaid');
  assert.equal(await mod.findOtherFreeSite(db, 'org1', 's-a'), null, 'b is blocked, not free');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-a', trigger: 't' })).outcome, 'moved');
  const rb = await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-b', trigger: 't' });
  assert.equal(rb.outcome, 'blocked');
  assert.equal(rb.blockedBy.domain, 'a.example');
});

test('a paid sibling and a cancelled-with-time-left sibling do not hold the slot', async () => {
  await site('s-paid', 'org1', 'paid.example');
  await site('s-cancel', 'org1', 'cancel.example');
  await site('s-ended', 'org1', 'ended.example');
  await sub('s-paid', 'org1', 'trialing', 'essential', future);
  await sub('s-cancel', 'org1', 'canceled', 'basic', future);
  await sub('s-ended', 'org1', 'incomplete_expired');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-ended', trigger: 't' })).outcome, 'moved');
});

test('sites in OTHER accounts never count', async () => {
  await site('s-other', 'org2', 'other.example');
  await site('s-ended', 'org1', 'ended.example');
  await sub('s-ended', 'org1', 'unpaid');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-ended', trigger: 't' })).outcome, 'moved');
});

test('paid, free and cancelled-in-period sites are left alone', async () => {
  await site('s-free', 'org1', 'free.example');
  await site('s-paid', 'org1', 'paid.example');
  await site('s-cancel', 'org1', 'cancel.example');
  await sub('s-paid', 'org1', 'active');
  await sub('s-cancel', 'org1', 'canceled', 'basic', future);
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-free', trigger: 't' })).outcome, 'free');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-paid', trigger: 't' })).outcome, 'entitled');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's-cancel', trigger: 't' })).outcome, 'entitled');
  for (const id of ['s-free', 's-paid', 's-cancel']) {
    const row = await db.prepare('SELECT freeFallbackAt FROM Site WHERE id = ?1').bind(id).first();
    assert.equal(row.freeFallbackAt, null);
  }
});

test('flag off and dry-run write nothing', async () => {
  await site('s1', 'org1', 'one.example');
  await sub('s1', 'org1', 'unpaid');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, {}, { siteId: 's1', trigger: 't' })).outcome, 'off');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, { FREE_FALLBACK: 'dry-run' }, { siteId: 's1', trigger: 't' })).outcome, 'dry-run');
  const row = await db.prepare('SELECT freeFallbackAt FROM Site WHERE id = ?1').bind('s1').first();
  assert.equal(row.freeFallbackAt, null);
  assert.equal((await mod.classifySiteEntitlement(db, 's1')).kind, 'lapsed');
});

test('a moved site that buys again is paid again and gives the Free slot back', async () => {
  await site('s1', 'org1', 'one.example');
  await site('s2', 'org1', 'two.example');
  await sub('s2', 'org1', 'active', 'essential', future); // s2 is paid, so the slot is open
  await sub('s1', 'org1', 'unpaid');
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's1', trigger: 't' })).outcome, 'moved');
  await sub('s1', 'org1', 'active', 'growth', future);
  assert.equal((await mod.classifySiteEntitlement(db, 's1')).kind, 'paid');
  // While s1 is paid, s2 may take the Free slot when ITS plan ends.
  await db.prepare(`UPDATE Subscription SET status = 'unpaid', currentPeriodEnd = ?1 WHERE siteId = 's2'`).bind(past).run();
  assert.equal((await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's2', trigger: 't' })).outcome, 'moved');
  // Buying again clears the stamp (saveSubscription in db.js calls this), so when the new
  // plan ends the rule is judged afresh — and s2 now holds the slot, so s1 stays lapsed.
  assert.equal(await mod.clearFreeFallbackForSite(db, 's1'), true);
  assert.equal(await mod.clearFreeFallbackForSite(db, 's1'), false, 'nothing left to clear');
  await db.prepare(`UPDATE Subscription SET status = 'canceled', currentPeriodEnd = ?1 WHERE siteId = 's1' AND status = 'active'`).bind(past).run();
  assert.equal((await mod.classifySiteEntitlement(db, 's1')).kind, 'lapsed');
  const r = await mod.moveSiteToFreeIfAllowed(db, envOn, { siteId: 's1', trigger: 't' });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.blockedBy.domain, 'two.example');
});
