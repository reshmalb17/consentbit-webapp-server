// src/handlers/adminSeedLegacy.js
import { ensureSchema, migrateLegacyUsers } from '../services/db.js';

export async function handleAdminSeedLegacy(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not configured' }, { status: 503 });
  }

  await ensureSchema(db);

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '0', 10);

  const results = await migrateLegacyUsers(
    db,
    env.ACTIVE_SITES_CONSENTBIT || null,
    env.ACTIVE_SITES_CONSENTBIT_FRAMER || null,
    env.LEGACY_DB || null,
    limit,
  );

  return Response.json({
    success: true,
    summary: {
      migrated: results.migrated.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
      remaining: results.remaining,
    },
    migrated: results.migrated,
    skipped: results.skipped,
    errors: results.errors,
    ...(results.remaining > 0 && { note: `Run again — ${results.remaining} entries still pending` }),
  });
}
