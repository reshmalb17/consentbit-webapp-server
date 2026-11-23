// src/services/legacyRetention.js
//
// Retention for the PRE-D1 consent stores. Same rule as services/consentRetention.js
// (2026-10-15): entries older than 12 months (US / CCPA: 24 months) are copied into
// consentbit-retention-data (RETENTION_DB → RetainedLegacyConsent), the copy is
// confirmed, and only then removed from the old store.
//
//   kv-webflow  WEBFLOW_AUTHENTICATION  Cookie-Preferences:{domain}:{visitorId}  one entry per key
//   kv-framer   CONSENT_STORE_FRAMER    consent:{platformSiteId}                 array per site
//   r2-v2       R2                      consent-v2/{site}/{visitorId}.json        array per visitor
//
// NOT covered: R2 Cookie-Preferences.json (one file holding every site). cb-server still
// rewrites it on each consent (read → add → write), so editing it here would race with
// that and either lose a new consent or have the old entries written straight back.
//
// Runs under the same switch as the D1 sweep (CONSENT_RETENTION_MODE, 'dry-run' counts)
// and in the same window (1st and 15th of the month, from 03:00 UTC). Each source walks
// its keys with a cursor kept in RETENTION_DB.LegacyRetentionState, a slice per tick; a
// pass that does not finish in one run carries on at the next. An entry with no
// readable timestamp is never moved.

import { retentionMode, inSweepWindow, MOVE_GDPR_DAYS, MOVE_CCPA_DAYS } from './consentRetention.js';

const KV_KEYS_PER_TICK = 50;
const FRAMER_KEYS_PER_TICK = 1;
const R2_LIST_PER_TICK = 1000;
const R2_OBJECTS_PER_TICK = 50;
const INSERT_CHUNK = 100;

function entryTimeMs(entry) {
  const ts = entry?.timestamp || entry?.lastUpdated || entry?.preferences?.lastUpdated || entry?.metadata?.timestamp;
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : null;
}

/** Same CCPA test the legacy dashboard uses (legacyConsentHelpers.transformEntry). */
function entryRegulation(entry) {
  const prefs = entry?.preferences || {};
  if (entry?.bannerType === 'CCPA' || entry?.lawType === 'CCPA' || prefs.bannerType === 'CCPA') return 'ccpa';
  const ccpaSignal = prefs.doNotShare !== undefined || prefs.doNotSell !== undefined ||
    prefs.donotshare !== undefined || prefs.donotselldata !== undefined;
  const gdprTrue = !!(prefs.marketing || prefs.Marketing || prefs.analytics || prefs.Analytics ||
    prefs.personalization || prefs.Personalization);
  return ccpaSignal && !gdprTrue ? 'ccpa' : 'gdpr';
}

/** true = past its period. null timestamp = keep. */
function isExpired(entry, nowMs) {
  const t = entryTimeMs(entry);
  if (t === null) return false;
  const days = entryRegulation(entry) === 'ccpa' ? MOVE_CCPA_DAYS : MOVE_GDPR_DAYS;
  return t < nowMs - days * 86400000;
}

/**
 * Copy rows into RetainedLegacyConsent and return the ids now held there.
 * rows: { id, source, storeKey, siteKey, visitorId, entry }
 */
async function copyRows(rdb, rows, nowIso) {
  const held = new Set();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK).map((r) => {
      const t = entryTimeMs(r.entry);
      return {
        id: r.id, source: r.source, storeKey: r.storeKey, siteKey: r.siteKey ?? null,
        visitorId: r.visitorId ?? null, regulation: entryRegulation(r.entry),
        createdAt: t === null ? null : new Date(t).toISOString(), entry: r.entry,
      };
    });
    await rdb
      .prepare(
        `INSERT OR IGNORE INTO RetainedLegacyConsent
           (id, source, storeKey, siteKey, visitorId, regulation, createdAt, retainedAt, entryJson)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.source'), json_extract(value, '$.storeKey'),
                json_extract(value, '$.siteKey'), json_extract(value, '$.visitorId'), json_extract(value, '$.regulation'),
                json_extract(value, '$.createdAt'), ?2, json_extract(value, '$.entry')
         FROM json_each(?1)`,
      )
      .bind(JSON.stringify(chunk), nowIso)
      .run();
    const { results } = await rdb
      .prepare('SELECT id FROM RetainedLegacyConsent WHERE id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(chunk.map((c) => c.id)))
      .all();
    for (const r of results || []) held.add(String(r.id));
  }
  return held;
}

