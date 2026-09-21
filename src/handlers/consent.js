// api/consent.js
// Consent data is written exclusively to D1 (Consent table).
// Legacy Webflow/Framer sites (isLegacy=true) store data in R2/KV via their
// own CDN scripts — the dashboard reads R2 for those before June 2026, D1 after.
import { ensureSchema, getSiteById } from '../services/db.js';
import { requestDomainMatchesSite } from '../utils/domainValidate.js';

// Set once per isolate when the DB turns out to lack the optional Consent columns,
// so later saves skip the doomed first attempt instead of paying a round-trip each time.
let _optionalConsentColumnsMissing = false;

// Inserts a Consent row from [column, value] pairs. Tries base + optional columns;
// if the DB has no such column, retries with the base columns only. Any other error
// is rethrown unchanged.
async function insertConsentRow(db, baseRow, optionalRow) {
  const run = (row) =>
    db
      .prepare(
        `INSERT INTO Consent (${row.map(([col]) => col).join(', ')})
         VALUES (${row.map((_, i) => `?${i + 1}`).join(', ')})`,
      )
      .bind(...row.map(([, val]) => val))
      .run();

  if (!_optionalConsentColumnsMissing) {
    try {
      return await run([...baseRow, ...optionalRow]);
    } catch (e) {
      if (!/no column named|has no column/i.test(e?.message || '')) throw e;
      _optionalConsentColumnsMissing = true;
      console.warn('[Consent] optional jurisdiction columns not in DB — saving without them:', e?.message);
    }
  }
  return run(baseRow);
}

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
    // Jurisdiction + proof fields. Optional: cdnM.js does not send them yet, and
    // cached older scripts never will, so every one defaults rather than failing.
    // `regulation` above is untouched and still authoritative for existing readers.
    law = null,
    lawResolved = false,
    consentLanguage = null,
    consentModel = null,
    noticeVersion = null,
    policyVersion = null,
    // The language the jurisdiction expects but which we have no string set for
    // yet (th, ar, fr, en-AU). Null once the gap closes. Recording it makes the
    // shortfall visible in the data rather than only in a document.
    langWanted = null,
  } = body || {};
  const consentCategoriesJson = consentPayload != null ? JSON.stringify(consentPayload) : null;


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


  const domainOk = requestDomainMatchesSite(site, request);
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


  // Columns every environment already has.
  const baseRow = [
    ['id', id],
    ['siteId', siteId],
    ['deviceId', body.deviceId || null],
    ['ipAddress', ipAddress],
    ['userAgent', userAgent],
    ['country', country],
    ['region', region],
    ['is_eu', isEU],
    ['createdAt', now],
    ['updatedAt', now],
    ['regulation', regulation],
    ['bannerType', bannerType],
    ['consentMethod', consentMethod],
    ['status', status],
    ['expiresAt', expiresAt || null],
    ['consent_categories', consentCategoriesJson],
    ['tcf_version', tcf_version],
    ['tcf_cmp_id', tcf_cmp_id],
    ['tcf_cmp_version', tcf_cmp_version],
    ['tcf_consent_screen', tcf_consent_screen],
    ['tcf_consent_language', tcf_consent_language],
    ['tcf_vendor_list_version', tcf_vendor_list_version],
    ['tcf_use_non_standard_texts', tcf_use_non_standard_txt],
    ['tcf_purpose_one_treatment', tcf_purpose_one_treatment],
    ['tcf_publisher_cc', tcf_publisher_cc],
    ['tcf_purposes_consent', tcf_purposes_consent],
    ['tcf_purposes_li', tcf_purposes_li],
    ['tcf_special_purposes', tcf_special_purposes],
    ['tcf_features', tcf_features],
    ['tcf_special_features', tcf_special_features],
    ['tcf_vendors_consent', tcf_vendors_consent],
    ['tcf_vendors_li', tcf_vendors_li],
    ['tcf_publisher_restrictions', tcf_publisher_restr],
    ['tcf_core_string', tcf_core_string],
    ['tcf_publisher_string', tcf_publisher_string],
    ['domain', site.domain || null],
  ];

  // Jurisdiction + proof columns. Still test-mode: their ALTERs live in ensureSchema,
  // which is skipped on any DB already stamped at SCHEMA_VERSION, so a DB may not
  // have them yet. insertConsentRow() drops them rather than failing the save.
  const optionalRow = [
    ['law', law],
    ['law_resolved', lawResolved ? 1 : 0],
    ['consent_language', consentLanguage],
    ['consent_model', consentModel],
    ['notice_version', noticeVersion],
    ['policy_version', policyVersion],
    ['lang_wanted', langWanted],
  ];

  try {
  await insertConsentRow(db, baseRow, optionalRow);


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
