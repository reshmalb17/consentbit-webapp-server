// handlers/legacyConsentLogs.js
import { getSessionById } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * GET /api/legacy-consent-logs?siteId=...
 *
 * Returns consent logs for a legacy (webflow/framer) site by proxying to cb-server.
 * The requesting user must own the site.
 */
export async function handleLegacyConsentLogs(request, env) {
  const db = env.CONSENT_WEBAPP;

  // Authenticate via session cookie
  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }
  const session = await getSessionById(db, sid).catch(() => null);
  if (!session) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }
  const userId = session.userId ?? session.user_id;

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  if (!siteId) {
    return Response.json({ success: false, error: 'siteId required' }, { status: 400 });
  }

  // Verify the site belongs to this user and is a legacy site
  const site = await db
    .prepare(
      `SELECT s.id, s.domain, s.legacySource
       FROM Site s
       INNER JOIN Organization o ON o.id = s.organizationId
       INNER JOIN User u ON u.id = o.ownerId
       WHERE s.id = ?1 AND u.id = ?2 AND s.isLegacy = 1`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);

  if (!site) {
    return Response.json({ success: false, error: 'Legacy site not found or access denied' }, { status: 404 });
  }

  const domain = site.domain || '';
  const cbServerBase = (env.CB_SERVER_BASE_URL || 'https://app.consentbit.com').replace(/\/$/, '');
  const secret = env.LEGACY_API_SECRET || '';

  // Call cb-server internal endpoint
  const params = new URLSearchParams({ domain });
  const cbUrl = `${cbServerBase}/api/internal/legacy-consent-logs?${params}`;

  let cbData;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(cbUrl, {
        headers: { 'X-Internal-Token': secret },
        signal: controller.signal,
      });
      cbData = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error('[legacyConsentLogs] cb-server fetch failed', err?.message);
    return Response.json({ success: false, error: 'Failed to fetch legacy consent data' }, { status: 502 });
  }

  if (!cbData?.success) {
    return Response.json({
      success: true,
      consents: [],
      cookies: [],
      customCookieRules: [],
      total: 0,
      limit: 200,
      offset: 0,
    });
  }

  // Transform cb-server rows → ConsentLog shape expected by ConsentLogsDashboard
  const consents = (cbData.rows || []).map((row) => {
    const prefs = row.preferences || {};
    let categories;
    if (prefs.doNotShare !== undefined || prefs.doNotSell !== undefined) {
      categories = { ccpa: { doNotSell: Boolean(prefs.doNotSell) } };
    } else {
      categories = {
        essential: Boolean(prefs.necessary ?? true),
        analytics: Boolean(prefs.analytics),
        marketing: Boolean(prefs.marketing),
        preferences: Boolean(prefs.personalization),
      };
    }
    return {
      id: row.id,
      siteId,
      deviceId: null,
      ipAddress: row.ipAddress || null,
      userAgent: row.userAgent || null,
      country: row.country || null,
      region: null,
      is_eu: 0,
      createdAt: row.timestamp,
      updatedAt: row.timestamp,
      regulation: row.bannerType === 'CCPA' ? 'ccpa' : 'gdpr',
      bannerType: row.bannerType || null,
      consentMethod: 'legacy',
      status: row.status === 'Accepted' ? 'given' : 'rejected',
      expiresAt: null,
      categories,
    };
  });

  return Response.json({
    success: true,
    consents,
    cookies: [],
    customCookieRules: [],
    total: consents.length,
    limit: 200,
    offset: 0,
  });
}
