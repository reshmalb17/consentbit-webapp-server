// GET /api/admin/check-missed-banners
// Reports Site rows that have no BannerCustomization row, grouped by platform.
import { checkAdminAuth } from '../utils/adminAuth.js';

export async function handleAdminCheckMissedBanners(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });

  const url = new URL(request.url);
  const platform = url.searchParams.get('platform'); // 'webflow' | 'framer' | null (all)

  const platformFilter = platform ? `AND s.platform = '${platform}'` : '';

  const rows = await db.prepare(`
    SELECT s.id, s.domain, s.platform, s.platformSiteId, s.complianceType, s.isLegacy
    FROM Site s
    LEFT JOIN BannerCustomization bc ON bc.siteId = s.id
    WHERE bc.id IS NULL
    ${platformFilter}
    ORDER BY s.platform, s.domain
  `).all();

  const sites = rows?.results || [];
  const summary = {
    total: sites.length,
    webflow: sites.filter(r => r.platform === 'webflow').length,
    framer: sites.filter(r => r.platform === 'framer').length,
    other: sites.filter(r => r.platform !== 'webflow' && r.platform !== 'framer').length,
  };

  return Response.json({ success: true, summary, sites });
}
