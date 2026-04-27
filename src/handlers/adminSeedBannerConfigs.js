// POST /api/admin/seed-banner-configs
// Migrates legacy banner customization from WEBFLOW_AUTHENTICATION KV and
// BANNER_KV_FRAMER into CONSENT_WEBAPP.BannerCustomization, matched by domain → siteId.
import { checkAdminAuth } from '../utils/adminAuth.js';
import { migrateBannerConfigs, migrateFramerBannerConfigs } from '../services/db.js';

export async function handleAdminSeedBannerConfigs(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';
  const platformFilter = url.searchParams.get('platform'); // 'webflow' | 'framer' | null (both)

  const [webflowResults, framerResults] = await Promise.all([
    (!platformFilter || platformFilter === 'webflow') && env.WEBFLOW_AUTHENTICATION
      ? migrateBannerConfigs(null, env.WEBFLOW_AUTHENTICATION, db, force)
      : { migrated: 0, skipped: 0, errors: [], siteTagged: 0 },
    (!platformFilter || platformFilter === 'framer') && env.BANNER_KV_FRAMER
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
