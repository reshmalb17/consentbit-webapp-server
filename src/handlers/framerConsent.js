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
import { requestDomainMatchesSite } from '../utils/domainValidate.js';
import { readConsentBody, invalidFramerConsentFields } from '../utils/consentLimits.js';

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
  // Size-capped read (see utils/consentLimits.js).
  const parsed = await readConsentBody(request);
  if (!parsed.ok) {
    console.warn('[FramerConsent] rejected body:', parsed.error);
    return new Response(JSON.stringify({ error: parsed.error }), {
      status: parsed.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const body = parsed.body;

  const {
    clientId = null,
    platformSiteId,
    siteId: bodySiteId,
    visitorId,
    preferences,
    timestamp,
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

  const badField = invalidFramerConsentFields({
    bannerType, visitorId, clientId, platformSiteId: resolvedPlatformSiteId,
  });
  if (badField) {
    console.warn('[FramerConsent] rejected — invalid field:', badField);
    return new Response(
      JSON.stringify({ error: `Invalid consent field: ${badField}`, code: 'INVALID_CONSENT' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
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

  // Domain check, LOG-ONLY for now. /api/consent enforces an exact match, but Framer
  // sites are also served from *.framer.website / *.framer.app preview hosts and the
  // incoming Origin was never stored, so enforcing blind could drop real consents.
  // Watch these warnings, then enforce once the real hosts are known.
  if (!requestDomainMatchesSite(site, request)) {
    const origin = request.headers.get('origin') || request.headers.get('referer') || '-';
    console.warn('[FramerConsent] domain mismatch (not enforced) — site.domain:', site.domain, '| origin:', origin);
  }

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

  // Cloudflare's country only — the body's `country` is client-controlled. The banner
  // posts straight from the visitor's browser (1,333 distinct IPs across 1,521 Framer
  // consents in Sept 2026), so cf.country is the visitor's real country.
  const country = cfCountry || null;

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
        } catch (r2Err) {
          console.warn('[FramerConsent] R2 dual-write failed (non-fatal):', r2Err?.message);
        }
      })());
    }
  } catch (dbErr) {
    console.error('[FramerConsent] ❌ DB insert failed — siteId:', internalSiteId, '| error:', dbErr?.message, '| cause:', dbErr?.cause?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to save consent' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, id, siteId: internalSiteId, visitorId }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
