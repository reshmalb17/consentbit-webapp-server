// handlers/legacyConsentPdf.js
import puppeteer from '@cloudflare/puppeteer';
import { getSessionById } from '../services/db.js';
import { requireActiveSubscriptionForConsentReport } from '../services/subscriptionGate.js';
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
        `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid, s.isLegacy
         FROM Site s
         INNER JOIN Organization o ON o.id = s.organizationId
         INNER JOIN User u ON u.id = o.ownerUserId
         WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND u.id = ?2 AND (s.isLegacy = 1 OR s.platformSiteId IS NOT NULL)`,
      ).bind(siteId, userId).first()
    : db.prepare(
        `SELECT s.id, s.name, s.domain, s.platformSiteId as platformsiteid, s.isLegacy
         FROM Site s WHERE (s.id = ?1 OR s.platformSiteId = ?1) AND (s.isLegacy = 1 OR s.platformSiteId IS NOT NULL)`,
      ).bind(siteId).first()
  ).catch(() => null);

  if (!site) return new Response('Site not found', { status: 404 });

  // Paid deliverable — applies to the signed-link path too, so an old CSV's embedded
  // PDF links stop working once the subscription lapses.
  const gate = await requireActiveSubscriptionForConsentReport(env, site.id);
  if (!gate.ok) return new Response(gate.error, { status: gate.status });

  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  const kv = env.WEBFLOW_AUTHENTICATION;
  const r2 = env.R2;

  const searchKeys = await buildSearchKeys(kv, platformSiteId, site.domain, site.name);

  let entries = r2 ? await getConsentRowsFromR2(r2, searchKeys) : [];
  if (entries.length === 0 && platformSiteId && kv) {
    entries = await getConsentRowsFromKV(kv, platformSiteId);
  }

  const rawEntry = entries.find(e => (e._visitorId || e.visitorId) === visitorId);

  let consent;
  if (rawEntry) {
    // Legacy R2/KV path
    consent = transformEntry(rawEntry, site.id);
  } else if (!site.isLegacy) {
    // Webflow app site — visitorId is actually the D1 Consent.id UUID
    const d1Row = await db
      .prepare(`SELECT id, siteId, ipAddress, userAgent, country, region, is_eu,
                       createdAt, updatedAt, regulation, bannerType, consentMethod, status,
                       expiresAt, consent_categories, domain
                FROM Consent WHERE id = ?1 AND siteId = ?2`)
      .bind(visitorId, site.id)
      .first()
      .catch(() => null);

    if (!d1Row) return new Response('Visitor not found', { status: 404 });

    let categories = null;
    if (d1Row.consent_categories) {
      try {
        const parsed = typeof d1Row.consent_categories === 'string'
          ? JSON.parse(d1Row.consent_categories)
          : d1Row.consent_categories;
        categories = parsed && typeof parsed.categories === 'object' ? parsed.categories : parsed;
      } catch { /* ignore */ }
    }
    consent = {
      id: d1Row.id,
      siteId: d1Row.siteId,
      deviceId: null,
      ipAddress: d1Row.ipAddress,
      userAgent: d1Row.userAgent,
      country: d1Row.country,
      region: d1Row.region,
      is_eu: d1Row.is_eu,
      createdAt: d1Row.createdAt,
      updatedAt: d1Row.updatedAt,
      regulation: d1Row.regulation,
      bannerType: d1Row.bannerType,
      consentMethod: d1Row.consentMethod,
      status: d1Row.status,
      expiresAt: d1Row.expiresAt,
      domain: d1Row.domain,
      categories,
    };
  } else {
    return new Response('Visitor not found', { status: 404 });
  }

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