async function readState(rdb, source) {
  return rdb
    .prepare('SELECT cursor, lastPassDoneDate FROM LegacyRetentionState WHERE source = ?1')
    .bind(source)
    .first()
    .catch(() => null);
}

async function writeState(rdb, source, cursor, lastPassDoneDate, nowIso) {
  await rdb
    .prepare(
      `INSERT INTO LegacyRetentionState (source, cursor, lastPassDoneDate, updatedAt) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(source) DO UPDATE SET cursor = ?2, lastPassDoneDate = ?3, updatedAt = ?4`,
    )
    .bind(source, cursor, lastPassDoneDate, nowIso)
    .run();
}

async function logRun(rdb, source, mode, affected, nowIso) {
  if (affected <= 0) return;
  await rdb
    .prepare('INSERT INTO LegacyRetentionLog (source, runAt, mode, affectedCount) VALUES (?1, ?2, ?3, ?4)')
    .bind(source, nowIso, mode === 'on' ? 'moved' : mode, affected)
    .run()
    .catch(() => {});
}

/**
 * Run one tick of one source. `step(cursor)` processes a slice and returns
 * { affected, nextCursor } — nextCursor null means the pass reached the end.
 */
async function runSource(rdb, source, mode, today, nowIso, step) {
  const state = await readState(rdb, source);
  const cursor = state?.cursor || null;
  if (!cursor && state?.lastPassDoneDate === today) return { source, skipped: 'done-today' };
  const { affected, nextCursor } = await step(cursor);
  await writeState(rdb, source, nextCursor, nextCursor ? state?.lastPassDoneDate ?? null : today, nowIso);
  await logRun(rdb, source, mode, affected, nowIso);
  return { source, affected, done: !nextCursor };
}

// ── kv-webflow: one entry per key ────────────────────────────────────────────
function webflowStep(kv, rdb, mode, nowMs, nowIso) {
  return async (cursor) => {
    const listed = await kv.list({ prefix: 'Cookie-Preferences:', limit: KV_KEYS_PER_TICK, ...(cursor ? { cursor } : {}) });
    const rows = [];
    for (const k of listed.keys || []) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      let entry;
      try { entry = JSON.parse(raw); } catch (_) { continue; }
      if (!isExpired(entry, nowMs)) continue;
      const parts = k.name.split(':');
      rows.push({
        id: `kv-webflow:${k.name}:${entryTimeMs(entry)}`, source: 'kv-webflow', storeKey: k.name,
        siteKey: parts[1] || null, visitorId: parts.slice(2).join(':') || entry.visitorId || null, entry,
      });
    }
    let affected = rows.length;
    if (mode === 'on' && rows.length) {
      const held = await copyRows(rdb, rows, nowIso);
      affected = 0;
      for (const r of rows) {
        if (!held.has(r.id)) continue;
        await kv.delete(r.storeKey);
        affected++;
      }
    }
    return { affected, nextCursor: listed.list_complete ? null : listed.cursor };
  };
}

// ── kv-framer: array per site, no longer written (framerConsent.js uses D1) ─
function framerStep(kv, rdb, mode, nowMs, nowIso) {
  return async (cursor) => {
    const listed = await kv.list({ prefix: 'consent:', limit: FRAMER_KEYS_PER_TICK, ...(cursor ? { cursor } : {}) });
    let affected = 0;
    for (const k of listed.keys || []) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      let arr;
      try { arr = JSON.parse(raw); } catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      const siteKey = k.name.slice('consent:'.length);
      const rows = [];
      const keep = [];
      arr.forEach((entry, i) => {
        if (isExpired(entry, nowMs)) {
          const vid = entry?._visitorId || entry?.visitorId || null;
          rows.push({ id: `kv-framer:${k.name}:${vid}:${entryTimeMs(entry)}:${i}`, source: 'kv-framer', storeKey: k.name, siteKey, visitorId: vid, entry });
        } else {
          keep.push(entry);
        }
      });
      if (!rows.length) continue;
      if (mode !== 'on') { affected += rows.length; continue; }
      const held = await copyRows(rdb, rows, nowIso);
      // Any copy unconfirmed: keep that entry in the array too.
      const unconfirmed = rows.filter((r) => !held.has(r.id)).map((r) => r.entry);
      const remaining = [...keep, ...unconfirmed];
      if (remaining.length) await kv.put(k.name, JSON.stringify(remaining));
      else await kv.delete(k.name);
      affected += rows.length - unconfirmed.length;
    }
    return { affected, nextCursor: listed.list_complete ? null : listed.cursor };
  };
}

