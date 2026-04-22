// POST /api/admin/seed-banner-configs
// Migrates legacy banner customization from WEBFLOW_AUTHENTICATION KV and
// BANNER_KV_FRAMER into BANNER_CONFIG_DB, and tags matching Sites in CONSENT_WEBAPP.
import { migrateBannerConfigs, migrateFramerBannerConfigs } from '../services/db.js';

export async function handleAdminSeedBannerConfigs(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  const bannerConfigDb = env.BANNER_CONFIG_DB;

  if (!db) return Response.json({ success: false, error: 'Database not configured' }, { status: 503 });
  if (!bannerConfigDb) return Response.json({ success: false, error: 'BANNER_CONFIG_DB not configured' }, { status: 503 });

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';

  const [webflowResults, framerResults] = await Promise.all([
    env.WEBFLOW_AUTHENTICATION
      ? migrateBannerConfigs(null, env.WEBFLOW_AUTHENTICATION, db, force)
      : { migrated: 0, skipped: 0, errors: [], siteTagged: 0 },
    env.BANNER_KV_FRAMER
      ? migrateFramerBannerConfigs(null, env.BANNER_KV_FRAMER, env.AUTH_STORE_FRAMER, db, force)
      : { migrated: 0, skipped: 0, errors: [], siteTagged: 0 },
  ]);

  return Response.json({
    success: true,
    summary: {
      webflow: webflowResults,
      framer: framerResults,
    },
  });
}
