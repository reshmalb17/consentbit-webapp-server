// api/consent.js
// Consent data is written exclusively to D1 (Consent table).
// Legacy Webflow/Framer sites (isLegacy=true) store data in R2/KV via their
// own CDN scripts — the dashboard reads R2 for those before June 2026, D1 after.
import { ensureSchema, getSiteById } from '../services/db.js';
import { requestDomainMatchesSite } from '../utils/domainValidate.js';

export async function handleConsent(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;

  await ensureSchema(db);

  const now = new Date().toISOString();

  // Cloudflare geo
  const cf = request.cf || {};
  const country = cf.country || null;          // "US", "DE", etc.
  const region  = cf.regionCode || null;       // "CA", "NY", etc.
  const isEU    = cf.isEUCountry === '1' ? 1 : 0;

  // Network info
  const ipAddress =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    null;
  const userAgent = request.headers.get('user-agent') || null;

  // Body from CDN script
  // expected shape (example):
  // {
  //   siteId: "site-123",
  //   regulation: "gdpr" | "ccpa" | "none",
  //   bannerType: "gdpr" | "ccpa",
  //   consentMethod: "banner" | "preferences" | "api",
  //   status: "given" | "denied" | "partial" | "withdrawn",
  //   expiresAt: "2026-12-01T00:00:00.000Z",
  //   tcf: {
  //     version: 2,
  //     cmpId: 123,
  //     cmpVersion: 1,
  //     consentScreen: 1,
  //     consentLanguage: "EN",
  //     vendorListVersion: 81,
  //     useNonStandardTexts: false,
  //     purposeOneTreatment: false,
  //     publisherCc: "DE",
  //     purposesConsent: { "1": true, "2": false },
  //     purposesLI: { "3": true },
  //     specialPurposes: { "1": true },
  //     features: { "1": true },
  //     specialFeatures: { "1": false },
  //     vendorsConsent: { "755": true },
  //     vendorsLI: { "755": false },
  //     publisherRestrictions: [
  //       { purposeId: 1, restrictionType: 0, vendorIds: [755, 91] }
  //     ]
  //   }
  // }
  let body;
  try {
    body = await request.json();
  } catch (parseErr) {
    console.error('[Consent] failed to parse request body:', parseErr?.message);
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const {
    siteId,
    regulation = 'gdpr',
    bannerType = 'gdpr',
    consentMethod = 'banner',
    status = 'accepted',
    expiresAt,
    consent: consentPayload = null,
    tcf = {},
  } = body || {};
  const consentCategoriesJson = consentPayload != null ? JSON.stringify(consentPayload) : null;

  console.log('[Consent] incoming —', {
    siteId,
    regulation,
    bannerType,
    consentMethod,
    status,
    expiresAt: expiresAt || null,
    hasConsent: consentPayload != null,
    consentKeys: consentPayload ? Object.keys(consentPayload) : [],
    country,
    region,
    isEU,
    origin: request.headers.get('origin') || request.headers.get('referer') || '(none)',
  });

  if (!siteId) {
    console.warn('[Consent] rejected — siteId missing');
    return new Response(
      JSON.stringify({ error: 'siteId is required' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const site = await getSiteById(db, siteId).catch(e => {
    console.error('[Consent] DB lookup error for siteId:', siteId, e?.message);
    return null;
  });
  if (!site) {
    console.warn('[Consent] site not found — siteId:', siteId);
    return new Response(
      JSON.stringify({ error: 'Site not found', code: 'SITE_NOT_FOUND' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  console.log('[Consent] site found —', { id: site.id, domain: site.domain, isLegacy: site.isLegacy });

  const domainOk = requestDomainMatchesSite(site, request);
  console.log('[Consent] domain check —', {
    siteDomain: site.domain,
    requestOrigin: request.headers.get('origin') || '(none)',
    requestReferer: request.headers.get('referer') || '(none)',
    passed: domainOk,
  });
  if (!domainOk) {
    console.warn('[Consent] domain mismatch — siteId:', siteId, '| site.domain:', site.domain);
    return new Response(
      JSON.stringify({ error: 'This script is not valid for this domain. It is licensed for the site it was issued to.', code: 'DOMAIN_MISMATCH' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // TCF metadata (optional, can be partially filled)
  const tcf_version              = tcf.version ?? null;
  const tcf_cmp_id               = tcf.cmpId ?? null;
  const tcf_cmp_version          = tcf.cmpVersion ?? null;
  const tcf_consent_screen       = tcf.consentScreen ?? null;
  const tcf_consent_language     = tcf.consentLanguage ?? null;
  const tcf_vendor_list_version  = tcf.vendorListVersion ?? null;
  const tcf_use_non_standard_txt = tcf.useNonStandardTexts === true ? 1 : 0;
  const tcf_purpose_one_treatment= tcf.purposeOneTreatment === true ? 1 : 0;
  const tcf_publisher_cc         = tcf.publisherCc ?? country ?? null;

  const tcf_purposes_consent     = tcf.purposesConsent
    ? JSON.stringify(tcf.purposesConsent)
    : null;
  const tcf_purposes_li          = tcf.purposesLI
    ? JSON.stringify(tcf.purposesLI)
    : null;
  const tcf_special_purposes     = tcf.specialPurposes
    ? JSON.stringify(tcf.specialPurposes)
    : null;
  const tcf_features             = tcf.features
    ? JSON.stringify(tcf.features)
    : null;
  const tcf_special_features     = tcf.specialFeatures
    ? JSON.stringify(tcf.specialFeatures)
    : null;
  const tcf_vendors_consent      = tcf.vendorsConsent
    ? JSON.stringify(tcf.vendorsConsent)
    : null;
  const tcf_vendors_li           = tcf.vendorsLI
    ? JSON.stringify(tcf.vendorsLI)
    : null;
  const tcf_publisher_restr      = tcf.publisherRestrictions
    ? JSON.stringify(tcf.publisherRestrictions)
    : null;

  // For now you probably don't generate the tcString yet
  const tcf_core_string      = null;
  const tcf_publisher_string = null;

  // Idempotency guard: the embedded banner script can fire this consent POST twice for a
  // single click (overlapping click handlers), producing two Consent rows with different
  // ids but identical details in the same second — showing as duplicate consent-log rows.
  // If an identical consent (same site + device + regulation + status) was recorded in the
  // last 10s, return that row instead of inserting a duplicate. Only dedups when a deviceId
  // is present, so two distinct anonymous visitors are never collapsed.
  if (body.deviceId) {
    try {
      const dupSince = new Date(Date.now() - 10000).toISOString();
      const existing = await db
        .prepare(
          `SELECT id FROM Consent
           WHERE siteId = ?1 AND deviceId = ?2 AND status = ?3 AND regulation IS ?4 AND createdAt >= ?5
           ORDER BY createdAt DESC LIMIT 1`,
        )
        .bind(siteId, body.deviceId, status, regulation ?? null, dupSince)
        .first()
        .catch(() => null);
      if (existing?.id) {
        console.log('[Consent] duplicate suppressed — existing id:', existing.id, '| siteId:', siteId, '| status:', status);
        return new Response(
          JSON.stringify({ success: true, id: existing.id, deduped: true }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
    } catch (e) {
      console.warn('[Consent] dedup check failed (inserting anyway):', e?.message);
    }
  }

  const id = crypto.randomUUID();

  console.log('[Consent] inserting row — id:', id, '| siteId:', siteId, '| status:', status, '| regulation:', regulation);

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
        tcf_version,
        tcf_cmp_id,
        tcf_cmp_version,
        tcf_consent_screen,
        tcf_consent_language,
        tcf_vendor_list_version,
        tcf_use_non_standard_texts,
        tcf_purpose_one_treatment,
        tcf_publisher_cc,
        tcf_purposes_consent,
        tcf_purposes_li,
        tcf_special_purposes,
        tcf_features,
        tcf_special_features,
        tcf_vendors_consent,
        tcf_vendors_li,
        tcf_publisher_restrictions,
        tcf_core_string,
        tcf_publisher_string,
        domain
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16,
        ?17, ?18, ?19, ?20, ?21,
        ?22, ?23, ?24, ?25, ?26,
        ?27, ?28, ?29, ?30, ?31,
        ?32, ?33, ?34, ?35, ?36
      )
    `
    )
    .bind(
      id,
      siteId,
      body.deviceId || null,
      ipAddress,
      userAgent,
      country,
      region,
      isEU,
      now,
      now,
      regulation,
      bannerType,
      consentMethod,
      status,
      expiresAt || null,
      consentCategoriesJson,
      tcf_version,
      tcf_cmp_id,
      tcf_cmp_version,
      tcf_consent_screen,
      tcf_consent_language,
      tcf_vendor_list_version,
      tcf_use_non_standard_txt,
      tcf_purpose_one_treatment,
      tcf_publisher_cc,
      tcf_purposes_consent,
      tcf_purposes_li,
      tcf_special_purposes,
      tcf_features,
      tcf_special_features,
      tcf_vendors_consent,
      tcf_vendors_li,
      tcf_publisher_restr,
      tcf_core_string,
      tcf_publisher_string,
      site.domain || null
    )
    .run();

  console.log('[Consent] ✅ saved — id:', id, '| siteId:', siteId);

  // ── Dual-write to R2 (consent-v2/) for consents received before June 2026 ──
  // This keeps legacy CSV/logs exports working while the transition to D1 completes.
  // After June 2026 all reads go to D1 only; this write can then be removed.
  if (ctx && env.R2 && site.domain && new Date() < new Date('2026-06-01')) {
    ctx.waitUntil((async () => {
      try {
        const cats = (consentPayload?.categories) || consentPayload || {};
        const isCcpaReg = (regulation || '').toLowerCase() === 'ccpa' || (bannerType || '').toLowerCase() === 'ccpa';
        const isAcceptedStatus = (status || '').toLowerCase() === 'accepted' || (status || '').toLowerCase() === 'given';
        const legacyRecord = [{
          timestamp: now,
          action: isAcceptedStatus ? 'acceptance' : 'rejection',
          bannerType: isCcpaReg ? 'CCPA' : 'GDPR',
          country: country || '',
          state: region || '',
          preferences: {
            necessary: Boolean(cats.essential ?? cats.necessary ?? true),
            analytics: Boolean(cats.analytics),
            marketing: Boolean(cats.marketing),
            personalization: Boolean(cats.preferences || cats.personalization),
            ...(isCcpaReg ? {
              doNotSell: Boolean(cats.ccpa?.doNotSell),
              doNotShare: Boolean(cats.ccpa?.doNotShare),
            } : {}),
          },
          metadata: {
            ip: ipAddress || '',
            userAgent: userAgent || '',
            country: country || '',
            state: region || '',
          },
        }];
        const r2Key = `consent-v2/${site.domain}/${id}.json`;
        await env.R2.put(r2Key, JSON.stringify(legacyRecord), {
          httpMetadata: { contentType: 'application/json' },
        });
        console.log('[Consent] R2 dual-write ✅ —', r2Key);
      } catch (r2Err) {
        console.warn('[Consent] R2 dual-write failed (non-fatal):', r2Err?.message);
      }
    })());
  }

  } catch (dbErr) {
    console.error('[Consent] ❌ DB insert failed — siteId:', siteId, '| error:', dbErr?.message, '| cause:', dbErr?.cause?.message);
    return new Response(
      JSON.stringify({ error: 'Failed to save consent', details: dbErr?.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, id }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
