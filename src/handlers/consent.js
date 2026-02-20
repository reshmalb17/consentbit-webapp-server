// api/consent.js
import { ensureSchema, getSiteById } from '../services/db.js';
import { requestDomainMatchesSite } from '../utils/domainValidate.js';

export async function handleConsent(request, env) {
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
  const body = await request.json();

  const {
    siteId,
    regulation = 'gdpr',
    bannerType = 'gdpr',
    consentMethod = 'banner',
    status = 'given',
    expiresAt,
    consent: consentPayload = null,
    tcf = {},
  } = body || {};
  const consentCategoriesJson = consentPayload != null ? JSON.stringify(consentPayload) : null;

  if (!siteId) {
    return new Response(
      JSON.stringify({ error: 'siteId is required' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const site = await getSiteById(db, siteId);
  if (!site) {
    return new Response(
      JSON.stringify({ error: 'Site not found', code: 'SITE_NOT_FOUND' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (!requestDomainMatchesSite(site, request)) {
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

  const id = crypto.randomUUID();

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
        tcf_publisher_string
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16,
        ?17, ?18, ?19, ?20, ?21,
        ?22, ?23, ?24, ?25, ?26,
        ?27, ?28, ?29, ?30, ?31,
        ?32, ?33, ?34, ?35
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
      tcf_publisher_string
    )
    .run();

  return new Response(
    JSON.stringify({ success: true, id }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
