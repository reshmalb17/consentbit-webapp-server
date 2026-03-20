// GET /api/debug/schema?key=<DEBUG_SCHEMA_KEY>
// Returns list of DB tables and a sample of PageviewUsage so you can verify schema and pageviews.
// Set DEBUG_SCHEMA_KEY in wrangler (e.g. vars or secret) and call with ?key= that value.

import { ensureSchema } from '../services/db.js';

export async function handleDebugSchema(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ error: 'Database not available' }, { status: 503 });
  }
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const expected = env.DEBUG_SCHEMA_KEY;
  if (!expected || key !== expected) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  await ensureSchema(db);

  const tablesResult = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all();
  const tables = (tablesResult.results || []).map((r) => r.name);

  let pageviewSample = [];
  try {
    const pvResult = await db.prepare(
      `SELECT id, siteId, yearMonth, pageviewCount, updatedAt FROM PageviewUsage ORDER BY updatedAt DESC LIMIT 20`
    ).all();
    pageviewSample = pvResult.results || [];
  } catch (e) {
    pageviewSample = [{ error: e.message }];
  }

  return Response.json({
    tables,
    pageviewSample,
    message: 'Set DEBUG_SCHEMA_KEY in wrangler and call GET /api/debug/schema?key=<value> to verify tables and pageviews.',
  });
}
