// src/handlers/adminBackfillFramerSiteId.js
import { checkAdminAuth } from '../utils/adminAuth.js';
// One-time migration: iterates all ACTIVE_SITES_CONSENTBIT_FRAMER KV entries,
// fetches each site's public HTML to extract the Framer site ID (data-fid), and updates the entry.

async function resolveFramerSiteId(domain) {
  if (!domain) return null;
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<script[^>]*src="https:\/\/events\.framer\.com\/script\?v=2"[^>]*data-fid="([^"]+)"/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function handleAdminBackfillFramerSiteId(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const kv = env.ACTIVE_SITES_CONSENTBIT_FRAMER;
  if (!kv) {
    return Response.json({ success: false, error: 'ACTIVE_SITES_CONSENTBIT_FRAMER KV not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';
  const concurrency = Math.min(parseInt(url.searchParams.get('concurrency') || '5', 10), 10);

  // Collect all KV keys via cursor pagination
  const allKeys = [];
  let cursor;
  do {
    const listed = await kv.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const k of listed.keys) allKeys.push(k.name);
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);

  const results = { total: allKeys.length, updated: 0, skipped: 0, failed: 0, details: [] };

  for (let i = 0; i < allKeys.length; i += concurrency) {
    const batch = allKeys.slice(i, i + concurrency);
    await Promise.all(batch.map(async (key) => {
      try {
        const raw = await kv.get(key, { type: 'json' });
        if (!raw || typeof raw !== 'object') {
          results.skipped++;
          results.details.push({ key, status: 'skipped', reason: 'empty or non-object value' });
          return;
        }

        if (raw.framerSiteId) {
          results.skipped++;
          results.details.push({ key, status: 'skipped', reason: 'framerSiteId already set', framerSiteId: raw.framerSiteId });
          return;
        }

        // key is the domain (e.g. https://example.framer.app or a custom domain)
        const framerSiteId = await resolveFramerSiteId(key);
        if (!framerSiteId) {
          results.skipped++;
          results.details.push({ key, status: 'skipped', reason: 'not a Framer site or fetch failed' });
          return;
        }

        if (!dryRun) {
          await kv.put(key, JSON.stringify({ ...raw, framerSiteId, lastUpdated: new Date().toISOString() }));
        }

        results.updated++;
        results.details.push({ key, status: dryRun ? 'dry-run' : 'updated', framerSiteId });
      } catch (err) {
        results.failed++;
        results.details.push({ key, status: 'error', reason: err?.message });
      }
    }));
  }

  return Response.json({ success: true, dryRun, ...results });
}