// ── r2-v2: array per visitor file ────────────────────────────────────────────
// The listing's `uploaded` date pre-filters: a file last written inside the shorter
// (12-month) period cannot hold anything expired, so it is not even read.
function r2Step(r2, rdb, mode, nowMs, nowIso) {
  return async (cursor) => {
    const listCursor = cursor && cursor !== 'start' ? cursor : undefined;
    const listed = await r2.list({ prefix: 'consent-v2/', limit: R2_LIST_PER_TICK, ...(listCursor ? { cursor: listCursor } : {}) });
    const gdprCutoffMs = nowMs - MOVE_GDPR_DAYS * 86400000;
    const candidates = (listed.objects || [])
      .filter((o) => o.uploaded && new Date(o.uploaded).getTime() < gdprCutoffMs)
      .slice(0, R2_OBJECTS_PER_TICK);
    let affected = 0;
    for (const o of candidates) {
      const obj = await r2.get(o.key);
      if (!obj) continue;
      let arr;
      try { arr = JSON.parse(await obj.text()); } catch (_) { continue; }
      if (!Array.isArray(arr)) continue;
      const parts = o.key.split('/');
      const siteKey = parts[1] || null;
      const visitorId = (parts[parts.length - 1] || '').replace(/\.json$/, '') || null;
      const rows = [];
      const keep = [];
      arr.forEach((entry, i) => {
        if (isExpired(entry, nowMs)) rows.push({ id: `r2-v2:${o.key}:${entryTimeMs(entry)}:${i}`, source: 'r2-v2', storeKey: o.key, siteKey, visitorId, entry });
        else keep.push(entry);
      });
      if (!rows.length) continue;
      if (mode !== 'on') { affected += rows.length; continue; }
      const held = await copyRows(rdb, rows, nowIso);
      const unconfirmed = rows.filter((r) => !held.has(r.id)).map((r) => r.entry);
      const remaining = [...keep, ...unconfirmed];
      if (remaining.length) {
        await r2.put(o.key, JSON.stringify(remaining), { httpMetadata: { contentType: 'application/json' } });
      } else {
        await r2.delete(o.key);
      }
      affected += rows.length - unconfirmed.length;
    }
    // More candidates in this page than the per-tick cap: stay on this page next tick
    // (the moved files are gone, so it moves on to the rest).
    const totalCandidates = (listed.objects || []).filter((o) => o.uploaded && new Date(o.uploaded).getTime() < gdprCutoffMs).length;
    if (totalCandidates > R2_OBJECTS_PER_TICK && mode === 'on') return { affected, nextCursor: cursor || 'start' };
    return { affected, nextCursor: listed.truncated ? listed.cursor : null };
  };
}

/** Called from scheduled() every tick. No-op outside the window or when the mode is off. */
export async function runLegacyRetentionSweep(env, { now = new Date() } = {}) {
  const mode = retentionMode(env);
  if (mode === 'off') return { skipped: 'off' };
  if (!inSweepWindow(now)) return { skipped: 'outside-window' };
  const rdb = env?.RETENTION_DB;
  if (!rdb) {
    console.warn('[LegacyRetention] RETENTION_DB not bound — sweep refused.');
    return { skipped: 'no-retention-db' };
  }

  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  const out = [];
  const run = async (source, store, makeStep) => {
    if (!store) return;
    try {
      out.push(await runSource(rdb, source, mode, today, nowIso, makeStep(store, rdb, mode, nowMs, nowIso)));
    } catch (err) {
      console.warn(`[LegacyRetention] ${source} failed:`, err?.message);
    }
  };
  await run('kv-webflow', env.WEBFLOW_AUTHENTICATION, webflowStep);
  await run('kv-framer', env.CONSENT_STORE_FRAMER, framerStep);
  await run('r2-v2', env.R2, r2Step);
  return { mode, results: out };
}
