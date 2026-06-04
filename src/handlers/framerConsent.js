// handlers/framerConsent.js
// Framer consent ingest.
//
// Framer sites post consent keyed by their *platform* site id (the long Framer
// site hash) rather than our internal Site.id. This handler resolves that
// platformSiteId -> internal Site.id, then writes to D1 (Consent table) using
// the exact same storage path as the standard loader (handlers/consent.js).
//
// It intentionally drops the old KV-array storage (CONSENT_STORE_FRAMER +
// generateExpectedCookies) — consent now lives only in D1.
import { ensureSchema } from '../services/db.js';

export async function handleFramerConsent(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;

  await ensureSchema(db);

  const now = new Date().toISOString();

  // Cloudflare geo
  const cf = request.cf || {};
  const cfCountry = cf.country || null;        // "US", "DE", etc.
  const region    = cf.regionCode || null;     // "CA", "NY", etc.
  const isEU      = cf.isEUCountry === '1' ? 1 : 0;

  // Network info
  const ipAddress =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    null;
  const userAgent = request.headers.get('user-agent') || null;

  // Expected body (Framer shape):
  // {
  //   clientId: "finkbeiner-optik.de",
  //   siteId: "0c335b63...",            // Framer platform site id (== platformSiteId)
  //   visitorId: "174cfb11-...",
  //   preferences: { analytics, marketing, personalization, doNotShare, action, bannerType },
  //   policyVersion: "1.2",
  //   timestamp: "2026-06-03T14:07:13.618Z",
  //   country: "IN",
  //   bannerType: "gdpr",
  //   expiresAtTimestamp: 1790863633619,
  //   expirationDurationDays: 120,
  //   metadata: { userAgent, language, platform, timezone }
  // }
  let body;
  try {
    body = await request.json();
  } catch (parseErr) {
    console.error('[FramerConsent] failed to parse request body:', parseErr?.message);
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const {
    clientId = null,
    platformSiteId,
    siteId: bodySiteId,
    visitorId,
    preferences,
    timestamp,
    country: bodyCountry = null,
    expiresAtTimestamp,
    expirationDurationDays,
    metadata = {},
  } = body || {};

  // The Framer payload sends the platform site id in `siteId`; accept an
  // explicit `platformSiteId` too in case the client is updated later.
  const resolvedPlatformSiteId = platformSiteId || bodySiteId;
  const bannerType = (body?.bannerType || preferences?.bannerType || 'gdpr').toLowerCase();

  if (!resolvedPlatformSiteId || !visitorId || !preferences) {
    console.warn('[FramerConsent] rejected — missing platformSiteId/visitorId/preferences');
    return new Response(
      JSON.stringify({ error: 'platformSiteId (siteId), visitorId, and preferences are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── Map Framer platformSiteId -> internal Site.id ──
  const site = await db
    .prepare('SELECT id, domain FROM Site WHERE platformSiteId = ?1')
    .bind(resolvedPlatformSiteId)
    .first()
    .catch((e) => {
      console.error('[FramerConsent] DB lookup error for platformSiteId:', resolvedPlatformSiteId, e?.message);
      return null;
    });

  if (!site) {
    console.warn('[FramerConsent] site not found — platformSiteId:', resolvedPlatformSiteId);
    return new Response(
      JSON.stringify({ error: 'Site not found for platformSiteId', code: 'SITE_NOT_FOUND' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const internalSiteId = site.id;

  // ── Normalize Framer payload into the standard consent shape ──
  const regulation = bannerType === 'ccpa' ? 'ccpa' : 'gdpr';

  const action = String(preferences?.action || '').toLowerCase();
  const status =
    action === 'acceptance' ? 'accepted'
    : action === 'rejection' ? 'rejected'
    : 'partial';

  // Prefer an explicit ms timestamp; otherwise derive from timestamp + duration.
  let expiresAt = null;
  if (expiresAtTimestamp) {
    try { expiresAt = new Date(Number(expiresAtTimestamp)).toISOString(); } catch { /* ignore */ }
  }
  if (!expiresAt && timestamp && expirationDurationDays) {
    try {
      expiresAt = new Date(
        new Date(timestamp).getTime() + Number(expirationDurationDays) * 86400000
      ).toISOString();
    } catch { /* ignore */ }
  }

  const country = bodyCountry || cfCountry || null;

  // Consent categories stored as-is (mirrors loader's consent payload).
  const consentPayload = {
    essential: true,
    analytics: Boolean(preferences.analytics),
    marketing: Boolean(preferences.marketing),
    personalization: Boolean(preferences.personalization),
    doNotShare: Boolean(preferences.doNotShare),
  };
  const consentCategoriesJson = JSON.stringify(consentPayload);

  const id = crypto.randomUUID();

  console.log('[FramerConsent] inserting — id:', id, '| platformSiteId:', resolvedPlatformSiteId,
    '| siteId:', internalSiteId, '| status:', status, '| regulation:', regulation);

  try {
    await db
      .prepare(
        `
        INSERT INTO Consent (
          id,
          siteId,
          deviceId,
          ipAddress,
          userAgent,
          country,
          region,
          is_eu,
          createdAt,
          updatedAt,
          regulation,
          bannerType,
          consentMethod,
          status,
          expiresAt,
          consent_categories,
          domain
        )
        VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?15, ?16, ?17
        )
      `
      )
      .bind(
        id,
        internalSiteId,
        visitorId,
        ipAddress,
        userAgent,
        country,
        region,
        isEU,
        now,
        now,
        regulation,
        bannerType,
        'banner',
        status,
        expiresAt,
        consentCategoriesJson,
        site.domain || clientId || null
      )
      .run();

    console.log('[FramerConsent] ✅ saved — id:', id, '| siteId:', internalSiteId);

    // ── Dual-write to R2 (consent-v2/) for consents received before June 2026 ──
    // Keeps legacy CSV/logs exports working during the D1 transition (mirrors consent.js).
    if (ctx && env.R2 && site.domain && new Date() < new Date('2026-06-01')) {
      ctx.waitUntil((async () => {
        try {
          const isCcpaReg = regulation === 'ccpa';
          const isAcceptedStatus = status === 'accepted';
          const legacyRecord = [{
            timestamp: timestamp || now,
            action: isAcceptedStatus ? 'acceptance' : 'rejection',
            bannerType: isCcpaReg ? 'CCPA' : 'GDPR',
            country: country || '',
            state: region || '',
            preferences: {
              necessary: true,
              analytics: Boolean(preferences.analytics),
              marketing: Boolean(preferences.marketing),
              personalization: Boolean(preferences.personalization),
              ...(isCcpaReg ? { doNotShare: Boolean(preferences.doNotShare) } : {}),
            },
            metadata: {
              ...metadata,
              ip: ipAddress || '',
              userAgent: userAgent || metadata?.userAgent || '',
              country: country || '',
              state: region || '',
            },
          }];
          const r2Key = `consent-v2/${site.domain}/${id}.json`;
          await env.R2.put(r2Key, JSON.stringify(legacyRecord), {
            httpMetadata: { contentType: 'application/json' },
          });
          console.log('[FramerConsent] R2 dual-write ✅ —', r2Key);
        } catch (r2Err) {
          console.warn('[FramerConsent] R2 dual-write failed (non-fatal):', r2Err?.message);
        }
      })());
    }
  } catch (dbErr) {
    console.error('[FramerConsent] ❌ DB insert failed — siteId:', internalSiteId, '| error:', dbErr?.message, '| cause:', dbErr?.cause?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to save consent', details: dbErr?.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, id, siteId: internalSiteId, visitorId }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
