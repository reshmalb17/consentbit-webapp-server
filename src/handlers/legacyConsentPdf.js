// handlers/legacyConsentPdf.js
import puppeteer from '@cloudflare/puppeteer';
import { getSessionById } from '../services/db.js';
import { buildSearchKeys, getConsentRowsFromR2, getConsentRowsFromKV, transformEntry } from './legacyConsentHelpers.js';
import { verifyDownloadToken } from '../utils/signedToken.js';
import { buildHtml, fetchImageAsDataUrl } from './consentPdf.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * GET /api/legacy-consent-pdf?siteId=...&visitorId=...
 * Generates a PDF consent record for a single visitor (legacy R2/KV data).
 * Uses the same design as consentPdf.js and fetches cookie inventory from D1.
 */
export async function handleLegacyConsentPdf(request, env) {
  const db = env.CONSENT_WEBAPP;

  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId');
  const visitorId = url.searchParams.get('visitorId');
  const token = url.searchParams.get('token');
  if (!siteId || !visitorId) return new Response('siteId and visitorId required', { status: 400 });

  // Accept either a valid signed token or an active session cookie
  let userId = null;
  if (token) {
    const valid = await verifyDownloadToken(env.JWT_SECRET, token, siteId, visitorId);
    if (!valid) return new Response('Link expired or invalid', { status: 401 });
  } else {
    const sid = getSessionIdFromCookie(request);
    if (!sid) return new Response('Unauthorized', { status: 401 });
    const session = await getSessionById(db, sid).catch(() => null);
    if (!session) return new Response('Unauthorized', { status: 401 });
    userId = session.userId ?? session.user_id;
  }

  const site = await (userId
    ? db.prepare(
        `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid
         FROM Site s
         INNER JOIN Organization o ON o.id = s.organizationId
         INNER JOIN User u ON u.id = o.ownerUserId
         WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2 AND (s.isLegacy = 1 OR s.platformSiteId IS NOT NULL)`,
      ).bind(siteId, userId).first()
    : db.prepare(
        `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid
         FROM Site s WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND (s.isLegacy = 1 OR s.platformSiteId IS NOT NULL)`,
      ).bind(siteId).first()
  ).catch(() => null);

  if (!site) return new Response('Site not found', { status: 404 });

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  const kv = env.WEBFLOW_AUTHENTICATION;
  const r2 = env.R2;

  const searchKeys = await buildSearchKeys(kv, platformSiteId, site.domain, site.name);

  let entries = r2 ? await getConsentRowsFromR2(r2, searchKeys) : [];
  if (entries.length === 0 && platformSiteId && kv) {
    entries = await getConsentRowsFromKV(kv, platformSiteId);
  }

  const rawEntry = entries.find(e => (e._visitorId || e.visitorId) === visitorId);
  if (!rawEntry) return new Response('Visitor not found', { status: 404 });

  // Transform into the standard consent shape (same as legacyConsentLogs)
  const consent = transformEntry(rawEntry, site.id);

  // Fetch scanned cookie inventory from D1 for this site
  const resolvedSiteId = site.id;
  const { results: cookieRows } = await db
    .prepare(
      `SELECT name, category, expires, description FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY siteId, name, COALESCE(domain, '') ORDER BY lastSeenAt DESC) as rn
        FROM Cookie
        WHERE siteId = ?1
      ) WHERE rn = 1
      ORDER BY category, name`,
    )
    .bind(resolvedSiteId)
    .all()
    .catch(() => ({ results: [] }));

  const cookies = cookieRows || [];

  // Fetch custom cookie rules
  const { results: customRuleRows } = await db
    .prepare(
      `SELECT name, category, duration, description
       FROM CustomCookieRule WHERE siteId = ?1 AND published = 1
       ORDER BY category, name`,
    )
    .bind(resolvedSiteId)
    .all()
    .catch(() => ({ results: [] }));

  const customCookieRules = customRuleRows || [];

  const logoUrl = await fetchImageAsDataUrl();
  const html = buildHtml(consent, cookies, customCookieRules, site.domain || siteId, logoUrl);

  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    await browser.close();

    const filename = `consent_${visitorId.slice(0, 8)}_${new Date().toISOString().split('T')[0]}.pdf`;
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[legacyConsentPdf]', err?.message);
    return new Response('PDF generation failed', { status: 500 });
  }
}
