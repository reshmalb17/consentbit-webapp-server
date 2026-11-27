import { getBannerCustomization, getEffectivePlanForOrganization, getSubscriptionBySiteId, inferTierPlanIdFromStripePriceId, addSiteLanguageDomain } from '../services/db.js';
import { authorizeRequestHost, LANGUAGE_DOMAIN_PLANS } from '../utils/domainValidate.js';
import { flowLog } from '../utils/flowLog.js';
import { trackCustomDomain } from '../services/domainResolver.js';
import { mergeTranslations } from '../data/defaultTranslations.js';
import { QUEBEC_FRENCH, TEXT_SET_SWITCHES, FRENCH_DEFAULT_FIXES } from '../data/quebecFrench.js';
import { PT_BR_TRANSLATIONS } from '../data/ptBrTranslations.js';
import { PAGE_LANGUAGE_PLANS, readPageLanguages, buildPageLanguageSets, pageLanguageRuntime } from '../services/pageLanguages.js';
import { SCRIPT_BLOCK_PROVIDERS } from '../data/scriptBlockProviders.js';
import { buildBannerCookieList, cookieListSignature, getBannerCookieListScript } from '../utils/bannerCookieList.js';
import { getLoaderIabScript } from '../utils/IabCode.js';
import { prefetchGvlBannerText } from '../utils/gvlPrefetch.js';
import { getWebflowSetupScript } from '../utils/webflowSetup.js';
import { getDebugModeScript } from '../utils/debugMode.js';
import { shortHash, recordNoticeVersions } from '../utils/noticeVersion.js';
import { buildSkipPathGuard, buildHidePathGuard, skipPathsSignature } from '../data/skipPaths.js';
import { consentShareForBanner, siteServesGrowth } from './consentFamily.js';
import { consentShareBridge } from './consentShareBridge.js';

export async function handleCDNScript(request, env, url) {
  try {
  return await _handleCDNScript(request, env, url);
  } catch (err) {
    console.error('[CDN] Unhandled error:', err);
    return new Response(`// CDN error: ${err?.message || err}`, {
      status: 500,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }
}

async function _handleCDNScript(request, env, url) {
  const parts = url.pathname.split('/');

  let cdnScriptId = parts[parts.length - 1];
  if (cdnScriptId === 'script.js' && parts.length > 2) {
    cdnScriptId = parts[parts.length - 2];
  }
  if (cdnScriptId.endsWith('.js')) {
    cdnScriptId = cdnScriptId.slice(0, -3);
  }

  const db = env.CONSENT_WEBAPP;

  const site = await db
    .prepare(
      'SELECT * FROM Site WHERE cdnScriptId = ?1'
    )
    .bind(cdnScriptId)
    .first();

  let resolvedSite = site;
  if (!resolvedSite) {
    resolvedSite = await db
      .prepare(
        'SELECT * FROM Site WHERE id = ?1'
      )
      .bind(cdnScriptId)
      .first();
  }

  if (!resolvedSite) {
    return new Response('// Unknown site script', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  let authorizedHost = null;
  // Set when the request comes from a translated copy of the site (recorded in
  // Site.languageDomains, or detected just now). Plan-gated after the plan lookup.
  let languageHost = null;
  let languageHostNew = false;

  if (resolvedSite.domain) {
    const siteHost = String(resolvedSite.domain)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .toLowerCase();

    const origin = request.headers.get('Origin') || request.headers.get('origin') || '';
    const referer = request.headers.get('Referer') || request.headers.get('referer') || '';

    const sourceHeader = origin || referer;

    if (sourceHeader) {
      try {
        const sourceHost = new URL(sourceHeader).hostname.replace(/^www\./, '').toLowerCase();

        // stagingUrl comes off the Site row already SELECTed above, so this costs no
        // extra query. It used to be read from WEBFLOW_AUTHENTICATION KV on every
        // request — one KV read per pageview for a value D1 already had in hand.
        // Nothing writes stagingUrl to KV any more (setSiteStagingUrl, called from
        // trackCustomDomain, is the live writer), so KV only held stale legacy copies.
        let stagingHost = null;
        const siteStagingUrl = resolvedSite.stagingUrl ?? resolvedSite.stagingurl ?? null;
        // Webflow writes the literal string "Not Published" for unpublished sites.
        if (siteStagingUrl && String(siteStagingUrl).trim().toLowerCase() !== 'not published') {
          try {
            const raw = String(siteStagingUrl).trim();
            stagingHost = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase();
          } catch { }
        }

        let decision = authorizeRequestHost(resolvedSite, sourceHost, { stagingHost, strictSubdomains: env.STRICT_SUBDOMAINS === 'on' });

        if (!decision.allowed && decision.candidate) {
          const tracked = await trackCustomDomain(db, env, resolvedSite, decision.candidate);
          if (tracked.matched) {
            resolvedSite.customDomain = tracked.customDomain;
            if (tracked.stagingUrl) resolvedSite.stagingUrl = tracked.stagingUrl;
            decision = authorizeRequestHost(resolvedSite, sourceHost, { stagingHost, strictSubdomains: env.STRICT_SUBDOMAINS === 'on' });
          } else if (tracked.translated) {
            // Translated copy of this site (Weglot etc.). Served only if the plan
            // covers it — checked below once the plan is known, then recorded.
            languageHostNew = true;
            decision = { allowed: true, candidate: null, reason: 'language-host' };
          }
        }

        if (decision.reason === 'language-host') languageHost = sourceHost;

        // Served only by the old any-subdomain rule. Collect these before setting
        // STRICT_SUBDOMAINS=on — every site listed here would lose its banner.
        if (decision.reason === 'subdomain-legacy') {
          console.warn(`[CDN] subdomain-legacy: site ${resolvedSite.id} "${siteHost}" served on "${sourceHost}"`);
        }

        if (!decision.allowed) {
          console.warn(`[CDN] Domain mismatch BLOCKED: script for "${siteHost}" from "${sourceHost}" (stagingHost=${stagingHost}, reason=${decision.reason})`);
          return new Response('// Script not authorized for this domain', {
            status: 403,
            headers: { 'Content-Type': 'application/javascript' },
          });
        }

        authorizedHost = sourceHost;
      } catch (domainErr) {
        console.warn('[CDN] Could not parse Origin/Referer, blocking. header="' + sourceHeader + '" err=' + domainErr?.message);
        return new Response('// Script not authorized for this domain', {
          status: 403,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    } else {
    }
  }

  if (!resolvedSite.verified) {
    db.prepare(`UPDATE Site SET verified = 1, verified_at = datetime('now') WHERE id = ?1`)
      .bind(resolvedSite.id).run().catch(() => {});
  }

  let effectivePlanId = 'free';
  let orgIdForDebug = null;
  let subStatusForDebug = null;
  try {
    const orgId = resolvedSite.organizationId ?? resolvedSite.organizationid ?? null;
    orgIdForDebug = orgId ? String(orgId) : null;

    let subscription = await getSubscriptionBySiteId(db, resolvedSite.id);

    // getSubscriptionBySiteId only returns active/trialing rows. For a site whose OWN
    // subscription was cancelled but is still inside its paid period, use that subscription.
    // Without this the gate falls through to the org fallback below, which picks whichever
    // subscription in the org was updated most recently — for an org with several cancelled
    // sites that is another site's subscription, so this site was judged against someone
    // else's period end (seen live on Test 2026-09-16: true-apartment-475085.framer.app,
    // paid to 2027-05-29, blocked on a sibling site's period that ended 2026-08-29).
    //
    // Only ever used to SERVE: if the site has no own cancelled subscription still in period,
    // nothing changes and the org fallback runs exactly as before. Mirrors pass 2 of
    // getSubscriptionsBySiteIds, which the dashboard already uses.
    if (!subscription) {
      try {
        const { results: ownRows = [] } = await db
          .prepare(`SELECT * FROM Subscription WHERE siteId = ?1 AND LOWER(status) IN ('canceled', 'cancelled')`)
          .bind(resolvedSite.id)
          .all();
        const nowMs = Date.now();
        const inPeriod = ownRows
          .map((row) => {
            const raw = row.currentPeriodEnd ?? row.currentperiodend ?? null;
            // Rows mix ISO strings and SQLite datetimes — normalise before parsing.
            return { row, endMs: raw ? Date.parse(String(raw).replace(' ', 'T')) : NaN };
          })
          .filter((x) => Number.isFinite(x.endMs) && x.endMs > nowMs)
          .sort((a, b) => b.endMs - a.endMs)[0];
        if (inPeriod) {
          subscription = inPeriod.row;
          flowLog(env, 'banner', 'own-cancelled-subscription-used', {
            siteId: resolvedSite.id, domain: resolvedSite.domain, subscriptionId: inPeriod.row.id,
            periodEnd: inPeriod.row.currentPeriodEnd ?? inPeriod.row.currentperiodend ?? null,
          });
        }
      } catch (ownErr) {
        // Fall through to the org fallback, i.e. the previous behaviour.
        console.warn('[CDN] own cancelled subscription lookup failed:', ownErr?.message);
      }
    }

    // A site with ANY subscription of its own is judged on THAT subscription — never on
    // a sibling's. Without this the org fallback below picks the account's newest
    // active/trialing row, so a cancelled site whose paid period had ENDED kept serving
    // its banner for as long as any other site in the same account still paid.
    // Confirmed 2026-09-23: three ended sites in one account all returned a full script.
    // The org fallback still runs for a site that has no subscription row at all, which
    // is what it exists for (org / bulk-licensed sites).
    if (!subscription) {
      try {
        const ownAny = await db
          .prepare(
            `SELECT * FROM Subscription WHERE siteId = ?1
              ORDER BY CASE WHEN LOWER(status) IN ('active','trialing') THEN 0 ELSE 1 END,
                       datetime(COALESCE(updatedAt, createdAt)) DESC
              LIMIT 1`,
          )
          .bind(resolvedSite.id)
          .first();
        if (ownAny) {
          subscription = ownAny;
          flowLog(env, 'banner', 'own-subscription-used', {
            siteId: resolvedSite.id, domain: resolvedSite.domain,
            status: ownAny.status ?? null,
          });
        }
      } catch (ownAnyErr) {
        // Fall through to the org fallback, i.e. the previous behaviour.
        console.warn('[CDN] own subscription lookup failed:', ownAnyErr?.message);
      }
    }

    let resolvedPlanId = subscription ? (subscription.planId ?? subscription.planid ?? null) : null;
    if (resolvedPlanId) resolvedPlanId = String(resolvedPlanId).toLowerCase();
    if ((!resolvedPlanId || !['basic', 'essential', 'growth'].includes(resolvedPlanId)) && env && subscription) {
      const pid = subscription.stripePriceId ?? subscription.stripepriceid ?? null;
      const inferred = inferTierPlanIdFromStripePriceId(env, pid);
      if (inferred) resolvedPlanId = inferred;
    }

    if (!resolvedPlanId || !['basic', 'essential', 'growth'].includes(resolvedPlanId)) {
      if (orgId) {
        const orgResult = await getEffectivePlanForOrganization(db, orgId, env);
        resolvedPlanId = orgResult.planId || 'free';
        if (!subscription) subscription = orgResult.subscription;
      }
    }

    effectivePlanId = resolvedPlanId && ['basic', 'essential', 'growth'].includes(resolvedPlanId) ? resolvedPlanId : 'free';
    const status = subscription ? String(subscription.status || '').toLowerCase() : null;
    subStatusForDebug = status;
    // Banner access rules (decided 2026-09-16):
    //   deleted                      → blocked, always
    //   canceled / cancelled         → served until currentPeriodEnd, blocked after it
    //   past_due / unpaid / incomplete_expired → blocked (unchanged)
    //   anything else (active, trialing, none)  → served (unchanged)
    //
    // `deleted` was previously missing from this list, so the 9 subscriptions carrying it
    // served full banners. It is written by syncEvent.js when the old dashboard system
    // handles the same Stripe cancellation our webhook already recorded as `canceled`.
    const ALWAYS_BLOCKED_STATUSES = ['deleted', 'past_due', 'unpaid', 'incomplete_expired'];
    const BLOCKED_AFTER_PERIOD_STATUSES = ['canceled', 'cancelled'];

    let subscriptionBlocked = false;
    if (status && ALWAYS_BLOCKED_STATUSES.includes(status)) {
      subscriptionBlocked = true;
    } else if (status && BLOCKED_AFTER_PERIOD_STATUSES.includes(status)) {
      // currentPeriodEnd holds ISO strings on some rows and SQLite datetimes on others
      // ("2026-09-11 21:12:39"), so normalise before parsing — same approach as
      // subscriptionEndSweep.js. Missing or unparseable → treat the period as ended, so an
      // unknown date can never keep a cancelled subscription's banner on.
      const rawEnd = subscription.currentPeriodEnd ?? subscription.currentperiodend ?? null;
      const endMs = rawEnd ? Date.parse(String(rawEnd).replace(' ', 'T')) : NaN;
      const stillInPaidPeriod = Number.isFinite(endMs) && endMs > Date.now();
      subscriptionBlocked = !stillInPaidPeriod;
      if (stillInPaidPeriod) {
        flowLog(env, 'banner', 'served-cancelled-in-period', {
          siteId: resolvedSite.id, domain: resolvedSite.domain, status, periodEnd: rawEnd, plan: effectivePlanId,
        });
      }
    }

    // Free fallback (services/freeFallback.js, 2026-11-05): a site whose paid plan
    // ended and that was moved to the Free plan — because no other site on the account
    // was using it — is served as Free, not blocked. The stamp is on the Site row that
    // was SELECT *'d above, so this costs no extra read. Only ever turns a block into a
    // Free serve; a live or in-period subscription above never reaches this branch.
    if (subscriptionBlocked && (resolvedSite.freeFallbackAt ?? resolvedSite.freefallbackat)) {
      subscriptionBlocked = false;
      effectivePlanId = 'free';
      flowLog(env, 'banner', 'served-free-fallback', {
        siteId: resolvedSite.id, domain: resolvedSite.domain, status,
        freeFallbackAt: resolvedSite.freeFallbackAt ?? resolvedSite.freefallbackat,
      });
    }

    if (subscriptionBlocked) {
      flowLog(env, 'banner', 'blocked', {
        siteId: resolvedSite.id,
        domain: resolvedSite.domain,
        status,
        periodEnd: subscription?.currentPeriodEnd ?? subscription?.currentperiodend ?? null,
        reason: ALWAYS_BLOCKED_STATUSES.includes(status) ? 'status-always-blocked' : 'cancelled-period-ended',
      });
      return new Response('// Subscription inactive — banner disabled', {
        status: 402,
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
  } catch (subErr) {
    console.warn('[CDN] Subscription check failed:', subErr?.message);
  }

  // Translated copies of the site are covered on paid plans only (not Free). A failed
  // plan lookup leaves effectivePlanId 'free', so this fails closed.
  if (languageHost) {
    if (!LANGUAGE_DOMAIN_PLANS.includes(effectivePlanId)) {
      flowLog(env, 'banner', 'language-host-blocked', {
        siteId: resolvedSite.id, domain: resolvedSite.domain, host: languageHost, plan: effectivePlanId,
      });
      return new Response('// Translated versions of this site require a paid plan', {
        status: 403,
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
    if (languageHostNew) {
      await addSiteLanguageDomain(db, resolvedSite.id, languageHost).catch((e) =>
        console.warn('[CDN] languageDomains write failed:', e?.message));
      flowLog(env, 'banner', 'language-host-added', {
        siteId: resolvedSite.id, domain: resolvedSite.domain, host: languageHost, plan: effectivePlanId,
      });
    }
  }

  const customization = await getBannerCustomization(db, resolvedSite.id);

  let customCookieRules = [];
  try {
    const { results: ccrRows } = await db
      .prepare(
        `SELECT name, domain, scriptUrlPattern, category, duration, description
         FROM CustomCookieRule
         WHERE siteId = ?1 AND published = 1
         ORDER BY createdAt DESC`
      )
      .bind(resolvedSite.id)
      .all();
    customCookieRules = ccrRows || [];
  } catch (ccrErr) {
    console.warn('[CDN] Failed to load custom cookie rules:', ccrErr?.message);
  }

  const apiBase =
    env.API_BASE_URL ||
    'https://manager.consentbit.com';

  const GA_ID = resolvedSite.ga_measurement_id || '';

  const cf = request.cf || {};
  // Geo override for testing (?__country=SA&__region=QC&__eu=1). TEST WORKER ONLY:
  // honoured only when LAW_FIXES === '1', which is "0" in [env.production.vars], so a
  // production visitor can never spoof their location. Exists because VPN "virtual"
  // locations (Saudi Arabia, Thailand…) are often physically elsewhere and Cloudflare
  // geolocates the real IP, which makes geo-target untestable by VPN for those countries.
  const _geoOv = env.LAW_FIXES === '1' ? url.searchParams : null;
  const _ovCountry = _geoOv && _geoOv.get('__country');
  const _ovRegion = _geoOv && _geoOv.get('__region');
  const _ovEu = _geoOv && _geoOv.get('__eu');
  const country = (_ovCountry ? String(_ovCountry).toUpperCase() : null) || cf.country || null;
  const isEU = _ovEu != null ? _ovEu === '1' : cf.isEUCountry === '1';
  // Two-letter US state code ("CA", "VA", ...). Workers hands this to us directly —
  // the same source /api/consent already logs at consent.js:18. Do NOT try to read
  // it from headers: CF-IPState / CF-IPREGION are not headers Cloudflare emits
  // (the legacy app.consentbit.com resolver did that and silently saw every US
  // visitor as California).
  const regionCode = (_ovRegion ? String(_ovRegion).toUpperCase() : null) || cf.regionCode || null;

  // Countries whose law requires a consent banner, used only to stop the
  // CCPA-only path suppressing it. Deliberately a plain Set and not the fuller
  // law-profile registry: this is a targeted fix to live behaviour, and the
  // smallest change that removes the exposure is the right one.
  //
  // EU/EEA is covered separately by `isEU`, which Cloudflare already gives us.
  const BANNER_REQUIRED_COUNTRIES = new Set([
    'GB', 'CH', 'NO', 'IS', 'LI',   // UK GDPR, Swiss FADP, EEA non-EU
    'BR',                            // LGPD
    'AU',                            // Privacy Act
    'CA',                            // PIPEDA + Quebec Law 25
    'SG',                            // PDPA
    'TH',                            // PDPA
    'ZA',                            // POPIA
    'SA',                            // PDPL
    'NZ',                            // Privacy Act 2020
    'JP', 'KR', 'IN',                // APPI, PIPA, DPDPA
  ]);

  // Non-US law profiles — RECORDED ONLY. Ported from cdnTest.js 2026-10-08.
  //
  // The US equivalent is US_STATE_LAWS below, keyed on region within
  // country==='US'. This is the same idea for everywhere else. Nothing here
  // changes what is served: banner choice still comes from region_mode and
  // BANNER_REQUIRED_COUNTRIES above. The profile only travels to the runtime as
  // `countryLaw`, which stamps it onto the consent row (law / consent_model /
  // lang_wanted — optional columns, dropped by consent.js if D1 lacks them).
  //
  //   law         what the consent record names
  //   model       'optin' | 'notice' — informational; every entry is served the
  //               opt-in banner, which is lawful everywhere here
  //   langWanted  the language this law points to. Recorded only — the banner
  //               always shows the site owner's selected language (decision 11 Sept 2026)
  //
  // NAMESPACE: country codes only. Never merge with US_STATE_LAWS — 'CA' is both
  // Canada's country code and California's region code.
  const COUNTRY_LAWS = {
    BR: { law: 'LGPD',        model: 'optin',  langWanted: 'pt-BR', minorAge: 13 },
    SG: { law: 'PDPA_SG',     model: 'notice' },                // English; SG law has no sensitive category
    TH: { law: 'PDPA_TH',     model: 'optin',  langWanted: 'th' },
    AU: { law: 'PRIVACY_ACT', model: 'notice', langWanted: 'en-AU', minorAge: 18 },
    CA: { law: 'PIPEDA',      model: 'notice' },                // federal; Quebec overridden below
    ZA: { law: 'POPIA',       model: 'optin',  minorAge: 18 },
    SA: { law: 'PDPL',        model: 'optin',  langWanted: 'ar', rtl: true },
    // Gap M: UK consents were recorded with no law, i.e. indistinguishable from EU GDPR.
    GB: { law: 'UK_GDPR',     model: 'optin' },
    // EEA, not EU: GDPR applies via the EEA Agreement, but isEU below is EU-only.
    NO: { law: 'GDPR',        model: 'optin' },
    IS: { law: 'GDPR',        model: 'optin' },
    LI: { law: 'GDPR',        model: 'optin' },
  };

  // Gap E: EU visitors matched nothing above, so their consent rows named no law.
  const EU_LAW = { law: 'GDPR', model: 'optin' };

  // Region overrides, keyed `${country}-${region}`. Checked before COUNTRY_LAWS.
  // Quebec: Law 25 is materially stricter than PIPEDA (express per-purpose
  // consent, privacy-by-default s. 9.1, French), so one Canadian profile cannot
  // serve both.
  // NAMESPACE WARNING: keys here are `country-region`, never bare.
  const REGION_LAWS = {
    'CA-QC': {
      law: 'LAW25', model: 'optin', langWanted: 'fr',
      privacyByDefault: true,   // s. 9.1 — highest confidentiality by default
      perPurposeConsent: true,  // consent requested separately per purpose
    },
  };

  const countryLaw =
    (country && regionCode && REGION_LAWS[`${country}-${String(regionCode).toUpperCase()}`]) ||
    (country && COUNTRY_LAWS[country]) ||
    (isEU ? EU_LAW : null) ||
    null;

  // Minimum-legal-requirements fixes (law recorded on the consent row, "Do Not Sell or
  // Share" title, 12-month CCPA opt-out) are TEST-ONLY until verified: LAW_FIXES is "1"
  // in the test worker's [vars] and "0" in [env.production.vars]. Off = previous behaviour.
  const lawFixes = env.LAW_FIXES === '1';

  // Plan entitlement, enforced at SERVE time (added 2026-09-23).
  //
  // region_mode 'both' (GDPR+CCPA geo-routing) and banner_type 'iab' (IAB/TCF) are
  // Essential/Growth only. Until now nothing re-checked them when a plan CHANGED:
  // handlers/bannerCustomization.js clamps 'both' only while SAVING banner settings, and
  // no tier-change / scheduled-downgrade / cancellation path touches Site.region_mode.
  // So a site downgraded to Basic or Free kept serving the paid behaviour indefinitely.
  //
  // Doing it here covers every route into a downgrade at once, including sites that are
  // already wrong, with no data backfill. The stored value is left alone — this only
  // decides what is SERVED, so restoring the plan restores the banner with no re-save.
  const PAID_REGION_PLANS = ['essential', 'growth'];
  const planAllowsPaidRegions = PAID_REGION_PLANS.includes(String(effectivePlanId || 'free').toLowerCase());
  const storedRegionMode = resolvedSite.region_mode || 'gdpr';
  const storedBannerType = resolvedSite.banner_type || 'gdpr';
  const regionMode = (!planAllowsPaidRegions && storedRegionMode === 'both') ? 'gdpr' : storedRegionMode;
  let effectiveBannerType = (!planAllowsPaidRegions && String(storedBannerType).toLowerCase() === 'iab') ? 'gdpr' : storedBannerType;
  if (!planAllowsPaidRegions && (storedRegionMode === 'both' || String(storedBannerType).toLowerCase() === 'iab')) {
    console.warn(`[CDN] plan '${effectivePlanId}' does not include both-regions/IAB — serving gdpr`, {
      siteId: resolvedSite.id, storedRegionMode, storedBannerType,
    });
  }
  let bannerEnabled = true;

  // Quebec on a CCPA-only site (TEST-ONLY via lawFixes, decided 2026-10-12): keep the
  // customer's CCPA banner instead of switching to the opt-in one, but with everything
  // OFF until the visitor chooses (Law 25 s. 8.1 / 9.1 privacy by default). The runtime
  // treats "no choice yet" as opted out (cbDNS), so the "Do Not Sell or Share" box starts
  // ticked and unticking + saving is how the visitor turns cookies on. Quebec only — the
  // EU, UK and other opt-in countries still get the opt-in banner.
  const quebecCcpaOff = lawFixes && countryLaw && countryLaw.law === 'LAW25';
  let quebecDefaultOff = false;

  const siteWantsIab = String(effectiveBannerType || '').toLowerCase() === 'iab';

  if (!siteWantsIab) {
    if (regionMode === 'both') {
      if (isEU) {
        effectiveBannerType = 'gdpr';
      } else if (country === 'US') {
        effectiveBannerType = 'ccpa';
      } else {
        effectiveBannerType = 'gdpr';
      }
    } else if (regionMode === 'ccpa') {
      // CCPA-only site: every visitor, in every country, gets the CCPA banner
      // (decided 2026-10-19). The site owner chose CCPA only, so we no longer
      // switch EU / opt-in-country visitors to the GDPR banner or hide the
      // banner elsewhere. Quebec keeps its everything-off default (test-only).
      effectiveBannerType = 'ccpa';
      if (country !== 'US' && quebecCcpaOff) quebecDefaultOff = true;
    } else if (effectiveBannerType === 'ccpa') {
      // Same rule: the CCPA banner for every visitor.
      if (country !== 'US' && quebecCcpaOff) quebecDefaultOff = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Banner region (all plans; added 2026-11-24 for Google CMP audit i.7, per banner type
  // since 2026-11-25, modelled on CookieYes "Geo-target banner")
  // ---------------------------------------------------------------------------
  // The banner TYPE (GDPR / CCPA / GDPR + CCPA) is unchanged and routed as above. The
  // banner REGION decides where that banner is shown. translations.config.bannerRegion,
  // set in the webapp banner editor (General tab, BannerRegionCard.tsx):
  //   { gdpr: 'worldwide' | 'europe' | 'countries', gdprCountries: ['IN', ...],
  //     ccpa: 'worldwide' | 'us'     | 'countries', ccpaCountries: ['US', 'CA-QC', ...] }
  //   'europe' (string, first version) = { gdpr: 'europe' }. Missing / junk = worldwide.
  //   'countries' with an empty list = worldwide. Country codes are ISO alpha-2, or
  //   country-region ('CA-QC' = Quebec) matched against Cloudflare's regionCode.
  //   europe = EU + EEA + UK + Switzerland.
  // GDPR-only and CCPA-only sites: the served banner's region must contain the visitor.
  // GDPR + CCPA sites:
  //   1. An explicit region (not worldwide; the CCPA default counts as 'us') that contains
  //      the visitor claims them for that banner. Claimed by both → the routing above
  //      decides (US → CCPA, else GDPR).
  //   2. Claimed by neither → the routed banner if its region is worldwide; else the GDPR
  //      banner if the GDPR region is worldwide (the GDPR "all other countries" catch-all;
  //      CCPA worldwide only ever means the routed US visitors); else no banner.
  // No banner = the existing opt-out path (bannerType 'ccpa') with bannerEnabled=false: the
  // runtime shows no banner and no floating button, blocks nothing, and signals granted
  // (denied only for a GPC opt-out). IAB sites are not affected. An unknown country (no
  // Cloudflare geo, Tor 'T1', 'XX') keeps whatever banner it had.
  const BANNER_REGION_EUROPE_EXTRA = new Set([
    'NO', 'IS', 'LI',                         // EEA, not EU (isEU is Cloudflare's EU-27 flag)
    'GB', 'CH',                               // UK, Switzerland
    'GF', 'GP', 'MQ', 'RE', 'YT', 'MF', 'AX', // EU outermost regions / Åland
  ]);
  const bannerRegionCfg = { gdpr: 'worldwide', gdprCountries: [], ccpa: 'worldwide', ccpaCountries: [] };
  try {
    const _brTr = customization && customization.translations
      ? (typeof customization.translations === 'string' ? JSON.parse(customization.translations) : customization.translations)
      : null;
    const _br = _brTr && _brTr.config ? _brTr.config.bannerRegion : null;
    const _brList = (a) => (Array.isArray(a) ? a : [])
      .map((c) => String(c).toUpperCase())
      .filter((c) => /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(c))
      .slice(0, 400);
    if (_br === 'europe') {
      bannerRegionCfg.gdpr = 'europe';
    } else if (_br && typeof _br === 'object') {
      const _g = String(_br.gdpr || ''), _c = String(_br.ccpa || '');
      const _gl = _brList(_br.gdprCountries), _cl = _brList(_br.ccpaCountries);
      if (_g === 'europe') bannerRegionCfg.gdpr = 'europe';
      else if (_g === 'countries' && _gl.length) { bannerRegionCfg.gdpr = 'countries'; bannerRegionCfg.gdprCountries = _gl; }
      if (_c === 'us') bannerRegionCfg.ccpa = 'us';
      else if (_c === 'countries' && _cl.length) { bannerRegionCfg.ccpa = 'countries'; bannerRegionCfg.ccpaCountries = _cl; }
    }
  } catch (_) { /* invalid JSON → worldwide */ }
  const _brServed = String(effectiveBannerType || '').toLowerCase();
  // storedBannerType, not siteWantsIab: an IAB site on a plan without IAB is served the
  // GDPR banner, but the region card is hidden for IAB sites, so leave those alone too.
  const bannerRegionActive = (bannerRegionCfg.gdpr !== 'worldwide' || bannerRegionCfg.ccpa !== 'worldwide') &&
    String(storedBannerType || '').toLowerCase() !== 'iab' &&
    !!country && country !== 'XX' && country !== 'T1' &&
    (_brServed === 'gdpr' || _brServed === 'ccpa');
  let outsideBannerRegion = false;
  if (bannerRegionActive) {
    const _brIn = (mode, list) => {
      if (mode === 'europe') return isEU || BANNER_REGION_EUROPE_EXTRA.has(country);
      if (mode === 'us') return country === 'US';
      if (mode === 'countries') return list.includes(country) || (!!regionCode && list.includes(`${country}-${regionCode}`));
      return true; // worldwide
    };
    let _brPick;
    if (regionMode === 'both') {
      const claimG = bannerRegionCfg.gdpr !== 'worldwide' && _brIn(bannerRegionCfg.gdpr, bannerRegionCfg.gdprCountries);
      // The CCPA default on a GDPR + CCPA site is the US (the dashboard labels it so), so it
      // claims US visitors like an explicit 'us' would.
      const claimC = _brIn(bannerRegionCfg.ccpa === 'worldwide' ? 'us' : bannerRegionCfg.ccpa, bannerRegionCfg.ccpaCountries);
      if (claimG && claimC) _brPick = _brServed;
      else if (claimG) _brPick = 'gdpr';
      else if (claimC) _brPick = 'ccpa';
      else if (bannerRegionCfg[_brServed] === 'worldwide') _brPick = _brServed;
      else if (bannerRegionCfg.gdpr === 'worldwide') _brPick = 'gdpr';
      else _brPick = null;
    } else {
      _brPick = _brServed === 'ccpa'
        ? (_brIn(bannerRegionCfg.ccpa, bannerRegionCfg.ccpaCountries) ? 'ccpa' : null)
        : (_brIn(bannerRegionCfg.gdpr, bannerRegionCfg.gdprCountries) ? 'gdpr' : null);
    }
    if (!_brPick) {
      outsideBannerRegion = true;
      effectiveBannerType = 'ccpa';
      bannerEnabled = false;
    } else if (_brPick !== _brServed) {
      // GDPR + CCPA only: the region moved this visitor to the other banner.
      effectiveBannerType = _brPick;
      if (_brPick === 'ccpa' && country !== 'US' && quebecCcpaOff) quebecDefaultOff = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Regional requirements (Essential / Growth; TEST-ONLY via lawFixes, 2026-10-14)
  // ---------------------------------------------------------------------------
  // translations.config.regionalLanguages, set in the webapp banner editor (General tab):
  //   { quebec: true }  → visitors in Quebec see the banner in French (Law 25 + Charter
  //                       of the French Language)
  //   { brazil: true }  → visitors in Brazil see it in Brazilian Portuguese (LGPD / ANPD)
  // Language only: who sees a banner, and which one, still comes from region_mode above,
  // and the consent rules (opt-in, Quebec default-off) apply whether ticked or not.
  // Replaces the 2026-10-12 geo-target (which hid the banner outside the selected
  // countries); a leftover config.geoTarget is ignored. Gated on lawFixes because test
  // and production share the D1 row this is read from; plan re-checked at serve time.
  let regionalLanguages = null;
  try {
    const _rlTr = customization && customization.translations
      ? (typeof customization.translations === 'string' ? JSON.parse(customization.translations) : customization.translations)
      : null;
    const _rl = _rlTr && _rlTr.config && _rlTr.config.regionalLanguages;
    if (_rl && typeof _rl === 'object') regionalLanguages = { quebec: _rl.quebec === true, brazil: _rl.brazil === true };
  } catch (_) { /* invalid JSON → off */ }
  const regionalActive = lawFixes && !!regionalLanguages && planAllowsPaidRegions && !siteWantsIab;

  // Google Consent Mode debug toggle (webapp banner editor → "Google Consent Mode" card),
  // stored as translations.config.gcmDebug = "1". OFF by default: a missing or any other
  // value is off. When on, every visitor's console gets the debug report (no on-page
  // panel). Gated on GCM_TOOLS because test and production share the D1 row.
  let gcmDebugConsole = false;
  if (env.GCM_TOOLS === '1') {
    try {
      const _gTr = customization && customization.translations
        ? (typeof customization.translations === 'string' ? JSON.parse(customization.translations) : customization.translations)
        : null;
      gcmDebugConsole = !!(_gTr && _gTr.config && String(_gTr.config.gcmDebug) === '1');
    } catch (_) { /* invalid JSON → off */ }
  }

  // Google Consent Mode: Advanced / Basic / Off (all plans; added 2026-11-25 for Google CMP
  // audit iii.5, modelled on CookieYes "Support GCM" + "Allow Google tags to fire before
  // consent"). Webapp banner editor → "Google Consent Mode" card, stored as
  //   translations.config.gcmSupport           "0" = Off (no Google consent commands at all)
  //   translations.config.gcmTagsBeforeConsent "0" = Basic (Google tags blocked until consent)
  // Missing / any other value = "1", so every existing site stays in Advanced (unchanged).
  //   advanced  Google tags load at once; consent default denied, updated on the choice.
  //   basic     Google tags (gtag.js, gtm.js, google-analytics.com) are blocked and no Google
  //             command is sent until the visitor accepts Analytics or Marketing; then the
  //             consent default is published with the chosen states and the tags load.
  //             Opt-out (CCPA) visitors have nothing to accept first, so they get Advanced.
  //   off       no gtag('consent'|'set') at all; Google tags are ordinary trackers, released
  //             by category (GTM needs Analytics AND Marketing: nothing inside it sees a signal).
  // NOT gated on GCM_TOOLS: Google requires the opt-out in production. Not applied to IAB
  // (the TCF bundle has its own loader; Google reads the TC string there). A page whose
  // ConsentBit script is loaded by our GTM template (window.__cbGtmInstall) stays Advanced
  // at runtime: the template publishes its own defaults inside GTM.
  let gcmMode = 'advanced';
  try {
    const _gmTr = customization && customization.translations
      ? (typeof customization.translations === 'string' ? JSON.parse(customization.translations) : customization.translations)
      : null;
    const _gmCfg = _gmTr && _gmTr.config;
    if (_gmCfg && String(_gmCfg.gcmSupport) === '0') gcmMode = 'off';
    else if (_gmCfg && String(_gmCfg.gcmTagsBeforeConsent) === '0') gcmMode = 'basic';
  } catch (_) { /* invalid JSON → advanced */ }
  // storedBannerType, not siteWantsIab: the dashboard hides the toggles for IAB sites, and the
  // IAB-on-Webflow loader reuses webflowSetup.js, which would otherwise read the mode.
  if (String(storedBannerType || '').toLowerCase() === 'iab') gcmMode = 'advanced';

  // ---------------------------------------------------------------------------
  // US state privacy law resolution
  // ---------------------------------------------------------------------------
  // effectiveBannerType deliberately STAYS 'ccpa' for every US state. The runtime
  // has 6 `"ccpa"===i` branches driving the opt-out UI, the Do-Not-Sell link, the
  // GPC auto-opt-out and the Consent Mode defaults; putting a statute name in
  // bannerType would turn all of them off for exactly the visitors we are trying
  // to serve. The statute travels in its own `usLaw` field instead.
  //
  // optOut — which consent categories the opt-out control actually withdraws:
  //   CCPA/CPRA (CA) sale + sharing (cross-context behavioural advertising)
  //   VCDPA (VA), CPA (CO), CTDPA (CT) sale + targeted advertising + profiling
  //   UCPA (UT) sale + targeted advertising ONLY — Utah grants no profiling
  //     opt-out, so analytics stays granted there. This is the one real
  //     category-level divergence between the five statutes.
  //
  // gpcMandated — whether a universal opt-out signal is legally binding:
  //   CA (CCPA regs), CO (since 2024-07-01), CT (since 2025-01-01) yes.
  //   VA and UT have no UOOM mandate. We still HONOUR the signal there — it is
  //   privacy-protective and dropping it would regress today's behaviour — but
  //   the flag is recorded so consent logs show whether it was required or
  //   volunteered.
  const US_STATE_LAWS = {
    CA: { law: 'CCPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: true },
    VA: { law: 'VCDPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: false },
    CO: { law: 'CPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: true },
    CT: { law: 'CTDPA', optOut: ['analytics', 'marketing', 'preferences'], gpcMandated: true },
    UT: { law: 'UCPA', optOut: ['marketing'], gpcMandated: false },
  };

  // Only meaningful when the visitor is actually getting the US opt-out banner.
  // A state we have no statute for falls back to the CCPA profile: it is the
  // strictest of the five, so an unmapped state is over- rather than
  // under-protected. Null for GDPR visitors.
  let usLaw = null;
  if (country === 'US' && String(effectiveBannerType).toLowerCase() === 'ccpa') {
    const matched = regionCode ? US_STATE_LAWS[String(regionCode).toUpperCase()] : null;
    const profile = matched || US_STATE_LAWS.CA;
    usLaw = {
      law: profile.law,
      state: regionCode || null,
      optOut: profile.optOut,
      gpcMandated: profile.gpcMandated,
      // false when we defaulted because regionCode was absent or unmapped —
      // lets the consent log distinguish "known California" from "assumed".
      resolved: !!matched,
    };
  }

  let customStyles = null;
  let bannerLayoutVisualForConfig = 'box';
  const LANG_NAME_TO_CODE = {
    English: 'en', Spanish: 'es', French: 'fr', German: 'de',
    Italian: 'it', Polish: 'pl', Portuguese: 'pt', Swedish: 'sv', Dutch: 'nl'
  };
  function normalizeLangCode(raw) {
    if (!raw) return 'en';
    const s = String(raw).trim();
    return LANG_NAME_TO_CODE[s] || (s.length <= 3 ? s.toLowerCase() : 'en');
  }

  const SECTION_LABELS = {
    en: { essential: 'Strictly Necessary', analytics: 'Analytics',   marketing: 'Marketing',      preferences: 'Preferences'  },
    es: { essential: 'Estrictamente Necesarias', analytics: 'Analíticas',  marketing: 'Marketing',      preferences: 'Preferencias' },
    fr: { essential: 'Strictement Nécessaires',  analytics: 'Analytiques', marketing: 'Marketing',      preferences: 'Préférences'  },
    de: { essential: 'Unbedingt Notwendig',      analytics: 'Analytik',    marketing: 'Marketing',      preferences: 'Einstellungen'},
    it: { essential: 'Strettamente Necessari',   analytics: 'Analitica',   marketing: 'Marketing',      preferences: 'Preferenze'   },
    pt: { essential: 'Estritamente Necessários', analytics: 'Analíticos',  marketing: 'Marketing',      preferences: 'Preferências' },
    sv: { essential: 'Strikt Nödvändiga',        analytics: 'Analytik',    marketing: 'Marknadsföring', preferences: 'Inställningar'},
    nl: { essential: 'Strikt Noodzakelijk',      analytics: 'Analytics',   marketing: 'Marketing',      preferences: 'Voorkeuren'   },
    pl: { essential: 'Ściśle Niezbędne',         analytics: 'Analityczne', marketing: 'Marketingowe',   preferences: 'Preferencje'  },
  };

  let enTrans = {};
  if (customization) {
    const rawPos = customization.position || 'bottom-left';
    const normPos = String(rawPos).trim().toLowerCase().replace(/_/g, '-');
    let position = 'bottom-left';
    if (normPos === 'bottom-right' || normPos === 'right') position = 'bottom-right';
    else if (normPos === 'bottom-center' || normPos === 'center') position = 'bottom-center';
    else if (normPos === 'bottom') position = 'bottom';
    else if (normPos === 'bottom-left' || normPos === 'left') position = 'bottom-left';
    const bgColor = customization.backgroundColor || '#ffffff';
    const textColor = customization.textColor || '#334155';
    const headingColor = customization.headingColor || '#0f172a';
    var _rawRadius = customization.bannerBorderRadius || '1.25rem';
    var _radiusPx = _rawRadius.endsWith('rem') ? Math.round(parseFloat(_rawRadius) * 16) : Math.round(parseFloat(_rawRadius) || 20);
    if (_radiusPx > 25) { _rawRadius = '1.5625rem'; }
    const bannerRadius = _rawRadius;
    var _rawBtnRadius = customization.buttonBorderRadius || '0.3125rem';
    var _btnRadiusPx = _rawBtnRadius.endsWith('rem') ? Math.round(parseFloat(_rawBtnRadius) * 16) : Math.round(parseFloat(_rawBtnRadius) || 5);
    if (_btnRadiusPx > 25) { _rawBtnRadius = '1.5625rem'; }
    const buttonRadius = _rawBtnRadius;
    var acceptBg = customization.acceptButtonBg || '#007aff';
    var acceptTx = customization.acceptButtonText || '#ffffff';
    var rejectBg = acceptBg;
    var rejectTx = acceptTx;
    var custBg = customization.customiseButtonBg || '#ffffff';
    var custTx = customization.customiseButtonText || '#0284c7';
    var saveBg = customization.saveButtonBg || custBg;
    var saveTx = customization.saveButtonText || '#0284c7';
    // Button border: when the button background is white the outline uses the
    // button's own text colour (otherwise a white button on a white banner has no
    // edge). Any other background keeps a border in that same background colour,
    // so the text colour never shows up as a stray outline around a filled button.
    var isWhiteColor = function (c) {
      var h = String(c || '').trim().toLowerCase().replace(/s+/g, '');
      return h === '#fff' || h === '#ffffff' || h === '#ffffffff' || h === 'white' || h === 'rgb(255,255,255)' || h === 'rgba(255,255,255,1)';
    };
    var btnBorder = function (bg, tx) { return isWhiteColor(bg) ? tx : bg; };

    var configTrans = {};
    try {
      var trRaw = customization.translations;
      if (trRaw) {
        var trParsed = typeof trRaw === 'string' ? JSON.parse(trRaw) : trRaw;
        if (trParsed && trParsed.config) {
          configTrans = trParsed.config;
        }
        if (trParsed && trParsed.en) {
          enTrans = trParsed.en;
        }
      }
    } catch (eTy) {
      enTrans = {};
      configTrans = {};
    }
    const _langCode = enTrans.languageSelected || normalizeLangCode(customization.language);
    const _labels = SECTION_LABELS[_langCode] || SECTION_LABELS['en'];
    enTrans.essential = _labels.essential;
    enTrans.strictlyNecessary = '';
    if (!enTrans.analytics)           enTrans.analytics           = _labels.analytics;
    if (!enTrans.marketing)           enTrans.marketing           = _labels.marketing;
    if (!enTrans.preferences)         enTrans.preferences         = _labels.preferences;
    if (!enTrans.cookiePreferences)   enTrans.cookiePreferences   = 'Cookie Preferences';


    var layoutVisual = 'box';
    try {
      var _lvSrc = configTrans.bannerLayoutVisual != null ? configTrans.bannerLayoutVisual : enTrans.bannerLayoutVisual;
      var lvRaw = _lvSrc != null ? String(_lvSrc).toLowerCase() : 'box';
      if (lvRaw === 'banner' || lvRaw === 'fullwidth') layoutVisual = 'banner';
      else if (lvRaw === 'bottom-center' || lvRaw === 'centeralign' || lvRaw === 'popup') layoutVisual = 'bottom-center';
    } catch (eLayout) {}
    bannerLayoutVisualForConfig = layoutVisual;

    var fontWeightStr = String((configTrans.bannerFontWeight != null ? configTrans.bannerFontWeight : enTrans.bannerFontWeight) || '600');
    var textAlign = (configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : enTrans.bannerTextAlign) || 'left';
    if (textAlign !== 'center' && textAlign !== 'right') {
      textAlign = 'left';
    }
    var footerJustify = textAlign === 'center' ? 'center' : textAlign === 'right' ? 'flex-end' : 'flex-start';
    var bannerFooterJustify = textAlign === 'center' ? 'center' : 'flex-end';
    var closeButtonEnabled = ((configTrans.closeButtonEnabled != null ? configTrans.closeButtonEnabled : enTrans.closeButtonEnabled) === '1');
    var boxPadding = closeButtonEnabled ? '28px 20px 20px 20px' : '20px';
    var fontFamilyCss = 'inherit';
    try {
      var _fontMode = configTrans.bannerFontMode != null
        ? configTrans.bannerFontMode
        : (enTrans && enTrans.bannerFontMode);
      var _fontEnabled = configTrans.bannerFontEnabled != null
        ? configTrans.bannerFontEnabled
        : (enTrans && enTrans.bannerFontEnabled);
      var _useBannerFont = _fontMode != null
        ? String(_fontMode).toLowerCase() === 'default'
        : (_fontEnabled === '1' || _fontEnabled === 1 || _fontEnabled === true);
      if (_useBannerFont) {
        fontFamilyCss = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      }
    } catch (eFont) {}

    var positionStyles = '';
    var isBoldHeavy = fontWeightStr === '800' || fontWeightStr === '900';
    var descLen = String((enTrans && enTrans.description) || '').length;
    var maxBtnLen = Math.max(
      String((enTrans && enTrans.acceptAll) || '').length,
      String((enTrans && enTrans.rejectAll) || '').length,
      String((enTrans && enTrans.customise) || '').length
    );
    var perBtnPx = Math.max(maxBtnLen * 8 + 56, 90);
    var btnRowWidth = perBtnPx * 3 + 32 + 32;
    var isLongDesc = descLen > 200;
    var baseWidthPx = Math.max(520, btnRowWidth);
    if (isLongDesc && baseWidthPx < 560) baseWidthPx = Math.max(baseWidthPx, isBoldHeavy ? 680 : 560);
    var baseWidth = baseWidthPx + 'px';
    var maxWidth = baseWidthPx + 'px';
    var initialSize =
      'width:' + baseWidth + '!important;min-width:360px;max-width:min(' + maxWidth + ',96vw)!important;max-height:min(80vh,600px);overflow:hidden;';
    var initialRadius = 'border-radius:' + bannerRadius + '!important;';
    if (layoutVisual === 'banner') {
      initialSize = 'width:100%!important;max-width:none!important;';
      positionStyles = 'bottom:0!important;left:0!important;right:auto!important;transform:none;';
      initialRadius = 'border-radius:' + bannerRadius + '!important;';
    } else if (layoutVisual === 'bottom-center') {
      initialSize =
        'width:' + baseWidth + '!important;min-width:360px;max-width:min(' + maxWidth + ',96vw)!important;max-height:min(80vh,600px);overflow:hidden;';
      positionStyles = 'bottom:32px!important;left:50%!important;transform:translateX(-50%);';
      initialRadius = 'border-radius:' + bannerRadius + '!important;';
    } else {
      if (position === 'bottom-right') {
        positionStyles = 'bottom:32px!important;right:21px!important;left:auto!important;transform:none;';
      } else if (position === 'bottom-center' || position === 'bottom') {
        positionStyles = 'bottom:32px!important;left:50%!important;transform:translateX(-50%);';
      } else {
        positionStyles = 'bottom:32px!important;left:21px!important;right:auto!important;transform:none;';
      }
    }

    if (effectiveBannerType === 'ccpa' && layoutVisual !== 'banner') {
      var ccpaWidthPx = Math.max(baseWidthPx, 600);
      initialSize = 'width:' + ccpaWidthPx + 'px!important;min-width:360px;max-width:min(' + ccpaWidthPx + 'px,96vw)!important;max-height:min(80vh,660px);overflow:hidden;';
    }

    customStyles =
      ".cb-banner{border:none !important;}" +
      // font-family is NOT inherited into form controls (button/input/select/
      // textarea): the UA stylesheet declares its own font on them, and a UA
      // declaration outranks inheritance. Force every descendant to inherit so
      // the whole banner follows the container font resolved above. The close
      // (x) buttons set their font inline, so they keep the system stack.
      ".cb-banner *{font-family:inherit;}" +
      "#cb-initial-banner.cb-banner{" +
        initialSize +
        "background-color:" + bgColor + "!important;" +
        "color:" + textColor + ";" +
        "position:fixed!important;" +
        positionStyles +
        "padding:" + (layoutVisual === 'banner' ? "28px 48px" : boxPadding) + "!important;" +
        "border:1px solid #e2e8f0;" +
        initialRadius +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "align-items:stretch;" +
        "font-family:" + fontFamilyCss + ";" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body{" +
        "flex:0 1 auto;" +
        "min-width:0;" +
        "min-height:0;" +
        "overflow-y:auto;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-close-initial-btn," +
      "#cb-initial-banner.cb-banner [consentbit='close']{" +
        "position:absolute!important;" +
        "top:8px!important;" +
        "right:20px!important;" +
        "width:10px!important;" +
        "height:10px!important;" +
        "cursor:pointer!important;" +
        "background:transparent!important;" +
        "border:none!important;" +
        "padding:0!important;" +
        "z-index:10!important;" +
        "display:" + (closeButtonEnabled ? "block" : "none") + "!important;" +
      "}" +
      "#cb-preferences-banner.cb-banner{" +
        "width:600px;" +
        "max-width:94vw;" +
        "max-height:min(88vh,640px);" +
        "min-height:0;" +
        "overflow:hidden;" +
        "background-color:" + bgColor + ";" +
        "color:" + textColor + ";" +
        "position:fixed;" +
        "top:50%;" +
        "left:50%;" +
        "transform:translate(-50%,-50%);" +
        "padding:28px;" +
        "border:1px solid #e2e8f0;" +
        "border-radius:" + bannerRadius + ";" +
        "box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);" +
        "z-index:2147483647;" +
        "display:flex;" +
        "flex-direction:column;" +
        "font-family:" + fontFamilyCss + ";" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "font-weight:" + fontWeightStr + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-banner-body{" +
        "flex:1 1 auto;" +
        "min-height:0;" +
        "overflow-y:auto;" +
      "}" +
      ".cb-banner h3{" +
        "margin:0 0 8px;" +
        "font-size:16px!important;" +
        "line-height:1.4!important;" +
        "font-weight:600;"  +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      "#cb-initial-banner.cb-banner h3," +
      "#cb-preferences-banner.cb-banner h3{" +
        "font-weight:600!important;"  +
        "color:" + headingColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body h3," +
      "#cb-preferences-banner.cb-banner .cb-banner-body h3{" +
        "padding-right:0!important;" +
      "}" +
      ".cb-gdpr-cat-label{" +
        "color:" + headingColor + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-gdpr-cat-label ~ div > span{" +
        "color:" + textColor + "!important;" +
      "}" +
      ".cb-banner p{" +
        "margin:0 0 12px;" +
        "font-size:14px!important;" +
        "line-height:1.5!important;" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "width:100%;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-body > p," +
      "#cb-preferences-banner.cb-banner .cb-banner-body > p," +
      "#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{" +
        "color:" + textColor + ";" +
        "text-align:" + textAlign + "!important;" +
        "opacity:0.92;" +
        "width:100%;" +
      "}" +
      ".cb-banner button{" +
        "padding:6px 12px;" +
        "border-radius:" + buttonRadius + ";" +
        "cursor:pointer;" +
        "font-size:14px;" +
        "font-weight:600;" +
        "border:1px solid #e2e8f0;" +
        "transition:opacity 0.2s;" +
      "}" +
      ".cb-banner button#cb-accept-all-btn{" +
        "background-color:" + acceptBg + ";" +
        "color:" + acceptTx + ";" +
        "border-color:" + btnBorder(acceptBg, acceptTx) + ";" +
      "}" +
      ".cb-banner button#cb-reject-all-btn{" +
        "background-color:" + rejectBg + ";" +
        "color:" + rejectTx + ";" +
        "border-color:" + btnBorder(rejectBg, rejectTx) + ";" +
      "}" +
      ".cb-banner button#cb-preferences-btn," +
      ".cb-banner button#cb-ccpa-donotsell-link{" +
        "background-color:" + custBg + ";" +
        "color:" + custTx + ";" +
        "border-color:" + btnBorder(custBg, custTx) + ";" +
      "}" +
      ".cb-banner button#cb-prefs-reject-btn{" +
        "background-color:" + rejectBg + ";" +
        "color:" + rejectTx + ";" +
        "border-color:" + btnBorder(rejectBg, rejectTx) + ";" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer{" +
        "display:flex!important;" +
        "flex-direction:row!important;" +
        "gap:10px!important;" +
        "width:100%!important;" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button{" +
        "flex:1 1 0!important;" +
        "width:0!important;" +
        "min-width:0!important;" +
        "white-space:nowrap!important;" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{" +
        "background-color:" + acceptBg + ";" +
        "color:" + acceptTx + ";" +
        "border-color:" + btnBorder(acceptBg, acceptTx) + ";" +
      "}" +
      "#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + saveBg + ";" +
        "color:" + saveTx + ";" +
        "border-color:" + btnBorder(saveBg, saveTx) + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{" +
        "background-color:" + saveBg + ";" +
        "color:" + saveTx + ";" +
        "border-color:" + btnBorder(saveBg, saveTx) + ";" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-banner-footer button{" +
        "padding:10px 36px!important;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-footer{" +
        "display:flex;" +
        "flex-wrap:nowrap;" +
        "gap:8px;" +
        "justify-content:" + footerJustify + "!important;" +
        "flex-shrink:0;" +
      "}" +
      "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
        "flex:1 1 0;" +
        "min-width:" + perBtnPx + "px;" +
        "white-space:nowrap;" +
        "overflow:visible;" +
        "text-overflow:clip;" +
      "}" +
      (layoutVisual === 'banner'
        ?
          "#cb-initial-banner.cb-banner{" +
            "flex-direction:column!important;align-items:stretch!important;" +
          "}" +
          "#cb-initial-banner.cb-banner .cb-banner-body{" +
            "flex:1 1 auto!important;min-width:0!important;overflow-y:visible!important;padding:0!important;margin:0!important;" +
          "}" +
          "#cb-initial-banner.cb-banner .cb-banner-footer{" +
            "position:relative!important;flex:0 0 auto!important;flex-wrap:nowrap!important;justify-content:" + bannerFooterJustify + "!important;padding:0!important;margin:0!important;" +
          "}" +
          "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
            "flex:0 0 auto!important;width:auto!important;min-width:" + perBtnPx + "px!important;max-width:none!important;white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important;" +
          "}" +
          "@media(max-width:660px){" +
            "#cb-initial-banner.cb-banner{left:0!important;right:0!important;}" +
          "}"
        : "") +
      "#cb-initial-banner.cb-banner #cb-preferences-btn{" +
        "background:" + custBg + "!important;" +
        "color:" + custTx + "!important;" +
        "border-color:" + btnBorder(custBg, custTx) + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-reject-all-btn{" +
        "background:" + rejectBg + "!important;" +
        "color:" + rejectTx + "!important;" +
        "border-color:" + btnBorder(rejectBg, rejectTx) + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      "#cb-initial-banner.cb-banner #cb-accept-all-btn{" +
        "background:" + acceptBg + "!important;" +
        "color:" + acceptTx + "!important;" +
        "border-color:" + btnBorder(acceptBg, acceptTx) + "!important;" +
        "font-size:13px!important;" +
        "padding:10px 32px!important;" +
        "font-weight:600!important;" +
      "}" +
      ".cb-gdpr-accordion{" +
        "background-color:" + bgColor + ";" +
      "}" +
      ".cb-banner-footer{" +
        "display:flex;" +
        "justify-content:flex-end;" +
        "gap:10px;" +
        "flex-wrap:wrap;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-banner-footer{" +
        "flex:0 0 auto;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-footer{" +
        "flex:0 0 auto;" +
        "box-sizing:border-box;" +
        "height:44px;" +
        "max-height:50px;" +
        "width:calc(100% + 56px);" +
        "margin:20px -28px -28px;" +
        "padding:0 20px;" +
        "display:flex;" +
        "align-items:center;" +
        "justify-content:flex-end;" +
        "gap:8px;" +
        "background:#F7F8FA!important;" +
        "background-color:#F7F8FA!important;" +
        "border-top:1px solid #EFF1F4!important;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-footer a{" +
        "display:inline-flex!important;" +
        "align-items:center;" +
        "gap:7px;" +
        "text-decoration:none!important;" +
        "border-radius:6px;" +
        "padding:4px 6px;" +
        "margin-right:-6px;" +
        "background:transparent!important;" +
        "color:#A2ABBA!important;" +
        "font-weight:500!important;" +
        "transition:opacity .15s ease;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-footer a:hover{opacity:.7;}" +
      "#cb-preferences-banner.cb-banner .cb-brand-credit{" +
        "font-size:11px!important;" +
        "font-weight:500!important;" +
        "letter-spacing:.02em;" +
        "line-height:1;" +
        "white-space:nowrap;" +
        "color:#A2ABBA!important;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-mark{" +
        "display:flex;" +
        "align-items:center;" +
        "opacity:.85;" +
      "}" +
      "#cb-preferences-banner.cb-banner .cb-brand-mark svg{" +
        "display:block;" +
        "height:9.75px;" +
        "width:auto;" +
      "}" +
      "@media(max-width:660px){" +
        "#cb-initial-banner.cb-banner{" +
          "width:100vw!important;" +
          "max-width:100vw!important;" +
          "min-width:0!important;" +
          "left:0!important;" +
          "right:0!important;" +
          "bottom:0!important;" +
          "transform:none!important;" +
          "border-radius:0!important;" +
          "border-left:none!important;" +
          "border-right:none!important;" +
          "border-bottom:none!important;" +
        "}" +
        "#cb-initial-banner.cb-banner .cb-banner-footer{" +
          "flex-direction:column!important;" +
          "align-items:stretch!important;" +
        "}" +
        "#cb-initial-banner.cb-banner .cb-banner-footer button{" +
          "width:100%!important;" +
          "min-width:0!important;" +
          "box-sizing:border-box!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner{" +
          "width:calc(100vw - 32px)!important;" +
          "max-width:calc(100vw - 32px)!important;" +
          "padding:20px!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner .cb-banner-footer{" +
          "flex-direction:column!important;" +
          "align-items:stretch!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner .cb-banner-footer button{" +
          "width:100%!important;" +
          "min-width:0!important;" +
          "box-sizing:border-box!important;" +
        "}" +
        "#cb-preferences-banner.cb-banner .cb-brand-footer{" +
          "width:calc(100% + 40px)!important;" +
          "margin:16px -20px -20px!important;" +
          "padding:0 16px!important;" +
        "}" +
      "}" +
      prefsDesignCss();
  }

  // GDPR preferences popup — design port of Claude Design "Cookie Preferences"
  // (2026-11-05): 560px white modal, header strip, stacked bordered category rows
  // with chevron + cookie-count pill + pill switch, vendor sub-accordions with
  // cookie cards, grey footer with Reject / Save / Accept and a muted "Powered by".
  // Only applies once the client add-on (utils/bannerCookieList.js) has tagged the
  // popup with .cb-cl-design, so the CCPA panel and any page where the add-on did
  // not run keep the previous look. Selector weight (#id.class.class) deliberately
  // outranks the runtime's own !important rules. Colours are the design-system
  // tokens, not the customer's banner colours; the font still inherits from the
  // banner (DM Sans is not loaded — no third-party font request on customer sites).
  // TEST-ONLY (/cdn-test/).
  function prefsDesignCss() {
    var P = '#cb-preferences-banner.cb-banner.cb-cl-design';
    return [
      P + '{width:560px!important;max-width:min(560px,calc(100vw - 32px))!important;max-height:min(760px,calc(100vh - 48px))!important;padding:0!important;border:0!important;border-radius:16px!important;background:#fff!important;color:#111827!important;box-shadow:0 24px 64px rgba(10,9,31,.28)!important;letter-spacing:-0.01em;overflow:hidden!important;}',
      // Header strip (title + intro moved out of the scroll body by the add-on).
      P + ' .cb-cl-hd{flex:0 0 auto;padding:24px 24px 16px;border-bottom:1px solid #EDEDED;}',
      P + ' .cb-cl-hd h3{margin:0 0 8px!important;padding:0 40px 0 0!important;font-size:20px!important;line-height:28px!important;font-weight:700!important;color:#111827!important;text-align:left!important;}',
      P + ' .cb-cl-hd p{margin:0!important;font-size:14px!important;line-height:21px!important;color:#4B5563!important;text-align:left!important;opacity:1!important;}',
      P + ' .cb-cl-hd p a{color:#007AFF!important;}',
      P + ' .cb-banner-body{flex:1 1 auto;min-height:0;margin:0!important;padding:16px 24px!important;overflow-y:auto;scrollbar-width:thin;}',
      // Category rows: one bordered stack, rounded at the ends.
      P + ' .cb-gdpr-accordion{margin:0!important;border:0!important;border-radius:0!important;background:transparent!important;overflow:visible!important;}',
      P + ' .cb-cl-cat{margin:0!important;border:1px solid #E5E5E5!important;background:#fff;}',
      P + ' .cb-cl-cat+.cb-cl-cat{border-top:0!important;}',
      P + ' .cb-cl-cat:first-child{border-radius:12px 12px 0 0;}',
      P + ' .cb-cl-cat:last-child{border-radius:0 0 12px 12px;}',
      P + ' .cb-cl-cat-h{display:flex!important;align-items:center!important;gap:12px!important;padding:14px 16px!important;min-height:0!important;cursor:pointer;}',
      P + ' .cb-cl-ctl{margin-left:auto;display:flex;align-items:center;flex-shrink:0;}',
      // Chevron: the runtime toggles the button text between + and −; we hide the
      // text and draw a CSS chevron that rotates on aria-expanded.
      P + ' button.cb-cl-chev,' + P + ' span.cb-cl-chev{position:relative;display:flex!important;align-items:center!important;justify-content:center!important;width:24px!important;height:24px!important;min-width:0!important;margin:0!important;padding:0!important;border:0!important;border-radius:6px!important;background:#F1F5F9!important;color:#111827!important;font-size:0!important;line-height:0!important;flex-shrink:0;cursor:pointer;transition:transform .2s;}',
      P + ' .cb-cl-chev::before{content:"";display:block;width:6px;height:6px;margin-top:-3px;border-right:1.6px solid #111827;border-bottom:1.6px solid #111827;transform:rotate(45deg);}',
      P + ' .cb-cl-chev[aria-expanded="true"],' + P + ' .cb-cl-open>.cb-cl-ven-h .cb-cl-chev{transform:rotate(180deg);}',
      P + ' .cb-gdpr-cat-label{flex:0 1 auto!important;min-width:0;font-size:15px!important;font-weight:600!important;line-height:22px!important;color:#111827!important;}',
      P + ' .cb-cl-cnt{flex-shrink:0;font-size:12px;line-height:18px;font-weight:500;color:#4B5563;background:#F6F6F6;border-radius:99px;padding:2px 8px;white-space:nowrap;}',
      P + ' .cb-cl-always{font-size:12px!important;line-height:16px!important;font-weight:600!important;color:#118A41!important;background:rgba(46,192,79,.1)!important;border-radius:99px;padding:4px 10px;white-space:nowrap;}',
      // Switch (40x24, blue when on).
      P + ' .cb-pref-toggle-track{width:40px!important;min-width:40px!important;height:24px!important;border-radius:99px!important;background:#D9D9D9!important;transition:background .15s!important;}',
      P + ' .cb-pref-toggle-track[aria-checked="true"]{background:#007AFF!important;}',
      P + ' .cb-pref-toggle-track::after{top:3px!important;left:3px!important;width:18px!important;height:18px!important;box-shadow:0 1px 2px rgba(0,0,0,.2)!important;transition:left .15s ease!important;}',
      P + ' .cb-pref-toggle-track[aria-checked="true"]::after{left:19px!important;}',
      P + ' .cb-pref-toggle-track:focus-visible,' + P + ' .cb-cl-chev:focus-visible,' + P + ' .cb-cl-ven-h:focus-visible,' + P + ' .cb-banner-footer button:focus-visible,' + P + ' #cb-close-prefs-btn:focus-visible{outline:2px solid #007AFF!important;outline-offset:2px;}',
      // Expanded panel: description + vendor list.
      P + ' .cb-gdpr-cat-desc{color:#4B5563!important;}',
      P + ' .cb-cl-cat-b{padding:0 16px 16px 52px!important;}',
      P + ' .cb-cl-cat-d{margin:0!important;width:auto!important;font-size:13px!important;line-height:20px!important;color:#4B5563!important;text-align:left!important;opacity:1!important;}',
      P + ' .cb-cl-vens{display:flex;flex-direction:column;margin-top:12px;border:1px solid #EDEDED;border-radius:10px;overflow:hidden;}',
      P + ' .cb-cl-ven+.cb-cl-ven{border-top:1px solid #EDEDED;}',
      P + ' .cb-cl-ven-h{display:flex;align-items:flex-start;gap:10px;padding:12px;text-align:left;cursor:pointer;}',
      P + ' .cb-cl-ven-h:hover{background:#F9F9FA;}',
      P + ' span.cb-cl-chev-s{width:18px!important;height:18px!important;background:none!important;}',
      P + ' .cb-cl-ven-n{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:14px;line-height:20px;font-weight:700;color:#111827;}',
      P + ' .cb-cl-ven-p{align-self:flex-start;font-size:13px!important;line-height:18px;font-weight:500;color:#007AFF!important;text-decoration:underline!important;text-underline-offset:2px;}',
      P + ' .cb-cl-ven-p:hover{color:#0777E6!important;}',
      P + ' .cb-cl-ven-b{display:none;padding:0 12px 12px;flex-direction:column;gap:8px;}',
      P + ' .cb-cl-open>.cb-cl-ven-b{display:flex;}',
      P + ' .cb-cl-ck{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 12px;margin:0;padding:10px 12px;background:#F9F9FA;border-radius:8px;font-size:12px;line-height:18px;}',
      P + ' .cb-cl-ck dt{margin:0;font-weight:600;color:#111827;}',
      P + ' .cb-cl-ck dd{margin:0;color:#111827;word-break:break-word;}',
      P + ' .cb-cl-ck code{font-family:ui-monospace,Menlo,monospace!important;font-size:12px;font-weight:600;background:none;padding:0;}',
      // Footer: three equal buttons on a grey strip, then the brand line.
      P + ' .cb-banner-footer{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important;flex:0 0 auto!important;width:100%!important;margin:0!important;padding:16px 24px 0!important;border-top:1px solid #EDEDED!important;background:#F9F9FA!important;}',
      P + '.cb-cl-nobrand .cb-banner-footer{padding-bottom:16px!important;}',
      P + ' .cb-banner-footer button{width:auto!important;min-width:0!important;height:44px!important;margin:0!important;padding:0 12px!important;border:1px solid #D9D9D9!important;border-radius:10px!important;background:transparent!important;color:#111827!important;font-size:14px!important;font-weight:600!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;transition:background .15s,opacity .15s;}',
      P + ' .cb-banner-footer button:hover{background:#F1F5F9!important;opacity:1!important;}',
      P + ' .cb-banner-footer button#cb-prefs-accept-btn{background:#007AFF!important;border-color:#007AFF!important;color:#fff!important;}',
      P + ' .cb-banner-footer button#cb-prefs-accept-btn:hover{background:#0777E6!important;border-color:#0777E6!important;}',
      P + ' .cb-brand-footer{height:auto!important;max-height:none!important;width:100%!important;margin:0!important;padding:8px 24px 12px!important;justify-content:flex-end!important;gap:6px!important;background:#F9F9FA!important;border-top:0!important;}',
      P + ' .cb-brand-footer a{margin:0!important;padding:0!important;gap:6px!important;}',
      P + ' .cb-brand-credit{font-size:12px!important;font-weight:400!important;letter-spacing:0!important;color:#848199!important;}',
      P + ' .cb-brand-mark{opacity:.45!important;filter:grayscale(1);}',
      P + ' .cb-brand-mark svg{height:14px!important;}',
      // Close (×): the runtime sets the glyph inline; hide it and draw a 16px X.
      P + ' #cb-close-prefs-btn{top:20px!important;right:20px!important;width:32px!important;height:32px!important;border-radius:8px!important;background:transparent!important;color:#4B5563!important;opacity:1!important;font-size:0!important;line-height:0!important;}',
      P + ' #cb-close-prefs-btn:hover{background:#F1F5F9!important;color:#111827!important;}',
      P + ' #cb-close-prefs-btn::before,' + P + ' #cb-close-prefs-btn::after{content:"";position:absolute;left:50%;top:50%;width:14px;height:2px;border-radius:1px;background:currentColor;transform:translate(-50%,-50%) rotate(45deg);}',
      P + ' #cb-close-prefs-btn::after{transform:translate(-50%,-50%) rotate(-45deg);}',
      '@media(max-width:660px){' +
        P + '{width:calc(100vw - 32px)!important;padding:0!important;}' +
        P + ' .cb-banner-footer{display:grid!important;}' +
        P + ' .cb-brand-footer{width:100%!important;margin:0!important;padding:8px 24px 12px!important;}' +
      '}',
      '@media(max-width:480px){' +
        P + ' .cb-banner-footer{grid-template-columns:1fr!important;}' +
        P + ' .cb-cl-cat-b{padding-left:16px!important;}' +
        P + ' .cb-cl-hd{padding:20px 20px 14px;}' +
        P + ' .cb-banner-body{padding:12px 16px!important;}' +
      '}',
    ].join('');
  }

  function jsonForInlineScript(value) {
    try {
      return JSON.stringify(value).replace(/</g, '\\u003c');
    } catch (e) {
      console.warn('[CDN] jsonForInlineScript failed, falling back to null', e);
      return 'null';
    }
  }

  let storedTranslations = null;
  if (customization?.translations) {
    try {
      storedTranslations =
        typeof customization.translations === 'string'
          ? JSON.parse(customization.translations)
          : customization.translations;
    } catch (e) {
      console.warn('[CDN] BannerCustomization.translations is invalid JSON; using defaults', e);
      storedTranslations = null;
    }
  }
  // `|| {}`: with no stored translations, mergeTranslations returns the shared
  // DEFAULT_TRANSLATIONS module object itself, and everything below mutates it — so one
  // request's edits (or the Quebec `fr` set) would carry into later requests on this
  // isolate. An object argument always yields fresh copies.
  const translationsForScript = mergeTranslations(storedTranslations || {});

  if (translationsForScript && translationsForScript.en) {
    const _enT = translationsForScript.en;
    const _lc = _enT.languageSelected || 'en';
    const _lb = SECTION_LABELS[_lc] || SECTION_LABELS['en'];
    _enT.essential = (_lb && _lb.essential) ? _lb.essential : 'Strictly Necessary';
    _enT.strictlyNecessary = '';
  }

  // Generic-French fixes (gap K), TEST-ONLY via lawFixes. "Strictement Nécessaires" is 23
  // chars and the runtime cuts category names to 20; the shipped title and preference
  // intro are fixed by exact match (data/quebecFrench.js FRENCH_DEFAULT_FIXES).
  if (lawFixes && translationsForScript && translationsForScript.en && translationsForScript.en.languageSelected === 'fr') {
    const _frT = translationsForScript.en;
    _frT.essential = 'Nécessaires';
    for (const key of Object.keys(FRENCH_DEFAULT_FIXES)) {
      const fixed = FRENCH_DEFAULT_FIXES[key][String(_frT[key] || '').trim()];
      if (fixed) _frT[key] = fixed;
    }
  }

  // The Webflow Designer App mis-maps the CCPA opt-out panel body into ccpaDescription
  // (buildCustomizationPayload.js: `ccpaDescription: ccpaContent.optOutBody`), so the
  // initial CCPA banner renders the opt-out paragraph, truncated mid-word at 320 chars.
  // That app exposes no editor field for the CCPA notice, so an identical pair is the
  // mis-map's signature. Equality ALONE is not enough though: 11 prod rows (framer /
  // webapp) have the pair equal to the *notice* text instead, where ccpaDescription is
  // already correct and it is the opt-out intro that was overwritten - blanking those
  // would break working banners. The two populations separate cleanly by length: every
  // shipped notice default is ~160 chars, every opt-out intro 481-595, with nothing in
  // between. Gate on the runtime's own 320 cap, above which a notice would be truncated
  // anyway. Replace it with the CCPA notice default in the site's language - the same
  // text the Designer App previews for the CCPA banner (bannerContent.js ccpaLocalization).
  // Do NOT blank it: the runtime's W("ccpaDescription") || W("description") fallback
  // then renders the GDPR message, whose defaults say 'By clicking "Accept All"' on a
  // banner that has no Accept button (Monitaur, 2026-09-17).
  const CCPA_NOTICE_DEFAULTS = {
    en: 'We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.',
    nl: 'We gebruiken cookies om u de best mogelijke ervaring te bieden. Ze stellen ons ook in staat om gebruikersgedrag te analyseren om de website voortdurend voor u te verbeteren.',
    fr: "Nous utilisons des cookies pour vous offrir la meilleure expérience possible. Ils nous permettent également d'analyser le comportement des utilisateurs afin d'améliorer constamment le site web pour vous.",
    de: 'Wir verwenden Cookies, um Ihnen das bestmögliche Erlebnis zu bieten. Sie ermöglichen es uns außerdem, das Nutzerverhalten zu analysieren, um die Website kontinuierlich für Sie zu verbessern.',
    it: 'Utilizziamo i cookie per offrirti la migliore esperienza possibile. Ci permettono inoltre di analizzare il comportamento degli utenti per migliorare costantemente il sito web per te.',
    pl: 'Używamy plików cookie, aby zapewnić Ci najlepsze możliwe doświadczenie. Pozwalają nam one również analizować zachowanie użytkowników, aby stale ulepszać stronę dla Ciebie.',
    pt: 'Usamos cookies para lhe proporcionar a melhor experiência possível. Também nos permitem analisar o comportamento dos utilizadores para melhorar constantemente o site para si.',
    es: 'Utilizamos cookies para brindarle la mejor experiencia posible. También nos permiten analizar el comportamiento de los usuarios para mejorar constantemente el sitio web para usted.',
    sv: 'Vi använder cookies för att ge dig bästa möjliga upplevelse. De gör det också möjligt för oss att analysera användarbeteende för att ständigt förbättra webbplatsen för dig.',
  };
  if (translationsForScript && translationsForScript.en) {
    const _ccpaT = translationsForScript.en;
    if (
      _ccpaT.ccpaDescription &&
      _ccpaT.ccpaDescription === _ccpaT.ccpaOptOutPreferenceIntro &&
      String(_ccpaT.ccpaDescription).length > 320
    ) {
      _ccpaT.ccpaDescription = CCPA_NOTICE_DEFAULTS[_ccpaT.languageSelected] || CCPA_NOTICE_DEFAULTS.en;
    }
  }

  // The GDPR message defaults (webapp translations.ts `description`, Designer/Framer
  // bannerContent.js `message`) say 'By clicking "Accept"' / '"Accept All"'. They reach
  // the CCPA banner - which has no Accept button - two ways: saved verbatim into
  // ccpaDescription (Webflow Designer saves), or ccpaDescription left blank so the
  // runtime's W("ccpaDescription") || W("description") fallback renders it (Framer).
  // Match on each language's opening clause, which both the "Accept" and "Accept All"
  // variants share, so customer-written text is never touched. Prod on 2026-09-17:
  // adhd-evidence.com, www.kesem.org, thesignalforgelabs.com, one framer.app site.
  if (translationsForScript && translationsForScript.en) {
    const _ccpaT = translationsForScript.en;
    const GDPR_ACCEPT_DEFAULT_PREFIXES = [
      'We use cookies to enhance your browsing experience, serve personalised ads or content',
      'We gebruiken cookies om uw browse-ervaring te verbeteren',
      'Nous utilisons des cookies pour améliorer votre expérience de navigation',
      'Wir verwenden Cookies, um Ihr Surferlebnis zu verbessern',
      'Utilizziamo i cookie per migliorare la tua esperienza di navigazione',
      'Używamy plików cookie, aby ulepszyć Twoje doświadczenie przeglądania',
      'Utilizamos cookies para melhorar a sua experiência de navegação',
      'Usamos cookies para mejorar su experiencia de navegación',
      'Vi använder cookies för att förbättra din surfupplevelse',
    ];
    const _shown = String((_ccpaT.ccpaDescription && String(_ccpaT.ccpaDescription).trim()) || _ccpaT.description || '').trim();
    if (_shown && GDPR_ACCEPT_DEFAULT_PREFIXES.some((p) => _shown.indexOf(p) === 0)) {
      _ccpaT.ccpaDescription = CCPA_NOTICE_DEFAULTS[_ccpaT.languageSelected] || CCPA_NOTICE_DEFAULTS.en;
    }
  }

  // CCPA opt-out link title (added 2026-10-08). CPRA requires the exact title "Do Not
  // Sell or Share My Personal Information" (Civ. Code §1798.135(a)(1)); every app shipped
  // "Do Not Share…" (and its translations), and that text is saved in each site's
  // translations, so changing the defaults alone fixes no existing banner. Swap only the
  // known shipped defaults — exact match on the label, and the same phrase where the
  // opt-out intro names the checkbox — so customer-written text is never touched.
  // No new phrase contains its old one, so this is safe to run on already-fixed text.
  const CCPA_LINK_TITLE_FIXES = {
    'Do Not Share My Personal Information': 'Do Not Sell or Share My Personal Information',
    'Do Not Sell My Personal Information': 'Do Not Sell or Share My Personal Information', // pre-CPRA
    'No compartir mi información personal': 'No vender ni compartir mi información personal',
    'Ne pas partager mes informations personnelles': 'Ne pas vendre ni partager mes informations personnelles',
    'Meine personenbezogenen Daten nicht weitergeben': 'Meine personenbezogenen Daten nicht verkaufen oder weitergeben',
    'Non condividere le mie informazioni personali': 'Non vendere né condividere le mie informazioni personali',
    'Não partilhar as minhas informações pessoais': 'Não vender nem partilhar as minhas informações pessoais',
    'Não compartilhar minhas informações pessoais': 'Não vender nem compartilhar minhas informações pessoais',
    'Mijn persoonlijke gegevens niet delen': 'Mijn persoonlijke gegevens niet verkopen of delen',
    'Dela inte mina personuppgifter': 'Sälj eller dela inte mina personuppgifter',
    'Nie udostępniaj moich danych osobowych': 'Nie sprzedawaj ani nie udostępniaj moich danych osobowych',
  };
  if (lawFixes && translationsForScript && translationsForScript.en) {
    const _dnsT = translationsForScript.en;
    const _label = String(_dnsT.doNotSell || '').trim();
    if (CCPA_LINK_TITLE_FIXES[_label]) _dnsT.doNotSell = CCPA_LINK_TITLE_FIXES[_label];
    if (typeof _dnsT.ccpaOptOutPreferenceIntro === 'string') {
      let _intro = _dnsT.ccpaOptOutPreferenceIntro;
      for (const _old of Object.keys(CCPA_LINK_TITLE_FIXES)) {
        if (_intro.indexOf(_old) !== -1) _intro = _intro.split(_old).join(CCPA_LINK_TITLE_FIXES[_old]);
      }
      _dnsT.ccpaOptOutPreferenceIntro = _intro;
    }
  }

  // Label for the visitor's consent ID line in the preference panels (runtime cbIdLine,
  // TEST-ONLY via lawFixes). The ID is what a visitor quotes when asking for their
  // records to be found or deleted. Not written to saved translations; site text wins.
  const CONSENT_ID_LABELS = {
    en: 'Consent ID', es: 'ID de consentimiento', fr: 'ID de consentement', de: 'Einwilligungs-ID',
    it: 'ID del consenso', pt: 'ID de consentimento', nl: 'Toestemmings-ID', sv: 'Samtyckes-ID', pl: 'ID zgody',
  };
  // Same ID shown as "Visitor ID" until the visitor makes a choice (created on first load,
  // CookieYes parity), then as "Consent ID" once a consent record exists.
  const VISITOR_ID_LABELS = {
    en: 'Visitor ID', es: 'ID de visitante', fr: 'ID du visiteur', de: 'Besucher-ID',
    it: 'ID visitatore', pt: 'ID do visitante', nl: 'Bezoekers-ID', sv: 'Besöks-ID', pl: 'ID odwiedzającego',
  };
  if (lawFixes && translationsForScript && translationsForScript.en) {
    const _lang = translationsForScript.en.languageSelected || 'en';
    if (!translationsForScript.en.consentIdLabel) translationsForScript.en.consentIdLabel = CONSENT_ID_LABELS[_lang] || CONSENT_ID_LABELS.en;
    if (!translationsForScript.en.visitorIdLabel) translationsForScript.en.visitorIdLabel = VISITOR_ID_LABELS[_lang] || VISITOR_ID_LABELS.en;
  }

  function resolveWorkerFloatingLogoUrl() {
    try {
      return new URL(request.url).origin + '/embed/floating-logo.svg';
    } catch (e) {
      return '';
    }
  }

  function resolveFloatingLogoUrl() {
    var webapp = String(env.WEBAPP_PUBLIC_URL || '')
      .trim()
      .replace(/\/$/, '');
    if (webapp) {
      return webapp + '/asset/logo.webp';
    }
    return resolveWorkerFloatingLogoUrl();
  }

  function normalizePreferencePositionForEmbed(raw) {
    if (raw === 'left') return 'left';
    return 'center';
  }

  // Mirrors serveKind's IAB decision further down (wantsIab && iabAllowed). When the IAB
  // bundle is served, Microsoft UET reads consent from the TCF string instead, and
  // Microsoft forbids sending UET Consent Mode and TCF together — so UET Consent Mode is
  // switched off in the payload for those sites. Keep in step with serveKind.
  const iabBundleServed = String(resolvedSite.banner_type || '').toLowerCase() === 'iab' &&
    (effectivePlanId === 'growth' || effectivePlanId === 'essential');

  // Quebec visitors get the banner in French (gap K), TEST-ONLY via lawFixes. Charter of
  // the French Language: French must be at least as available as any other language, so
  // French is shown whatever language the site published — unless it already published
  // French, in which case the customer's own text stands. Adds a `fr` set and points the
  // runtime's language (R(): customization.language) at it; W() falls back to `en` per
  // key, so every key the runtime reads is in QUEBEC_FRENCH. Auto-detect is switched off
  // so an English-language browser in Quebec still gets French. Not for IAB banners
  // (their text comes from the GVL bundle, not TRANSLATIONS).
  // SWITCHED OFF 2026-10-10 (product decision, pending manager): Quebec and Brazil visitors
  // see the customer's selected language (English by default). Set to true to restore.
  const QUEBEC_FRENCH_OVERRIDE = false;
  let quebecFrench = false;
  if (
    QUEBEC_FRENCH_OVERRIDE &&
    lawFixes && !iabBundleServed && countryLaw && countryLaw.law === 'LAW25' &&
    translationsForScript && translationsForScript.en &&
    translationsForScript.en.languageSelected !== 'fr'
  ) {
    const _frSet = { ...QUEBEC_FRENCH };
    for (const key of TEXT_SET_SWITCHES) {
      if (translationsForScript.en[key] != null) _frSet[key] = translationsForScript.en[key];
    }
    translationsForScript.fr = _frSet;
    quebecFrench = true;
  }

  // Regional language (2026-10-14): when the customer ticked Quebec / Brazil under
  // "Regional requirements", visitors there see the banner in French / Brazilian
  // Portuguese, the language their law expects. Unticked, and everywhere else, the
  // customer's selected language stands. Skipped when the site already publishes that
  // language. Same mechanism as the Quebec block above: an extra text set + the
  // runtime's language pointed at it (W() falls back to `en` per key).
  let langOverride = quebecFrench ? 'fr' : null;
  if (
    !langOverride && regionalActive &&
    !iabBundleServed && translationsForScript && translationsForScript.en
  ) {
    const _sel = String(translationsForScript.en.languageSelected || 'en');
    let _set = null;
    if (country === 'CA' && String(regionCode || '').toUpperCase() === 'QC' &&
        regionalLanguages.quebec && _sel !== 'fr') {
      langOverride = 'fr';
      _set = QUEBEC_FRENCH;
    } else if (country === 'BR' && regionalLanguages.brazil && _sel !== 'pt' && _sel !== 'pt-BR') {
      langOverride = 'pt-BR';
      _set = PT_BR_TRANSLATIONS;
    }
    if (_set) {
      const _geoSet = { ..._set };
      for (const key of TEXT_SET_SWITCHES) {
        if (translationsForScript.en[key] != null) _geoSet[key] = translationsForScript.en[key];
      }
      translationsForScript[langOverride] = _geoSet;
    }
  }

  // Regional language for IAB banners (2026-10-16). The IAB banner has no TRANSLATIONS;
  // it reads customization.resolvedLanguage (IabCode.js CB_LANG, Tcfmanager.js
  // detectLanguage, gvlBakeLang below) and ships its own string table + GVL in 9
  // two-letter languages. So the override is just that field: 'fr' for Quebec, 'pt'
  // for Brazil ('pt' is the only Portuguese the TCF core accepts; the worker serves the
  // IAB's European Portuguese GVL text for it). Same gates as regionalActive, except it
  // applies only when the IAB bundle is actually served.
  let iabLangOverride = null;
  if (lawFixes && regionalLanguages && planAllowsPaidRegions && iabBundleServed) {
    const _iabSel = String((enTrans && enTrans.languageSelected) || normalizeLangCode(customization.language) || 'en');
    if (country === 'CA' && String(regionCode || '').toUpperCase() === 'QC' &&
        regionalLanguages.quebec && _iabSel !== 'fr') {
      iabLangOverride = 'fr';
    } else if (country === 'BR' && regionalLanguages.brazil && _iabSel !== 'pt' && _iabSel !== 'pt-BR') {
      iabLangOverride = 'pt';
    }
  }

  // Page languages (CookieYes-style, 2026-11-18): the banner follows the page's
  // <html lang> (or window.CONSENTBIT_LANGUAGE) for the languages the owner enabled in
  // the webapp (translations.config.pageLanguages). Essential/Growth, behind
  // PAGE_LANGUAGES = "1". Not for IAB (official translations), and not when a regional
  // override already picked the language (Quebec/Brazil is a legal requirement). The
  // switch happens in the browser, so the notice-version proof below still records the
  // published language. See services/pageLanguages.js.
  let pageLanguageSets = {};
  let pageLangStatus = 'off';
  if (env.PAGE_LANGUAGES === '1' && translationsForScript && translationsForScript.en) {
    const _pl = readPageLanguages(storedTranslations && storedTranslations.config);
    if (_pl.languages.length) {
      if (!PAGE_LANGUAGE_PLANS.includes(String(effectivePlanId || 'free').toLowerCase())) pageLangStatus = 'plan';
      else if (iabBundleServed) pageLangStatus = 'iab';
      else if (langOverride) pageLangStatus = 'regional';
      else {
        pageLanguageSets = buildPageLanguageSets(_pl, translationsForScript.en, TEXT_SET_SWITCHES);
        pageLangStatus = Object.keys(pageLanguageSets).join(',') || 'none';
      }
    }
  }

  // Proof of WHAT the visitor was shown (gap D, TEST-ONLY via lawFixes). GDPR art. 7(1) /
  // LGPD art. 8 §2 require the site to show what a visitor agreed to, so each consent row
  // carries two fingerprints of exactly what this response serves:
  //   noticeVersion — banner type + every banner text + privacy-policy link
  //   policyVersion — the privacy-policy link alone (we cannot see the page behind it)
  // Each distinct version's full text is stored once in NoticeVersion, so a fingerprint
  // on a consent row can always be turned back into the words shown. IAB banners are
  // skipped: their text comes from the GVL, not translationsForScript.
  let noticeVersion = null;
  let policyVersion = null;
  if (lawFixes && !iabBundleServed && translationsForScript && translationsForScript.en) {
    try {
      const policyUrl = String((customization && customization.privacyPolicyUrl) || '').trim();
      const noticeContent = JSON.stringify({
        bannerType: effectiveBannerType,
        privacyPolicyUrl: policyUrl || null,
        // Quebec visitors are shown the French set, so that is what the proof records.
        text: langOverride ? translationsForScript[langOverride] : translationsForScript.en,
      });
      noticeVersion = await shortHash(noticeContent);
      policyVersion = policyUrl ? await shortHash(policyUrl) : null;
      await recordNoticeVersions(env.CONSENT_WEBAPP, resolvedSite.id, [
        { id: noticeVersion, kind: 'notice', bannerType: effectiveBannerType, language: langOverride || (translationsForScript.en.languageSelected || null), content: noticeContent },
        ...(policyVersion ? [{ id: policyVersion, kind: 'policy', bannerType: null, language: null, content: policyUrl }] : []),
      ]);
    } catch (e) {
      console.warn('[CDN] notice version failed (banner served without it):', e?.message);
    }
  }

  // No location law matched (US visitor on a GDPR site, CH, JP, IN, KR, NZ…) but the
  // visitor IS getting the GDPR opt-in banner: record the standard actually applied,
  // GDPR, instead of an empty law. resolved:false keeps law_resolved=0 so these rows
  // stay distinguishable from a location-matched GDPR (EU/EEA) row.
  const recordedCountryLaw = countryLaw ||
    (!usLaw && String(effectiveBannerType).toLowerCase() === 'gdpr'
      ? { law: 'GDPR', model: 'optin', resolved: false }
      : null);

  // Vendor + cookie list for the preferences popup (utils/bannerCookieList.js):
  // the Scan tab's cookies grouped by category and vendor. Additive - null on any
  // failure, and the runtime add-on simply renders no vendor rows then.
  const cookieList = await buildBannerCookieList(env, resolvedSite.id, resolvedSite.domain).catch((err) => {
    console.error('[CDN] cookie list failed:', err?.message);
    return null;
  });
  const cookieListSig = cookieList ? await cookieListSignature(cookieList) : '';

  const siteConfigPayload = {
    id: resolvedSite.id,
    bannerType: effectiveBannerType,
    cookieList,
    // Which US statute applies to THIS request (null outside the US opt-out path).
    // Additive: bannerType is untouched, so every existing runtime branch behaves
    // exactly as before for sites/visitors that ignore this field.
    usLaw,
    // Non-US jurisdiction profile (COUNTRY_LAWS / REGION_LAWS). Null for US/EU
    // visitors. Recorded on the consent row only; never changes what is served.
    countryLaw: lawFixes ? recordedCountryLaw : null,
    // Quebec visitor on a CCPA-only site: CCPA banner, everything off until they choose.
    quebecDefaultOff,
    // Turns on the runtime half of the LAW_FIXES switch (law fields on the consent POST,
    // 12-month CCPA opt-out). Absent/false = previous behaviour.
    lawFixes,
    // What this response shows, sent back on the consent POST (gap D). Null when off.
    noticeVersion,
    policyVersion,
    bannerEnabled,
    apiBase,
    gaId: GA_ID,
    clarityCmpId: resolvedSite.clarityCmpId || 165,
    clarityConsentMode: resolvedSite.clarityConsentMode !== 0 && resolvedSite.clarityConsentMode !== false,
    // Microsoft UET Consent Mode (ad_storage). Off when the IAB bundle is served — see iabBundleServed.
    uetConsentMode: !iabBundleServed,
    gtmConsentMode: resolvedSite.gtmConsentMode !== 0 && resolvedSite.gtmConsentMode !== false,
    // Google Consent Mode Basic / Off (see gcmMode above). Absent = Advanced, so the
    // config of every Advanced site is unchanged.
    ...(gcmMode !== 'advanced' ? { gcmMode } : {}),
    platform: resolvedSite.platform || null,
    // customStyles is only built when the site has a BannerCustomization row; the
    // preferences-popup design CSS must reach the page either way (it is already
    // folded into customStyles when that row exists).
    styles: customStyles || prefsDesignCss(),
    customization: customization
      ? {
          position: (function () {
            var r = customization.position || 'bottom-left';
            var n = String(r).trim().toLowerCase().replace(/_/g, '-');
            if (n === 'bottom-right' || n === 'right') return 'bottom-right';
            if (n === 'bottom-center' || n === 'center') return 'bottom-center';
            if (n === 'bottom') return 'bottom';
            return 'bottom-left';
          })(),
          bannerLayoutVisual: bannerLayoutVisualForConfig,
          privacyPolicyUrl: customization.privacyPolicyUrl,
          footerLink: customization.footerLink === 1,
          animationEnabled:
            customization.animationEnabled == null ||
            customization.animationEnabled === 1 ||
            Number(customization.animationEnabled) === 1,
          preferencePosition: normalizePreferencePositionForEmbed(
            customization.preferencePosition
          ),
          centerAnimationDirection: customization.centerAnimationDirection || 'fade',
          language: langOverride || normalizeLangCode(customization.language),
          // Effective published language, for consumers that have no TRANSLATIONS
          // object to read it from — the IAB banner, which is served without
          // translationsVar. translations.en carries the text in whichever language
          // was published and languageSelected records which one, so it wins over
          // the `language` column, which can be stale or unset. Same expression as
          // _langCode above; kept as its own field so the GDPR/CCPA loader's
          // existing `language` semantics are untouched.
          resolvedLanguage: iabLangOverride ||
            (enTrans && enTrans.languageSelected) || normalizeLangCode(customization.language),
          autoDetectLanguage: (langOverride || iabLangOverride) ? false : customization.autoDetectLanguage === 1,
          cookieExpirationDays:
            customization.cookieExpirationDays != null ? customization.cookieExpirationDays : 30,
          backgroundColor: customization.backgroundColor || '#ffffff',
          textColor: customization.textColor || '#334155',
          headingColor: customization.headingColor || '#0f172a',
          acceptButtonBg: customization.acceptButtonBg || '#007aff',
          acceptButtonText: customization.acceptButtonText || '#ffffff',
          rejectButtonBg: customization.rejectButtonBg || customization.acceptButtonBg || '#007aff',
          rejectButtonText: customization.rejectButtonText || customization.acceptButtonText || '#ffffff',
          customiseButtonBg: customization.customiseButtonBg || '#ffffff',
          customiseButtonText: customization.customiseButtonText || '#0284c7',
          saveButtonBg: customization.saveButtonBg || '#ffffff',
          saveButtonText: customization.saveButtonText || '#0284c7',
          bannerEntranceAnimation: (() => {
            const raw = (configTrans.bannerEntranceAnimation != null && configTrans.bannerEntranceAnimation !== '')
              ? configTrans.bannerEntranceAnimation
              : (customization.centerAnimationDirection != null && customization.centerAnimationDirection !== '')
                ? customization.centerAnimationDirection
                : (enTrans && enTrans.bannerEntranceAnimation) || 'fade-in';
            const v = String(raw || 'fade-in');
            return v === 'zoom' ? 'zoom-in' : v === 'fade' ? 'fade-in' : v;
          })(),
          bannerFontWeight: '',
          bannerBorderRadius: customization.bannerBorderRadius || '1.25rem',
          buttonBorderRadius: customization.buttonBorderRadius || '0.3125rem',
          textAlign: (configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : enTrans.bannerTextAlign) || 'left',
          showBannerLogo: customization.showBannerLogo != null ? customization.showBannerLogo !== 0 && customization.showBannerLogo !== false : true,
          bannerLogoPosition: customization.bannerLogoPosition || 'left',
          font: String((configTrans.bannerFontFamily != null ? configTrans.bannerFontFamily : (enTrans && enTrans.bannerFontFamily)) || customization.font || 'Inter'),
          fontWeight: String((configTrans.bannerFontWeight != null ? configTrans.bannerFontWeight : (enTrans && enTrans.bannerFontWeight)) || customization.fontWeight || 'Regular'),
          fontSize: Number((configTrans.bannerFontSize != null ? configTrans.bannerFontSize : (enTrans && enTrans.bannerFontSize)) || customization.fontSize || 14),
          textAlignment: String((configTrans.bannerTextAlign != null ? configTrans.bannerTextAlign : (enTrans && enTrans.bannerTextAlign)) || customization.textAlignment || 'left'),
          bannerBg2: String((configTrans.bannerBg2 != null ? configTrans.bannerBg2 : (enTrans && enTrans.bannerBg2)) || customization.bannerBg2 || '#798EFF'),
          stopScroll: customization.stopScroll === 1 || customization.stopScroll === true,
          // "Powered by ConsentBit" footer removal — Growth-only. Re-checked against the
          // live plan here (not just at save time) so a downgrade brings the footer back
          // without needing the customer to re-save the banner.
          hideBranding:
            effectivePlanId === 'growth' &&
            (customization.hideBranding === 1 || customization.hideBranding === true),
        }
      : null,
    floatingLogoUrl: resolveFloatingLogoUrl(),
    floatingLogoFallbackUrl: resolveWorkerFloatingLogoUrl(),
    scriptBlockProviders: SCRIPT_BLOCK_PROVIDERS,
    customCookieRules: customCookieRules,
    pendingScan: resolvedSite.pendingScan === 1,
    registeredDomain: authorizedHost || resolvedSite.domain
      ? String(resolvedSite.domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()
      : null,
  };

  const inlineConfig = `
    window.__CONSENT_SITE__ = ${jsonForInlineScript(siteConfigPayload)};
  `;

  const translationsVar =
    'var TRANSLATIONS = ' + jsonForInlineScript(translationsForScript) + ';' +
    pageLanguageRuntime(pageLanguageSets, jsonForInlineScript);

  const loader = `
${inlineConfig}
!function(){if(!window.__cbBannerInit){window.__cbBannerInit=!0;var e=window.__CONSENT_SITE__||{};var t=!0;!function(){var n=e.registeredDomain;if(n)try{var r=window.location.hostname.replace(/^www./,"").toLowerCase();if(r!==n&&"webflow"!==e.platform&&!r.endsWith(".webflow.io")){window.__CONSENT_SITE__=null;t=!1}}catch(e){}}();if(t){var n=e.floatingLogoUrl||"";var r=e.floatingLogoFallbackUrl||"";var a=e.id||null;var i=e.bannerType||"gdpr";var cbLaw=e.usLaw||null;var cbCountryLaw=e.countryLaw||null;var cbLawFix=!0===e.lawFixes;var cbQcOff=!0===e.quebecDefaultOff;var cbNoticeV=e.noticeVersion||null,cbPolicyV=e.policyVersion||null;var cbIdCk=function(){try{var m=document.cookie.match(/(?:^|; *)consentbit-consentid=([0-9a-fA-F-]{36})(?:;|$)/);return m?m[1]:null}catch(x){return null}};var cbGetId=function(){var k="cb_consent_id_"+a,v=cbIdCk(),w=window.crypto;if(v)return v;try{v=localStorage.getItem(k)}catch(x){}if(!(v&&v.length===36&&/^[0-9a-f-]+$/i.test(v))){if(w&&w.randomUUID){v=w.randomUUID()}else{v="10000000-1000-4000-8000-100000000000".replace(/[018]/g,function(n){var b=w&&w.getRandomValues?w.getRandomValues(new Uint8Array(1))[0]:Math.floor(256*Math.random());return(+n^b&15>>+n/4).toString(16)})}}try{document.cookie="consentbit-consentid="+v+"; path=/; max-age=31536000; SameSite=Lax"+("https:"===location.protocol?"; Secure":"")}catch(x){}if(cbIdCk()===v)try{localStorage.removeItem(k)}catch(x){}return v};if(cbLawFix&&a)try{cbGetId()}catch(x){}var o=!1!==e.bannerEnabled;var c=e.apiBase;var s=e.gaId||null;var cbGcm=window.__cbGtmInstall?"advanced":e.gcmMode||"advanced";var l=!1!==e.clarityConsentMode;var d=e.clarityCmpId||165;var uetConsentEnabled=!1!==e.uetConsentMode;var p=e.customization||null;var cbHideBrand=!(!p||!p.hideBranding);var b=!0===e.pendingScan;var f=p&&p.bannerLayoutVisual||"box";var m=p?p.privacyPolicyUrl:null;var g=!!p&&p.stopScroll;var u=!p||!1!==p.animationEnabled;var y=p&&p.bannerEntranceAnimation||"fade-in";var v=p&&p.preferencePosition||"center";var h=p&&p.centerAnimationDirection||"fade";var x=p&&p.language||"en";var C=!!p&&!0===p.autoDetectLanguage;${translationsVar}var w=["customise","rejectAll","acceptAll","save","back","doNotSell","saveMyPreferences","confirmChoice","cancel","optOutPreference"];var k=30,_=320,E=20,S=30,O=200;var B=56;var L="consentbit_"+a;var A=void 0!==p&&p&&null!=p.cookieExpirationDays?Math.max(1,Math.min(365,Number(p.cookieExpirationDays)||30)):30;var I=ie();try{if(!(!0!==navigator.globalPrivacyControl||"ccpa"!==i||I&&I.accepted&&(I.gpc||I.ccpa&&I.ccpa.doNotSell))){I={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:!0},gpc:!0};try{localStorage.setItem(L,JSON.stringify(I))}catch(e){}le(I,{status:"rejected",consentMethod:"gpc"})}}catch(e){}var H="consentbit_prefs_"+(a||"");var T="cb_pv_over_limit_"+(a||"");var P=[];var z=!1;var N=null;var j=e.scriptBlockProviders||[];var V=e.customCookieRules||[];var M=[{domain:"facebook.com",category:"marketing"},{domain:"facebook.net",category:"marketing"},{domain:"adroll.com",category:"marketing"},{domain:"doubleclick.net",category:"marketing"},{domain:"googleadservices.com",category:"marketing"},{domain:"bing.com",category:"marketing"},{domain:"bat.bing.com",category:"marketing"},{domain:"twitter.com",category:"marketing"},{domain:"analytics.twitter.com",category:"marketing"},{domain:"t.co",category:"marketing"},{domain:"linkedin.com",category:"marketing"},{domain:"ads.linkedin.com",category:"marketing"},{domain:"pinterest.com",category:"marketing"},{domain:"ct.pinterest.com",category:"marketing"},{domain:"tiktok.com",category:"marketing"},{domain:"analytics.tiktok.com",category:"marketing"},{domain:"hotjar.com",category:"analytics"},{domain:"clarity.ms",category:"analytics"},{domain:"scorecardresearch.com",category:"analytics"},{domain:"outbrain.com",category:"marketing"},{domain:"taboola.com",category:"marketing"},{domain:"criteo.com",category:"marketing"},{domain:"criteo.net",category:"marketing"},{domain:"quantserve.com",category:"analytics"},{domain:"zemanta.com",category:"marketing"}];var D=".cb-banner,.cb-banner *{box-sizing:border-box;}.cb-banner *{font-family:inherit;}#cb-initial-banner.cb-banner{width:440px;min-width:280px;max-width:min(440px,92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;bottom:32px;left:32px;right:auto;padding:16px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:inline-flex;flex-direction:column;align-items:stretch;font-family:inherit;font-size:14px!important;line-height:1.5!important;}#cb-initial-banner.cb-banner .cb-banner-body{flex:0 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner{width:540px;max-width:92vw;max-height:min(85vh,580px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:flex;flex-direction:column;font-family:inherit;font-size:14px!important;line-height:1.5!important;}#cb-preferences-banner.cb-banner .cb-banner-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner.prefs-left{left:32px;right:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-right{right:32px;left:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-center{left:50%;top:50%;transform:translate(-50%,-50%);}.cb-banner-body{overflow-y:auto;overflow-x:hidden;margin-bottom:12px;}.cb-banner h3{margin:0 0 8px;font-size:16px!important;line-height:1.4!important;font-weight:600;color:#0f172a;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}#cb-initial-banner.cb-banner h3{font-size:16px!important;font-weight:600;color:rgba(0,0,0,0.8);padding-right:36px;}#cb-initial-banner.cb-banner .cb-banner-body > p{color:rgba(0,0,0,0.8);}.cb-gdpr-accordion{margin-top:4px;margin-bottom:4px;}.cb-gdpr-cat-label{color:#0f172a;}.cb-gdpr-cat-desc{color:#64748b;}.cb-banner p{margin:0 0 12px;font-size:14px!important;line-height:1.5!important;color:#334155;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}.cb-banner-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;align-items:center;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex:0 0 auto;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}"+(p&&"banner"===p.bannerLayoutVisual?"#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}":"")+".cb-banner button{padding:12px 32px;border-radius:0.375rem;cursor:pointer;font-size:14px;font-weight:600;border:1px solid #e2e8f0;transition:opacity 0.2s;white-space:normal;word-break:break-word;min-width:0;text-align:center;}@media (max-width:660px){#cb-initial-banner.cb-banner{width:100vw!important;max-width:100vw!important;left:0!important;right:0!important;bottom:0!important;transform:none!important;border-radius:0!important;border-left:none!important;border-right:none!important;border-bottom:none!important;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-initial-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}#cb-preferences-banner.cb-banner{width:calc(100vw - 32px)!important;max-width:calc(100vw - 32px)!important;padding:20px!important;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-preferences-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}}@media (max-width:350px){#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{font-size:12px!important;}#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-size:13px!important;}#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,.cb-gdpr-cat-desc{font-size:12px!important;}#cb-initial-banner.cb-banner .cb-banner-footer button,#cb-preferences-banner.cb-banner .cb-banner-footer button{font-size:12px!important;padding:10px 16px!important;}}.cb-banner button:hover:not(.cb-pref-toggle-track){opacity:0.8;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{display:block !important;width:40px !important;min-width:40px !important;height:22px !important;padding:0 !important;margin:0 !important;border:none !important;border-radius:11px !important;background:#d1d5db !important;box-shadow:none !important;flex-shrink:0 !important;position:relative !important;overflow:visible !important;box-sizing:border-box !important;cursor:pointer !important;appearance:none !important;-webkit-appearance:none !important;font-size:0 !important;line-height:0 !important;opacity:1 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{background:#22c55e !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{content:'' !important;position:absolute !important;top:2px !important;left:2px !important;width:18px !important;height:18px !important;border-radius:50% !important;background:#ffffff !important;box-shadow:0 1px 3px rgba(0,0,0,.2) !important;pointer-events:none !important;transition:left .15s ease !important;z-index:2 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{left:20px !important;}.cb-banner button#cb-accept-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-reject-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-preferences-btn,.cb-banner button#cb-ccpa-donotsell-link{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner button#cb-prefs-reject-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner label{display:block;margin-bottom:6px;font-size:11px;}.cb-banner input[type='checkbox']{margin-right:6px;}.cb-banner a{color:#007aff !important;text-decoration:underline !important;font-size:inherit !important;display:inline !important;font-weight:inherit !important;white-space:normal;}@keyframes slideInFromLeft{from{transform:translateX(-100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromRight{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromTop{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes slideInFromBottom{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}@keyframes prefsSlideInFromLeft{from{transform:translate(-120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideInFromRight{from{transform:translate(120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideCenterFromBottom{from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes prefsSlideCenterFromTop{from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes zoomIn{from{transform:scale(0.85);opacity:0;}to{transform:scale(1);opacity:1;}}@keyframes cbInitialCenterSlideFromBottom{from{transform:translate(-50%,100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterSlideFromTop{from{transform:translate(-50%,-100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterZoomIn{from{transform:translateX(-50%) scale(0.85);opacity:0;}to{transform:translateX(-50%) scale(1);opacity:1;}}.cb-banner-animate-initial-center-bottom{animation:cbInitialCenterSlideFromBottom 0.35s ease-out;}.cb-banner-animate-initial-center-top{animation:cbInitialCenterSlideFromTop 0.35s ease-out;}.cb-banner-animate-initial-center-zoom{animation:cbInitialCenterZoomIn 0.3s ease-out;}@keyframes prefsZoomIn{from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}to{transform:translate(-50%,-50%) scale(1);opacity:1;}}.cb-banner-animate-left{animation:slideInFromLeft 0.4s ease-out;}.cb-banner-animate-right{animation:slideInFromRight 0.4s ease-out;}.cb-banner-animate-top{animation:slideInFromTop 0.4s ease-out;}.cb-banner-animate-bottom{animation:slideInFromBottom 0.4s ease-out;}.cb-banner-animate-fade{animation:fadeIn 0.3s ease-out;}.cb-banner-animate-prefs-left{animation:prefsSlideInFromLeft 0.4s ease-out;}.cb-banner-animate-prefs-right{animation:prefsSlideInFromRight 0.4s ease-out;}.cb-banner-animate-center-top{animation:prefsSlideCenterFromTop 0.35s ease-out;}.cb-banner-animate-center-bottom{animation:prefsSlideCenterFromBottom 0.35s ease-out;}.cb-banner-animate-zoom-in{animation:zoomIn 0.3s ease-out;}.cb-banner-animate-prefs-zoom-in{animation:prefsZoomIn 0.3s ease-out;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}#cb-initial-banner.cb-banner .cb-banner-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex-shrink:0;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}#cb-initial-banner.cb-banner #cb-preferences-btn{background:#ffffff!important;color:#334155!important;border:1px solid #334155!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-initial-banner.cb-banner #cb-reject-all-btn,#cb-initial-banner.cb-banner #cb-accept-all-btn{background:#007aff!important;color:#ffffff!important;border-color:#007aff!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-floating-trigger{position:fixed;z-index:2147483646!important;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;}#cb-floating-trigger img,#cb-floating-trigger svg{display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;}#cb-preferences-banner.cb-banner .cb-brand-footer{flex:0 0 auto;box-sizing:border-box;height:44px;max-height:50px;width:calc(100% + 40px);margin:16px -20px -20px;padding:0 16px;display:flex;align-items:center;justify-content:flex-end;gap:8px;background:#F7F8FA !important;background-color:#F7F8FA !important;border-top:1px solid #EFF1F4 !important;}#cb-preferences-banner.cb-banner .cb-brand-footer a{display:inline-flex !important;align-items:center;gap:7px;text-decoration:none !important;background:transparent !important;color:#A2ABBA !important;font-weight:500 !important;border-radius:6px;padding:4px 6px;margin-right:-6px;transition:opacity .15s ease;}#cb-preferences-banner.cb-banner .cb-brand-footer a:hover{opacity:.7;}#cb-preferences-banner.cb-banner .cb-brand-credit{font-size:11px !important;font-weight:500 !important;letter-spacing:.02em;line-height:1;white-space:nowrap;color:#A2ABBA !important;}#cb-preferences-banner.cb-banner .cb-brand-mark{display:flex;align-items:center;opacity:.85;}#cb-preferences-banner.cb-banner .cb-brand-mark svg{display:block;height:9.75px;width:auto;}";e.styles&&(D=D+"\\n"+e.styles);var F="cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in";Ue();"complete"===document.readyState||"interactive"===document.readyState?ut():window.addEventListener("DOMContentLoaded",ut)}var Z={analytics:["_ga","_ga_*","_gid","_gat","_gat_*","_gac_*","_hjid","_hjSessionUser_*","_hjSession_*","_hjAbsoluteSessionInProgress","_clck","_clsk"],marketing:["_fbp","_fbc","_gcl_au","_gcl_ls","_gcl_aw","_ttp","tt_webid_v2","_pin_unauth","_pinterest_ct_ua","li_sugr","bcookie","bscookie","lidc","_uetsid","_uetvid","IDE","test_cookie","fr","_reb2b*","_gd_visitor","_gd_session","_gd_svisitor","_an_uid","__hstc","__hssc","__hssrc","hubspotutk","messagesUtk","_li_dcdm_c","_li_ss","li_fat_id","_lc2_fpi*"],preferences:[]}}function R(){if(C){var e=(navigator.language||navigator.userLanguage||"en").split("-")[0].toLowerCase();return TRANSLATIONS[e]?e:"en"}return x}function W(e){var t=R();var n=TRANSLATIONS[t]||TRANSLATIONS.en;var r=null!=n[e]?n[e]:null!=TRANSLATIONS.en[e]?TRANSLATIONS.en[e]:"";return""===r&&"title"===e?"We value your privacy":""===r&&"description"===e?"We use cookies to enhance your browsing experience, serve personalised ads or content, and analyse our traffic. By clicking \\"Accept\\", you consent to our use of cookies.":r}function U(e){var t=R();var n=(TRANSLATIONS[t]||TRANSLATIONS.en)[e];n&&n.length>80&&(n=TRANSLATIONS.en[e]||e);return n||TRANSLATIONS.en[e]||e}function q(e,t){var n=null==e?"":String(e);return n.length>t?n.slice(0,t):n}function J(e,t){return q(W(e),t)}function Y(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.cookiePolicyLinkEnabled?t.cookiePolicyLinkEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).cookiePolicyLinkEnabled;return!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function gPL(){try{var t=TRANSLATIONS.config||{};var n=t.googlePrivacyLink;return!0===n||1===n||"1"===n||"true"===String(n).toLowerCase()}catch(e){return!1}}function gPT(){var m={en:"How Google uses data when you use our partners' sites or apps",de:"Wie Google Daten verwendet, wenn Sie Websites oder Apps unserer Partner nutzen",es:"Cómo utiliza Google los datos cuando usas sitios web o aplicaciones de nuestros partners",fr:"Comment Google utilise les données lorsque vous utilisez les sites ou applications de nos partenaires",it:"In che modo Google utilizza i dati quando utilizzi siti o app dei nostri partner",nl:"Hoe Google gegevens gebruikt wanneer je sites of apps van onze partners gebruikt",pl:"Jak Google wykorzystuje dane podczas korzystania z witryn lub aplikacji partnerów",pt:"Como o Google usa dados quando você usa sites ou apps dos nossos parceiros",sv:"Hur Google använder data när du använder våra partners webbplatser eller appar"};var l="en";try{l=String(R()||"en").toLowerCase()}catch(e){}return m[l]||m.en}function X(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.closeButtonEnabled?t.closeButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).closeButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function $(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.rejectButtonEnabled?t.rejectButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).rejectButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function G(){try{var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.customizeButtonEnabled?t.customizeButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).customizeButtonEnabled;return!0===n||1===n||!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function K(e){var t=String(e||"bottom-left").trim().toLowerCase().replace(/_/g,"-");return"bottom-right"===t||"right"===t?"bottom-right":"bottom"===t||"bottom-center"===t?"bottom":"bottom-left"}function Q(e){if(e){e.style.marginLeft="";e.style.marginRight="";e.style.paddingLeft="";e.style.paddingRight="";if(ot()){var t=f||"box";var n=K(p&&p.position);var r=st();var a="56px";"banner"!==t?"left"===r?"bottom-center"!==t&&"popup"!==t&&"bottom"!==n||(e.style.marginLeft=a):"bottom-center"!==t&&"popup"!==t&&"bottom"!==n||(e.style.marginRight=a):"left"===r?e.style.paddingLeft=a:e.style.paddingRight=a}}}function ee(e){if(!e)return!1;var t=f||"box";var n=K(p&&p.position);e.style.left="";e.style.right="";e.style.top="";e.style.bottom="";e.style.transform="";e.style.width="";e.style.maxWidth="";e.style.marginLeft="";e.style.marginRight="";e.style.paddingLeft="";e.style.paddingRight="";if("banner"===t){e.style.left="0";e.style.right="0";e.style.bottom="0";e.style.transform="none";e.style.width="100%";e.style.maxWidth="none";e.setAttribute("data-cb-initial-centered","0");Q(e);return!1}if(window.innerWidth<=660){e.style.setProperty("left","0","important");e.style.setProperty("right","0","important");e.style.setProperty("bottom","0","important");e.style.setProperty("transform","none","important");e.style.setProperty("width","100vw","important");e.style.setProperty("max-width","100vw","important");e.style.setProperty("min-width","0","important");e.style.setProperty("border-radius","0","important");e.style.setProperty("border-left","none","important");e.style.setProperty("border-right","none","important");e.style.setProperty("border-bottom","none","important");e.setAttribute("data-cb-initial-centered","0");return!1}if("bottom-center"===t||"popup"===t||"bottom"===n){e.style.bottom="32px";e.style.left="50%";e.style.transform="translateX(-50%)";e.setAttribute("data-cb-initial-centered","1");Q(e);return!0}e.style.bottom="32px";"bottom-right"===n?e.style.right="32px":e.style.left="32px";e.style.transform="none";e.setAttribute("data-cb-initial-centered","0");Q(e);return!1}function te(e){var t=e;var n=t.indexOf("#");n>=0&&(t=t.slice(0,n));(n=t.indexOf("?"))>=0&&(t=t.slice(0,n));(n=t.indexOf("/"))>=0&&(t=t.slice(0,n));return t.trim()}function ne(e){var t=e.lastIndexOf(".");if(t<0)return!1;var n=e.slice(t).toLowerCase();return".js"===n||".mjs"===n||".css"===n||".png"===n||".jpg"===n||".jpeg"===n||".gif"===n||".svg"===n||".webp"===n||".pdf"===n||".json"===n||".xml"===n||".ico"===n||".woff"===n||".woff2"===n}function re(e){if(!e||"string"!=typeof e)return"";var t=e.trim();if(!t)return"";var n=t.toLowerCase();if(0===n.indexOf("mailto:")||0===n.indexOf("tel:"))return t;if(0===n.indexOf("http://")||0===n.indexOf("https://"))return t;if(0===t.indexOf("//"))return"https:"+t;if("/"===t.charAt(0)||0===t.indexOf("./")||0===t.indexOf("../")){try{if("undefined"!=typeof window&&window.location)return new URL(t,window.location.href).href}catch(e){}return t}var r=te(t);if(r.indexOf(".")>0&&!ne(r)){for(;t.length>0&&"/"===t.charAt(0);)t=t.slice(1);return"https://"+t}try{if("undefined"!=typeof window&&window.location)return new URL(t,window.location.href).href}catch(e){}return t}function ae(e,t){var n=re(t);if(n){e.href=n;e.target="_blank";e.rel="noopener noreferrer";e.addEventListener("click",function(e){e.stopPropagation&&e.stopPropagation();e.preventDefault&&e.preventDefault();try{window.open(n,"_blank","noopener,noreferrer")}catch(e){}},!0)}}function cbDNS(){return!!(I&&I.accepted&&I.ccpa&&I.ccpa.doNotSell)||cbQcOff&&!(I&&I.accepted)}function cbOptMs(e,t){return cbLawFix&&e&&e.ccpa&&e.ccpa.doNotSell?Math.max(t,31536e6):t}function ie(){try{var e=localStorage.getItem(L);var t=e?JSON.parse(e):{accepted:!1,timestamp:null};if(!t||!t.accepted)return t||{accepted:!1,timestamp:null};var n=Date.now();var r=24*A*60*60*1e3;var a=t.expiresAt?new Date(t.expiresAt).getTime():t.timestamp?new Date(t.timestamp).getTime()+r:0;cbLawFix&&t.ccpa&&t.ccpa.doNotSell&&t.timestamp&&(a=Math.max(a,new Date(t.timestamp).getTime()+31536e6));return a>0&&n>a?{accepted:!1,timestamp:null}:t}catch(e){return{accepted:!1,timestamp:null}}}function oe(e){try{!0===navigator.globalPrivacyControl&&(e.gpc=!0);var t=cbOptMs(e,24*A*60*60*1e3);e.expiresAt=e.expiresAt||new Date(Date.now()+t).toISOString();localStorage.setItem(L,JSON.stringify(e));localStorage.removeItem(L+"_closed")}catch(e){}I=e;try{je()}catch(e){}}function ce(e){try{var t={analytics:!!e.analytics,preferences:!!e.preferences,marketing:!!e.marketing};var n=btoa(JSON.stringify(t));localStorage.setItem(H,n)}catch(e){}}function se(){try{var e=localStorage.getItem(H);if(!e)return null;var t=JSON.parse(atob(e));return t&&"object"==typeof t?{analytics:!!t.analytics,preferences:!!t.preferences,marketing:!!t.marketing}:null}catch(e){return null}}function le(e,t){if(a&&c){t=t||{};var n=e&&e.expiresAt||t.expiresAt||new Date(Date.now()+cbOptMs(e,24*A*60*60*1e3)).toISOString();var r={siteId:a,regulation:"gdpr"===i?"gdpr":"ccpa",bannerType:i,consentMethod:t.consentMethod||"banner",status:t.status||"given",expiresAt:n,consent:e};cbLawFix&&(r.law=cbCountryLaw&&cbCountryLaw.law||cbLaw&&cbLaw.law||null,r.lawResolved=!!(cbCountryLaw&&!1!==cbCountryLaw.resolved||cbLaw&&cbLaw.resolved),r.consentLanguage=p&&p.language||"en",r.consentModel=cbCountryLaw&&cbCountryLaw.model||("gdpr"===i?"optin":"optout"),r.langWanted=cbCountryLaw&&cbCountryLaw.langWanted||null,r.noticeVersion=cbNoticeV,r.policyVersion=cbPolicyV);try{if(cbLawFix)r.deviceId=cbGetId()}catch(x){}try{fetch(c+"/api/consent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(r)}).catch(function(e){})}catch(e){}}}function de(){try{var e=localStorage.getItem(T);if(!e)return!1;var t=JSON.parse(e);var n=new Date;var r=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0");return t.yearMonth===r&&!0===t.overLimit}catch(e){return!1}}function pe(e){try{localStorage.setItem(T,JSON.stringify({overLimit:!0,yearMonth:e}))}catch(e){}}function be(){if(a&&c&&!de())try{var e={siteId:a,pageUrl:"undefined"!=typeof window&&window.location?window.location.href:null};fetch(c+"/api/pageview",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e),keepalive:!0}).then(function(e){return e.json()}).then(function(e){if(e&&e.overLimit){var t=new Date;pe(e.yearMonth||t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0"))}}).catch(function(e){})}catch(e){}}function fe(){try{var e="undefined"!=typeof document&&document.cookie?document.cookie:"";return e?e.split(";").map(function(e){return e.trim()}).filter(Boolean):[]}catch(e){return[]}}function me(){try{var e=[];var t=document.getElementsByTagName("script");for(var n=0;n<t.length;n++){var r=t[n].src;r&&-1===r.indexOf("consentbit")&&-1===r.indexOf("client_data")&&e.push(r)}return e}catch(e){return[]}}function ge(e){try{var t=new URL(e).hostname;return-1!==t.indexOf("google-analytics.com")||-1!==e.indexOf("gtag/js")||-1!==t.indexOf("googletagmanager.com")?"analytics":-1!==t.indexOf("facebook.com")||-1!==t.indexOf("fbcdn.net")||-1!==t.indexOf("doubleclick.net")||0===t.indexOf("ads.")?"marketing":-1!==t.indexOf("hotjar.com")||-1!==t.indexOf("intercom.io")||-1!==t.indexOf("fullstory.com")?"behavioral":"uncategorized"}catch(e){return"uncategorized"}}function ue(){var t=[];var n=document.scripts;for(var r=0;r<n.length;r++){var a=n[r];if(a.src)t.push(a)}return t}function ye(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("googletagmanager.com/gtag/js")||-1!==t.indexOf("googletagmanager.com/gtm.js")||-1!==t.indexOf("google-analytics.com")||-1!==t.indexOf("googlesyndication.com")||-1!==t.indexOf("googleadservices.com")||-1!==t.indexOf("googletagservices.com")||-1!==t.indexOf("securepubads.g.doubleclick.net")}function ve(){var e=document.scripts;for(var t=0;t<e.length;t++){var n=e[t];var r;if(ye(n.src||n.getAttribute("data-cb-blocked-src")||""))return!0}return!(!window.adsbygoogle&&!window.googletag)}function he(){window.dataLayer=window.dataLayer||[];window.gtag||(window.gtag=function(){dataLayer.push(arguments)});return window.gtag}function xe(){var e=he();e("set","ads_data_redaction",!0);e("set","url_passthrough",!0)}function Ce(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("clarity.ms")||-1!==t.indexOf("clarity.microsoft.com")}function we(e,t){return!("analytics"!==e||!Oe(t)||"advanced"!==cbGcm)||l&&Ce(t)||uetConsentEnabled&&isUetTagUrl(t)}function ke(){window.clarity||(window.clarity=function(){(window.clarity.q=window.clarity.q||[]).push(arguments)});return window.clarity}function _e(e){if(l)try{var t=e||{};var n=t.marketing?"granted":"denied";var r=t.analytics?"granted":"denied";var a=n+"|"+r;if(window.__cbClaritySignal===a)return;window.__cbClaritySignal=a;ke()("consentv2",{source:d,ad_Storage:n,analytics_Storage:r})}catch(e){}}function isUetTagUrl(e){return!(!e||"string"!=typeof e)&&-1!==e.toLowerCase().indexOf("bat.bing.com")}function updateUetConsent(e){if(uetConsentEnabled)try{var t=(e||{}).marketing?"granted":"denied";if(window.__cbUetSignal===t)return;window.__cbUetSignal=t;window.uetq=window.uetq||[];window.uetq.push("consent","update",{ad_storage:t})}catch(e){}}function Ee(e,t){try{var n=e||{};window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:"consentbit_consent_update",consentbit_regulation:i,consentbit_source:String(t||"banner").replace(/[[]]/g,"").toLowerCase(),consentbit_essential:!0,consentbit_analytics:!!n.analytics,consentbit_marketing:!!n.marketing,consentbit_preferences:!!n.preferences})}catch(e){}}function Se(e){return"cbgoogle"===e||"analytics"===e||"marketing"===e||"behavioral"===e||"advertisement"===e||"functional"===e||"performance"===e}function cbGcmCats(e){var t=String(e).toLowerCase();if("basic"===cbGcm)return["cbgoogle"];return-1!==t.indexOf("gtm.js")?["analytics","marketing"]:/[?&]id=(aw|dc)-/.test(t)?["marketing"]:["analytics"]}function cbGcmInit(n){var g=he();xe();g("set","developer_id.dN2Q3Yj",!0);var d={};for(var k in n)d[k]=n[k];d.security_storage="granted";g("consent","default",d);try{var L=window.dataLayer;if(L&&L.push===Array.prototype.push){var h=[],r=[];for(var q=0;q<L.length;q++){var it=L[q];(it&&("consent"===it[0]||"set"===it[0])?h:r).push(it)}if(h.length&&r.length&&L[0]!==h[0]){L.length=0;Array.prototype.push.apply(L,h.concat(r))}}}catch(x){}window.__cbConsentDefaultSet=!0}function Oe(e){if(!e||"string"!=typeof e)return!1;var t=e.toLowerCase();return-1!==t.indexOf("googletagmanager.com/gtag/js")||-1!==t.indexOf("googletagmanager.com/gtm.js")||-1!==t.indexOf("google-analytics.com")}function Be(e){var t=e;"behavioral"===t&&(t="analytics");if("essential"===t)return!0;if("ccpa"===i)return!(cbDNS()&&Se(t));if(!I||!I.accepted)return!1;var n=I.categories||{};if("cbgoogle"===t)return!(!n.analytics&&!n.marketing);return"analytics"===t?!!n.analytics:"marketing"===t||"advertisement"===t?!!n.marketing:"preferences"!==t&&"functional"!==t&&"performance"!==t||!!n.preferences}function Le(e){if(!e)return!1;var t=String(e).split(",");for(var n=0;n<t.length;n++){var r=String(t[n]||"").toLowerCase().trim();if(r){"personalization"===r&&(r="preferences");if(!Be(r))return!1}}return!0}function Ae(e){if(!e)return null;var t=String(e).toLowerCase().trim();return"analytics"===t||"marketing"===t||"behavioral"===t||"preferences"===t||"essential"===t?["essential"===t?"essential":t]:t.indexOf("necessary")>=0||t.indexOf("essential")>=0?["essential"]:t.indexOf("functional")>=0||t.indexOf("preference")>=0?["preferences"]:t.indexOf("analytics")>=0||t.indexOf("performance")>=0||t.indexOf("statistics")>=0?["analytics"]:t.indexOf("advertisement")>=0||t.indexOf("marketing")>=0||t.indexOf("ads")>=0||t.indexOf("social")>=0?["marketing"]:t.indexOf("other")>=0?["analytics"]:null}function Ie(e,t){if(t&&t.getAttribute){var n=Ae(t.getAttribute("data-consentbit"));if(n)return n;var r=t.getAttribute("data-consentbit-category");r||window.__CB_WEBFLOW_MODE__||(r=t.getAttribute("data-category"));if(r){var a=[];var i=String(r).split(",");for(var o=0;o<i.length;o++){var c=String(i[o]||"").toLowerCase().trim();if(c){var s=Ae("personalization"===c?"preferences":c);if(s)for(var l=0;l<s.length;l++)-1===a.indexOf(s[l])&&a.push(s[l])}}if(a.length)return a}var d=Ae(t.getAttribute("data-cookieyes"));if(d)return d}if(e&&"advanced"!==cbGcm&&Oe(e))return cbGcmCats(e);if(e&&j.length)for(var p=0;p<j.length;p++){var b=j[p];if(b&&b.pattern)try{if(new RegExp(b.pattern,"i").test(e))return b.categories&&b.categories.length?b.categories.slice():["analytics"]}catch(e){}}if(e&&V.length)for(var f=0;f<V.length;f++){var m=V[f];if(m&&m.scriptUrlPattern)try{if(new RegExp(m.scriptUrlPattern,"i").test(e))return[m.category||"uncategorized"]}catch(e){}}return[]}function He(e,t){if(z)return!1;if(!e)return!1;if("string"!=typeof e){try{e=String(e)}catch(__cbTT){return!1}}var n=e.toLowerCase();if(-1!==n.indexOf("consentbit")||-1!==n.indexOf("client_data"))return!1;var r=Ie(e,t);if(!r||0===r.length)return!1;if("ccpa"===i)return!!(cbDNS());for(var a=0;a<r.length;a++){var o=r[a];if(Se(o)&&!we(o,e)&&!Be(o))return!0}return!1}function Te(e){return e&&"string"==typeof e?e.indexOf("fbq(")>=0||e.indexOf("fbq (")>=0||e.indexOf("connect.facebook.net")>=0||e.indexOf("ttq(")>=0||e.indexOf("ttq (")>=0||e.indexOf("analytics.tiktok.com")>=0||e.indexOf("pintrk(")>=0||e.indexOf("pintrk (")>=0||e.indexOf("ct.pinterest.com")>=0||e.indexOf("twq(")>=0||e.indexOf("twq (")>=0||e.indexOf("ads-twitter.com")>=0||e.indexOf("_linkedin_partner_id")>=0||e.indexOf("lintrk(")>=0||e.indexOf("lintrk (")>=0?"marketing":e.indexOf("bat.bing.com")>=0?(uetConsentEnabled?null:"marketing"):e.indexOf("hotjar.com")>=0?"analytics":e.indexOf("window.clarity")>=0||e.indexOf("clarity.ms")>=0?l?null:"analytics":null:null}function Pe(e){if(e&&"SCRIPT"===e.nodeName&&(!e.getAttribute||"javascript/blocked"!==e.getAttribute("type"))){var t=e.getAttribute&&e.getAttribute("src")||e.src||"";if(t){if(He(t,e))try{var Ot=e.getAttribute("type")||"";Ot&&"javascript/blocked"!==Ot&&e.setAttribute("data-cb-orig-type",Ot);e.setAttribute("data-cb-blocked-src",t);e.setAttribute("type","javascript/blocked");e.removeAttribute("src")}catch(e){}}else{var n=e.getAttribute&&(e.getAttribute("data-consentbit-category")||!window.__CB_WEBFLOW_MODE__&&e.getAttribute("data-category"))||Te(e.textContent||"");if(n&&!Be(n))try{e.__ci=e.textContent||"";var r=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");r&&r.set?r.set.call(e,""):e.textContent="";e.setAttribute("type","javascript/blocked");e.setAttribute("data-cb-inline","1")}catch(e){}}}}function ze(e){if(e&&!e.__cp){e.__cp=!0;var Sv="";try{Object.defineProperty(e,"src",{configurable:!0,enumerable:!0,get:function(){if(Sv)return String(Sv);var v="";try{v=e.getAttribute&&(e.getAttribute("src")||e.getAttribute("data-cb-blocked-src"))||""}catch(n){}return String(v)},set:function(t){Sv=t;if(He(t,e)){var Ot=e.getAttribute("type")||"";Ot&&"javascript/blocked"!==Ot&&!e.getAttribute("data-cb-orig-type")&&e.setAttribute("data-cb-orig-type",Ot);e.setAttribute("data-cb-blocked-src",t);e.setAttribute("type","javascript/blocked");e.removeAttribute("src")}else e.setAttribute("src",t)}})}catch(e){}try{Object.defineProperty(e,"type",{configurable:!0,enumerable:!0,get:function(){return e.getAttribute("type")||""},set:function(t){var n=t;if(He(e.getAttribute("src")||e.src||"",e)){t&&"javascript/blocked"!==t&&e.setAttribute("data-cb-orig-type",t);n="javascript/blocked"}e.setAttribute("type",n)}})}catch(e){}try{var t=Object.getOwnPropertyDescriptor(Node.prototype,"textContent");if(t&&t.set){var n=t.set;Object.defineProperty(e,"textContent",{configurable:!0,get:function(){return t.get?t.get.call(e):""},set:function(t){var r=e.getAttribute&&(e.getAttribute("data-consentbit-category")||!window.__CB_WEBFLOW_MODE__&&e.getAttribute("data-category"))||Te(t);if(r&&!Be(r)){e.__ci=t;e.setAttribute("type","javascript/blocked");e.setAttribute("data-cb-inline","1")}else n.call(e,t)}})}}catch(e){}}}function Ne(e){if(e&&1===e.nodeType)if("SCRIPT"!==e.nodeName){if(e.querySelectorAll){var t=e.querySelectorAll("script[src]");for(var n=0;n<t.length;n++)Pe(t[n])}}else Pe(e)}function je(e){if(window.__CB_WEBFLOW_MODE__)We(e||I&&I.categories||{analytics:!0,marketing:!0,preferences:!0,essential:!0});else{var t=document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');for(var n=0;n<t.length;n++){var r=t[n];var a=r.getAttribute("data-cb-blocked-src");if(a&&!He(a,r)){z=!0;try{var i=document.createElement("script");i.async=r.hasAttribute("async");i.defer=r.hasAttribute("defer");r.id&&(i.id=r.id);i.src=a;var o=r.attributes;for(var c=0;c<o.length;c++){var s=o[c].name;"src"!==s&&"type"!==s&&"data-cb-blocked-src"!==s&&"data-cb-orig-type"!==s&&"nonce"!==s&&i.setAttribute(s,o[c].value)}var Ty=r.getAttribute("data-cb-orig-type");Ty&&(i.type=Ty);var Nz=r.nonce||r.getAttribute("nonce")||"";if(Nz)try{i.nonce=Nz}catch(e){}r.parentNode?r.parentNode.replaceChild(i,r):document.head.appendChild(i)}catch(e){}finally{z=!1}}}var l=document.querySelectorAll('script[type="text/plain"][data-consentbit-category],script[type="text/plain"][data-category]');for(var d=0;d<l.length;d++){var p=l[d];var b=p.getAttribute("data-consentbit-category")||p.getAttribute("data-category");if(b&&Le(b)){z=!0;try{var f=document.createElement("script");f.async=p.hasAttribute("async");f.defer=p.hasAttribute("defer");var m=p.getAttribute("src")||"";m?f.src=m:f.textContent=p.textContent;var g=p.attributes;for(var u=0;u<g.length;u++){var y=g[u].name;"type"!==y&&"src"!==y&&"data-consentbit-category"!==y&&"data-category"!==y&&f.setAttribute(y,g[u].value)}p.parentNode?p.parentNode.replaceChild(f,p):document.head.appendChild(f)}catch(e){}finally{z=!1}}}var v=document.querySelectorAll('script[type="javascript/blocked"][data-cb-inline="1"]');for(var h=0;h<v.length;h++){var x=v[h];var C=x.__ci||"";var w=x.getAttribute&&(x.getAttribute("data-consentbit-category")||x.getAttribute("data-category"))||Te(C);if(w&&Le(w)){z=!0;try{var k=document.createElement("script");C&&(k.textContent=C);var Nz2=x.nonce||x.getAttribute&&x.getAttribute("nonce")||"";if(Nz2)try{k.nonce=Nz2}catch(e){}x.parentNode?x.parentNode.replaceChild(k,x):document.head.appendChild(k)}catch(e){}finally{z=!1}}}var Fr=document.querySelectorAll("iframe[data-cb-blocked-src]");for(var Fi=0;Fi<Fr.length;Fi++){var Ff=Fr[Fi];var Fs=Ff.getAttribute("data-cb-blocked-src");if(Fs&&!Ze(Fs))try{Ff.removeAttribute("data-cb-blocked-src");Ff.setAttribute("src",Fs)}catch(e){}}}}function Ve(e){if(e==="consentbit-consentid")return;var t=window.location.hostname;var n=0===t.indexOf("www.")?t.slice(4):t;var r=[null,t,"."+t,n,"."+n,"www."+n,".www."+n];var a=["/",window.location.pathname];var i="Thu, 01 Jan 1970 00:00:00 GMT";for(var o=0;o<r.length;o++)for(var c=0;c<a.length;c++){var s=e+"=; expires="+i+"; path="+a[c];r[o]&&(s+="; domain="+r[o]);try{document.cookie=s}catch(e){}}}function Me(e){var t=e.indexOf("*");var n=t>=0?e.slice(0,t):null;var r=document.cookie.split(";").map(function(e){return e.trim().split("=")[0]});return n?r.filter(function(e){return e.startsWith(n)}):r.indexOf(e)>=0?[e]:[]}function De(e){for(var t in Z)if(e.indexOf(t)>=0){var n=Z[t];for(var r=0;r<n.length;r++){var a=Me(n[r]);for(var i=0;i<a.length;i++)Ve(a[i])}}for(var o=0;o<V.length;o++){var c=V[o];!c||!c.category||e.indexOf(c.category)<0||c.name&&Ve(c.name)}}function Fe(e){if(!e||"string"!=typeof e)return null;var t=e.toLowerCase();if(0!==t.indexOf("http"))return null;for(var n=0;n<M.length;n++)if(-1!==t.indexOf(M[n].domain))return M[n].category;for(var r=0;r<V.length;r++){var a=V[r];if(a&&a.scriptUrlPattern)try{if(new RegExp(a.scriptUrlPattern,"i").test(e))return a.category||"marketing"}catch(e){}}return null}function Ze(e){if(!e)return!1;if("string"!=typeof e){try{e=String(e)}catch(__cbTT){return!1}}var t=e.toLowerCase();if(-1!==t.indexOf("consentbit")||-1!==t.indexOf("client_data"))return!1;var n=Fe(e);return!(!n||!Se(n)||("ccpa"===i?!(cbDNS()):I&&I.accepted&&Be(n)))}function Re(e){if(e&&!e.__ip){e.__ip=!0;var Iv="";try{Object.defineProperty(e,"src",{configurable:!0,enumerable:!0,get:function(){if(Iv)return String(Iv);var n="";try{n=e.getAttribute&&(e.getAttribute("src")||e.getAttribute("data-cb-blocked-src"))||""}catch(r){}return String(n)},set:function(t){Iv=t;if(Ze(t)){e.setAttribute("data-cb-blocked-src",t);e.removeAttribute("src")}else e.setAttribute("src",t)}})}catch(e){}}}function We(e){if(window.__CB_WEBFLOW_MODE__){var t=e||{};window.userConsent=t;try{document.dispatchEvent(new CustomEvent("consentUpdated",{detail:t,bubbles:!0}))}catch(e){}}}function Ue(){if(!window.__CB_WEBFLOW_MODE__&&!window.__ce){window.__ce=!0;try{N=document.createElement.bind(document)}catch(e){N=document.createElement}document.createElement=function(e,r){var t=arguments.length>1?N(e,r):N(e);var n=String(e||"").toLowerCase();"script"===n?ze(t):"iframe"===n&&Re(t);return t};var e=new MutationObserver(function(e){for(var t=0;t<e.length;t++){var n=e[t];if("childList"===n.type){var r=n.addedNodes;for(var a=0;a<r.length;a++)Ne(r[a])}else"attributes"===n.type&&"src"===n.attributeName&&n.target&&"SCRIPT"===n.target.nodeName&&Pe(n.target)}});try{e.observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["src"]})}catch(t){e.observe(document.documentElement,{childList:!0,subtree:!0})}window.__cm=e}}function qe(){if(window.__CB_WEBFLOW_MODE__)try{document.dispatchEvent(new CustomEvent("cbBlockScripts",{detail:{},bubbles:!0}))}catch(e){}else{var e=ue();for(var t=0;t<e.length;t++){var n=e[t];var r=n.src;if("javascript/blocked"!==n.getAttribute("type")){var a=Ie(r,n);var i=a.length>0?a[0]:"uncategorized";if(Se(i))if("analytics"===i&&s&&Oe(r)&&"advanced"===cbGcm);else if(l&&Ce(r));else if(uetConsentEnabled&&isUetTagUrl(r));else if(Be(i));else try{var Ot=n.getAttribute("type")||"";Ot&&"javascript/blocked"!==Ot&&n.setAttribute("data-cb-orig-type",Ot);n.setAttribute("data-cb-blocked-src",r);n.setAttribute("type","javascript/blocked");n.removeAttribute("src")}catch(e){}}}}}function Je(){if(P.length){var e=[];z=!0;try{for(var t=0;t<P.length;t++){var n=P[t];var r=n.cats||(n.category?[n.category]:[]);if(0===r.length||r.every(function(e){return!Se(e)||Be(e)})){var a=document.createElement("script");a.src=n.src;var i=n.attrs;for(var o in i)Object.prototype.hasOwnProperty.call(i,o)&&"src"!==o&&a.setAttribute(o,i[o]);document.head.appendChild(a)}else e.push(n)}}finally{z=!1}P=e}}function Ye(){if(s){if("advanced"!==cbGcm){if(window.__cbGaBooted||!Be("basic"===cbGcm?"cbgoogle":"analytics"))return;window.__cbGaBooted=!0}z=!0;try{var e=!1;var t=document.scripts;for(var n=0;n<t.length;n++){var r=t[n].src||"advanced"!==cbGcm&&t[n].getAttribute("data-cb-blocked-src")||"";if(-1!==r.indexOf("googletagmanager.com/gtag/js")||-1!==r.indexOf("googletagmanager.com/gtm.js")||-1!==r.indexOf("google-analytics.com")){e=!0;break}}if(!e){var a=document.createElement("script");a.async=!0;a.src="https://www.googletagmanager.com/gtag/js?id="+s;document.head.appendChild(a)}window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}window.gtag=gtag;"advanced"===cbGcm&&(xe(),gtag("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500}));gtag("js",new Date);gtag("config",s,{anonymize_ip:!0});gtag("event","page_view",{page_path:window.location.pathname,page_title:document.title||""})}finally{z=!1}}}function Xe(e,t){var n={analytics_storage:e.analytics?"granted":"denied",ad_storage:e.marketing?"granted":"denied",ad_user_data:e.marketing?"granted":"denied",ad_personalization:e.marketing?"granted":"denied",functionality_storage:e.preferences?"granted":"denied",personalization_storage:e.preferences?"granted":"denied"};if("advanced"===cbGcm)he()("consent","update",n);else if("basic"===cbGcm){if(window.__cbConsentDefaultSet)he()("consent","update",n);else if(e.analytics||e.marketing)cbGcmInit(n)}_e(e);updateUetConsent(e);Ee(e,t);"advanced"!==cbGcm&&s&&Ye()}function $e(e){var oo=cbLaw&&cbLaw.optOut||["analytics","marketing","preferences"];var ca=!!e&&oo.indexOf("analytics")>=0;var cm=!!e&&oo.indexOf("marketing")>=0;var cp=!!e&&oo.indexOf("preferences")>=0;var t={analytics_storage:ca?"denied":"granted",ad_storage:cm?"denied":"granted",ad_user_data:cm?"denied":"granted",ad_personalization:cm?"denied":"granted",functionality_storage:cp?"denied":"granted",personalization_storage:cp?"denied":"granted"};"off"!==cbGcm&&he()("consent","update",t);var n={analytics:!ca,marketing:!cm,preferences:!cp};_e(n);updateUetConsent(n);Ee(n,"ccpa");try{window.dataLayer.push({consentbit_do_not_sell:!!e,consentbit_us_law:cbLaw&&cbLaw.law||null})}catch(e){}}function Ge(e){var t=String(e).replace("#","");3===t.length&&(t=t[0]+t[0]+t[1]+t[1]+t[2]+t[2]);var n;var r;var a;return.299*(parseInt(t.substr(0,2),16)||0)+.587*(parseInt(t.substr(2,2),16)||0)+.114*(parseInt(t.substr(4,2),16)||0)>128?"#0f172a":"#ffffff"}function Ke(){if(!document.getElementById("cb-styles")){var e="#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{background-color:"+(p&&p.saveButtonBg?String(p.saveButtonBg):"#ffffff")+" !important;color:"+(p&&p.saveButtonText?String(p.saveButtonText):"#334155")+" !important;border-color:"+function(e,t){var n=String(e||"").trim().toLowerCase().replace(/ /g,"");return"#fff"===n||"#ffffff"===n||"white"===n||"rgb(255,255,255)"===n?t:e}(p&&p.saveButtonBg?String(p.saveButtonBg):"#ffffff",p&&p.saveButtonText?String(p.saveButtonText):"#334155")+" !important;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{background-color:"+(p&&p.acceptButtonBg?String(p.acceptButtonBg):"#ffffff")+" !important;color:"+(p&&p.acceptButtonText?String(p.acceptButtonText):"#334155")+" !important;border-color:"+(p&&p.acceptButtonBg?String(p.acceptButtonBg):"#e2e8f0")+" !important;}";var t="";if(p&&p.backgroundColor){var n=String(p.backgroundColor);t="#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{background-color:"+n+" !important;}.cb-gdpr-accordion{background-color:"+n+" !important;}"}var r="";if(p&&p.headingColor){var a=String(p.headingColor);r="#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{color:"+a+" !important;}.cb-gdpr-cat-label{color:"+a+" !important;}"}var i="";p&&p.textColor&&(i="#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{color:"+String(p.textColor)+" !important;}");var o="";if(p&&p.bannerFontWeight){var c=String(p.bannerFontWeight);o="#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-weight:"+c+" !important;}.cb-gdpr-cat-label{font-weight:"+c+" !important;}.cb-gdpr-cat-desc{font-weight:"+c+" !important;}.cb-banner p{font-weight:"+c+" !important;}"}var s="#cb-preferences-banner.cb-banner h3{padding-right:36px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs h3{padding-right:0 !important;padding-top:16px !important;margin-bottom:14px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs .cb-banner-body>p{margin-bottom:16px !important;}";var l="#cb-preferences-banner.cb-banner .cb-banner-body{padding-right:4px;}#cb-preferences-banner.cb-banner .cb-gdpr-accordion > div{margin-right:2px;}";var d="";if(p&&p.acceptButtonBg){var b=String(p.acceptButtonBg);var f=p.acceptButtonText?String(p.acceptButtonText):"#ffffff";d=".cb-banner button#cb-accept-all-btn{background-color:"+b+" !important;color:"+f+" !important;}#cb-initial-banner.cb-banner #cb-accept-all-btn{background:"+b+" !important;color:"+f+" !important;}"}var m="";if(p&&p.acceptButtonBg){var g=String(p.acceptButtonBg);var u=p.acceptButtonText?String(p.acceptButtonText):"#ffffff";m=".cb-banner button#cb-reject-all-btn{background-color:"+g+" !important;color:"+u+" !important;}#cb-initial-banner.cb-banner #cb-reject-all-btn{background:"+g+" !important;color:"+u+" !important;}.cb-banner button#cb-prefs-reject-btn{background-color:"+g+" !important;color:"+u+" !important;}"}var y=document.createElement("style");y.id="cb-styles";y.type="text/css";var v="";p&&p.backgroundColor&&(v="#cb-close-initial-btn,#cb-close-prefs-btn{color:"+Ge(p.backgroundColor)+" !important;}");y.appendChild(document.createTextNode(D+"\\n"+e+"\\n"+t+"\\n"+r+"\\n"+i+"\\n"+o+"\\n"+s+"\\n"+l+"\\n"+d+"\\n"+m+"\\n"+v));document.head.appendChild(y)}}function Qe(e,t){if(X()){var n=document.createElement("button");n.type="button";n.id=t;n.setAttribute("aria-label","Close");n.textContent="×";var r="#0f172a";p&&p.backgroundColor&&(r=Ge(p.backgroundColor));n.style.cssText="position:absolute;top:8px;right:24px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:"+r+";opacity:0.75;";e.appendChild(n)}}function et(e){if(X()){var t=document.createElement("button");t.type="button";t.id="cb-close-prefs-btn";t.setAttribute("aria-label","Close");t.textContent="×";var n="#0f172a";p&&p.backgroundColor&&(n=Ge(p.backgroundColor));t.style.cssText="position:absolute;top:8px;right:30px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:"+n+";opacity:0.75;";e.appendChild(t)}}function tt(){return'<svg viewBox="0 0 735 90" role="img" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="#98A2B3"><path d="M234.357 89.2656C227.796 89.2656 222.045 87.925 217.107 85.2439C212.238 82.4923 208.464 78.647 205.782 73.7081C203.101 68.7692 201.761 62.9484 201.761 56.2456C201.761 49.5428 203.101 43.722 205.782 38.7831C208.464 33.8442 212.238 30.0342 217.107 27.3531C222.045 24.6014 227.796 23.2256 234.357 23.2256C241.131 23.2256 246.916 24.5661 251.714 27.2472C256.582 29.9284 260.322 33.7384 262.932 38.6772C265.614 43.6161 266.954 49.4722 266.954 56.2456C266.954 62.9484 265.614 68.8045 262.932 73.8139C260.322 78.7528 256.582 82.5628 251.714 85.2439C246.846 87.925 241.06 89.2656 234.357 89.2656ZM234.357 78.8939C240.919 78.8939 245.999 76.9184 249.597 72.9672C253.266 68.9456 255.101 63.3717 255.101 56.2456C255.101 49.0489 253.266 43.475 249.597 39.5239C245.999 35.5728 240.919 33.5972 234.357 33.5972C227.866 33.5972 222.786 35.6081 219.117 39.6298C215.449 43.5809 213.614 49.1195 213.614 56.2456C213.614 63.3717 215.449 68.9456 219.117 72.9672C222.786 76.9184 227.866 78.8939 234.357 78.8939Z"/><path d="M158.471 89.3708C149.793 89.3708 142.208 87.5717 135.717 83.9733C129.297 80.3044 124.322 75.1539 120.795 68.5217C117.267 61.8894 115.503 54.0931 115.503 45.1325C115.503 36.1719 117.267 28.4108 120.795 21.8492C124.322 15.2169 129.297 10.1017 135.717 6.50333C142.208 2.83444 149.793 1 158.471 1C165.103 1 170.96 2.09361 176.04 4.28083C181.19 6.3975 185.423 9.53722 188.74 13.7C192.056 17.7922 194.313 22.7664 195.513 28.6225H183.236C181.966 23.1897 179.179 18.9917 174.875 16.0283C170.642 13.065 165.174 11.5833 158.471 11.5833C148.805 11.5833 141.22 14.5819 135.717 20.5792C130.214 26.5764 127.462 34.7608 127.462 45.1325C127.462 55.5747 130.214 63.7944 135.717 69.7917C141.22 75.7183 148.805 78.6817 158.471 78.6817C165.174 78.6817 170.642 77.2353 174.875 74.3425C179.179 71.3792 181.966 67.1811 183.236 61.7483H195.513C194.313 67.5339 192.056 72.5081 188.74 76.6708C185.423 80.7631 181.19 83.9028 176.04 86.09C170.96 88.2772 165.103 89.3708 158.471 89.3708Z"/><path d="M372.231 89.2656C363.412 89.2656 356.462 87.4311 351.382 83.7623C346.302 80.0934 343.515 74.9781 343.021 68.4164H354.769C355.263 72.297 356.956 75.1545 359.849 76.9889C362.742 78.8234 367.01 79.7406 372.655 79.7406C382.533 79.7406 387.471 76.6361 387.471 70.4272C387.471 67.8872 386.695 65.947 385.143 64.6064C383.661 63.1953 381.121 62.1722 377.523 61.5372L363.659 58.9973C351.876 56.81 345.985 51.2009 345.985 42.1697C345.985 36.3136 348.207 31.6923 352.652 28.3056C357.097 24.9189 363.165 23.2256 370.856 23.2256C378.828 23.2256 385.143 24.9542 389.8 28.4114C394.527 31.8686 397.208 36.737 397.843 43.0164H386.307C385.602 39.4886 383.944 36.8781 381.333 35.1847C378.793 33.4914 375.195 32.6448 370.538 32.6448C366.234 32.6448 362.883 33.3856 360.484 34.8673C358.156 36.3489 356.991 38.5009 356.991 41.3231C356.991 43.5103 357.732 45.2389 359.214 46.5089C360.766 47.7084 363.236 48.6256 366.622 49.2606L380.486 51.9064C386.695 53.0353 391.246 55.0461 394.139 57.9389C397.032 60.8317 398.478 64.7122 398.478 69.5806C398.478 75.7895 396.22 80.6225 391.705 84.0798C387.189 87.537 380.698 89.2656 372.231 89.2656Z"/><path d="M437.465 89.2656C430.833 89.2656 425.083 87.925 420.215 85.2439C415.346 82.4923 411.572 78.6117 408.89 73.6022C406.28 68.5928 404.975 62.7367 404.975 56.0339C404.975 49.3311 406.28 43.5456 408.89 38.6772C411.572 33.7384 415.311 29.9284 420.109 27.2472C424.907 24.5661 430.516 23.2256 436.936 23.2256C443.075 23.2256 448.366 24.4603 452.811 26.9297C457.327 29.3992 460.819 32.8917 463.289 37.4073C465.758 41.9228 466.993 47.285 466.993 53.4939V58.2564H416.405C416.757 64.8886 418.768 70.0745 422.437 73.8139C426.177 77.4828 431.151 79.3172 437.36 79.3172C441.663 79.3172 445.297 78.4353 448.26 76.6714C451.224 74.837 453.27 72.1559 454.399 68.6281H466.464C464.912 75.1897 461.56 80.2697 456.41 83.8681C451.33 87.4664 445.015 89.2656 437.465 89.2656ZM416.828 49.5781H455.563C454.998 44.357 453.058 40.3 449.742 37.4073C446.497 34.5145 442.193 33.0681 436.83 33.0681C431.539 33.0681 427.129 34.5145 423.601 37.4073C420.073 40.3 417.816 44.357 416.828 49.5781Z"/><path d="M564.448 87.9953C561.061 87.9953 558.415 87.1486 556.51 85.4553C554.676 83.6914 553.759 81.0809 553.759 77.6236V33.597H541.905V24.4953H553.864V7.99512H565.506V24.4953H582.122V33.597H565.612V78.682H583.815V87.9953H564.448Z"/><path d="M672 88V35H687V88H672Z"/><path d="M671 23V8H687V23H671Z"/><path d="M716.594 87.9955C712.693 87.9955 709.652 87.0038 707.47 85.0205C705.355 83.0372 704.297 80.0291 704.297 75.9963L704.297 35.4985H693.785V23.9951H704.396L704.53 7.99512L718.875 7.99512L718.874 23.9951H735V35.4985H719.073L719.073 76.393H734.642V87.9955H716.594Z"/><path d="M283.197 33.4209H287.594C289.814 29.8402 292.857 27.1189 296.725 25.2568C300.592 23.3231 305.14 22.3565 310.368 22.3564C318.676 22.3564 325.229 24.7554 330.027 29.5537C334.826 34.2805 337.226 40.6188 337.226 48.5684V87.9951H325.193V50.6104C325.193 44.8093 323.618 40.4045 320.467 37.3965C317.387 34.3885 312.839 32.8838 306.823 32.8838C300.879 32.8838 296.331 34.3885 293.18 37.3965C290.029 40.4045 288.453 44.8093 288.453 50.6104V87.9951H276.421V36.2266H267.972V21H283.197V33.4209Z"/><path d="M486 34.2314H489.33C491.517 30.7038 494.516 28.0229 498.326 26.1885C502.136 24.2835 506.617 23.3311 511.768 23.3311C519.952 23.3311 526.408 25.6947 531.135 30.4219C535.862 35.0785 538.226 41.3227 538.226 49.1543V87.9951H526.372V51.165C526.372 45.4501 524.82 41.1108 521.716 38.1475C518.682 35.1841 514.201 33.7031 508.274 33.7031C502.419 33.7032 497.938 35.1843 494.834 38.1475C491.73 41.1108 490.177 45.4501 490.177 51.165V87.9951H478.324V36.9951H470V20.9951H486V34.2314Z"/><path d="M631.386 7.66992C636.211 7.66997 640.376 8.52936 643.88 10.248C647.45 11.9008 650.26 14.2815 652.31 17.3887C654.359 20.4297 655.384 23.9999 655.384 28.0986C655.384 32.2635 653.684 36.2398 652 38.9951C649.075 43.7811 645.5 44.7578 645.627 44.7578L648.988 45.1553C651.963 45.8164 654.673 47.0394 657.119 48.8242C659.631 50.6092 661.615 52.8569 663.069 55.5674C664.59 58.2779 665.351 61.4843 665.351 65.1865C665.351 69.7482 664.226 73.7478 661.979 77.1855C659.797 80.5572 656.723 83.2019 652.756 85.1191C648.855 87.0363 644.326 87.9951 639.17 87.9951H596.826V21H611.999V40.2959H629.303C632.807 40.2959 635.484 39.4691 637.335 37.8164C639.252 36.0975 640.211 33.6844 640.211 30.5771C640.211 27.3378 639.252 24.892 637.335 23.2393C635.484 21.5866 632.807 20.7598 629.303 20.7598H612V7.66992H631.386ZM611.999 74.9053H636.394C640.823 74.9053 644.227 73.9463 646.607 72.0293C648.987 70.046 650.178 67.2031 650.178 63.501C650.178 59.8649 648.987 57.1206 646.607 55.2695C644.228 53.3526 640.856 52.3946 636.493 52.3945H611.999V74.9053Z"/></g><path d="M32.7604 87.4506C32.0233 88.1831 30.8281 88.1831 30.0909 87.4506L8.45288 65.9485C-2.81763 54.7488 -2.81763 36.5904 8.45288 25.3907C8.97709 24.8698 9.827 24.8698 10.3512 25.3907L51.4471 66.2285C52.1843 66.961 52.1843 68.1487 51.4471 68.8813L32.7604 87.4506Z" fill="#B4BCC8"/><path d="M35.3829 43.3719C34.8671 42.8423 34.8732 41.9897 35.3966 41.4677L76.4272 0.544909C77.1632 -0.189157 78.3479 -0.180458 79.0733 0.564338L97.4615 19.4444C98.1869 20.1891 98.1783 21.388 97.4423 22.1221L75.8387 43.669C64.5861 54.892 46.4734 54.759 35.3829 43.3719Z" fill="#8C95A3"/></svg>'}function nt(e){if(cbHideBrand)return;var t=document.createElement("div");t.className="cb-brand-footer";var n=document.createElement("a");n.href="https://consentbit.com";n.target="_blank";n.rel="noopener noreferrer";n.setAttribute("aria-label","Powered by ConsentBit");var r=document.createElement("span");r.className="cb-brand-credit";r.textContent="Powered by";n.appendChild(r);var a=document.createElement("span");a.className="cb-brand-mark";a.innerHTML='<svg viewBox="0 0 735 90" role="img" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><g fill="#98A2B3"><path d="M234.357 89.2656C227.796 89.2656 222.045 87.925 217.107 85.2439C212.238 82.4923 208.464 78.647 205.782 73.7081C203.101 68.7692 201.761 62.9484 201.761 56.2456C201.761 49.5428 203.101 43.722 205.782 38.7831C208.464 33.8442 212.238 30.0342 217.107 27.3531C222.045 24.6014 227.796 23.2256 234.357 23.2256C241.131 23.2256 246.916 24.5661 251.714 27.2472C256.582 29.9284 260.322 33.7384 262.932 38.6772C265.614 43.6161 266.954 49.4722 266.954 56.2456C266.954 62.9484 265.614 68.8045 262.932 73.8139C260.322 78.7528 256.582 82.5628 251.714 85.2439C246.846 87.925 241.06 89.2656 234.357 89.2656ZM234.357 78.8939C240.919 78.8939 245.999 76.9184 249.597 72.9672C253.266 68.9456 255.101 63.3717 255.101 56.2456C255.101 49.0489 253.266 43.475 249.597 39.5239C245.999 35.5728 240.919 33.5972 234.357 33.5972C227.866 33.5972 222.786 35.6081 219.117 39.6298C215.449 43.5809 213.614 49.1195 213.614 56.2456C213.614 63.3717 215.449 68.9456 219.117 72.9672C222.786 76.9184 227.866 78.8939 234.357 78.8939Z"/><path d="M158.471 89.3708C149.793 89.3708 142.208 87.5717 135.717 83.9733C129.297 80.3044 124.322 75.1539 120.795 68.5217C117.267 61.8894 115.503 54.0931 115.503 45.1325C115.503 36.1719 117.267 28.4108 120.795 21.8492C124.322 15.2169 129.297 10.1017 135.717 6.50333C142.208 2.83444 149.793 1 158.471 1C165.103 1 170.96 2.09361 176.04 4.28083C181.19 6.3975 185.423 9.53722 188.74 13.7C192.056 17.7922 194.313 22.7664 195.513 28.6225H183.236C181.966 23.1897 179.179 18.9917 174.875 16.0283C170.642 13.065 165.174 11.5833 158.471 11.5833C148.805 11.5833 141.22 14.5819 135.717 20.5792C130.214 26.5764 127.462 34.7608 127.462 45.1325C127.462 55.5747 130.214 63.7944 135.717 69.7917C141.22 75.7183 148.805 78.6817 158.471 78.6817C165.174 78.6817 170.642 77.2353 174.875 74.3425C179.179 71.3792 181.966 67.1811 183.236 61.7483H195.513C194.313 67.5339 192.056 72.5081 188.74 76.6708C185.423 80.7631 181.19 83.9028 176.04 86.09C170.96 88.2772 165.103 89.3708 158.471 89.3708Z"/><path d="M372.231 89.2656C363.412 89.2656 356.462 87.4311 351.382 83.7623C346.302 80.0934 343.515 74.9781 343.021 68.4164H354.769C355.263 72.297 356.956 75.1545 359.849 76.9889C362.742 78.8234 367.01 79.7406 372.655 79.7406C382.533 79.7406 387.471 76.6361 387.471 70.4272C387.471 67.8872 386.695 65.947 385.143 64.6064C383.661 63.1953 381.121 62.1722 377.523 61.5372L363.659 58.9973C351.876 56.81 345.985 51.2009 345.985 42.1697C345.985 36.3136 348.207 31.6923 352.652 28.3056C357.097 24.9189 363.165 23.2256 370.856 23.2256C378.828 23.2256 385.143 24.9542 389.8 28.4114C394.527 31.8686 397.208 36.737 397.843 43.0164H386.307C385.602 39.4886 383.944 36.8781 381.333 35.1847C378.793 33.4914 375.195 32.6448 370.538 32.6448C366.234 32.6448 362.883 33.3856 360.484 34.8673C358.156 36.3489 356.991 38.5009 356.991 41.3231C356.991 43.5103 357.732 45.2389 359.214 46.5089C360.766 47.7084 363.236 48.6256 366.622 49.2606L380.486 51.9064C386.695 53.0353 391.246 55.0461 394.139 57.9389C397.032 60.8317 398.478 64.7122 398.478 69.5806C398.478 75.7895 396.22 80.6225 391.705 84.0798C387.189 87.537 380.698 89.2656 372.231 89.2656Z"/><path d="M437.465 89.2656C430.833 89.2656 425.083 87.925 420.215 85.2439C415.346 82.4923 411.572 78.6117 408.89 73.6022C406.28 68.5928 404.975 62.7367 404.975 56.0339C404.975 49.3311 406.28 43.5456 408.89 38.6772C411.572 33.7384 415.311 29.9284 420.109 27.2472C424.907 24.5661 430.516 23.2256 436.936 23.2256C443.075 23.2256 448.366 24.4603 452.811 26.9297C457.327 29.3992 460.819 32.8917 463.289 37.4073C465.758 41.9228 466.993 47.285 466.993 53.4939V58.2564H416.405C416.757 64.8886 418.768 70.0745 422.437 73.8139C426.177 77.4828 431.151 79.3172 437.36 79.3172C441.663 79.3172 445.297 78.4353 448.26 76.6714C451.224 74.837 453.27 72.1559 454.399 68.6281H466.464C464.912 75.1897 461.56 80.2697 456.41 83.8681C451.33 87.4664 445.015 89.2656 437.465 89.2656ZM416.828 49.5781H455.563C454.998 44.357 453.058 40.3 449.742 37.4073C446.497 34.5145 442.193 33.0681 436.83 33.0681C431.539 33.0681 427.129 34.5145 423.601 37.4073C420.073 40.3 417.816 44.357 416.828 49.5781Z"/><path d="M564.448 87.9953C561.061 87.9953 558.415 87.1486 556.51 85.4553C554.676 83.6914 553.759 81.0809 553.759 77.6236V33.597H541.905V24.4953H553.864V7.99512H565.506V24.4953H582.122V33.597H565.612V78.682H583.815V87.9953H564.448Z"/><path d="M672 88V35H687V88H672Z"/><path d="M671 23V8H687V23H671Z"/><path d="M716.594 87.9955C712.693 87.9955 709.652 87.0038 707.47 85.0205C705.355 83.0372 704.297 80.0291 704.297 75.9963L704.297 35.4985H693.785V23.9951H704.396L704.53 7.99512L718.875 7.99512L718.874 23.9951H735V35.4985H719.073L719.073 76.393H734.642V87.9955H716.594Z"/><path d="M283.197 33.4209H287.594C289.814 29.8402 292.857 27.1189 296.725 25.2568C300.592 23.3231 305.14 22.3565 310.368 22.3564C318.676 22.3564 325.229 24.7554 330.027 29.5537C334.826 34.2805 337.226 40.6188 337.226 48.5684V87.9951H325.193V50.6104C325.193 44.8093 323.618 40.4045 320.467 37.3965C317.387 34.3885 312.839 32.8838 306.823 32.8838C300.879 32.8838 296.331 34.3885 293.18 37.3965C290.029 40.4045 288.453 44.8093 288.453 50.6104V87.9951H276.421V36.2266H267.972V21H283.197V33.4209Z"/><path d="M486 34.2314H489.33C491.517 30.7038 494.516 28.0229 498.326 26.1885C502.136 24.2835 506.617 23.3311 511.768 23.3311C519.952 23.3311 526.408 25.6947 531.135 30.4219C535.862 35.0785 538.226 41.3227 538.226 49.1543V87.9951H526.372V51.165C526.372 45.4501 524.82 41.1108 521.716 38.1475C518.682 35.1841 514.201 33.7031 508.274 33.7031C502.419 33.7032 497.938 35.1843 494.834 38.1475C491.73 41.1108 490.177 45.4501 490.177 51.165V87.9951H478.324V36.9951H470V20.9951H486V34.2314Z"/><path d="M631.386 7.66992C636.211 7.66997 640.376 8.52936 643.88 10.248C647.45 11.9008 650.26 14.2815 652.31 17.3887C654.359 20.4297 655.384 23.9999 655.384 28.0986C655.384 32.2635 653.684 36.2398 652 38.9951C649.075 43.7811 645.5 44.7578 645.627 44.7578L648.988 45.1553C651.963 45.8164 654.673 47.0394 657.119 48.8242C659.631 50.6092 661.615 52.8569 663.069 55.5674C664.59 58.2779 665.351 61.4843 665.351 65.1865C665.351 69.7482 664.226 73.7478 661.979 77.1855C659.797 80.5572 656.723 83.2019 652.756 85.1191C648.855 87.0363 644.326 87.9951 639.17 87.9951H596.826V21H611.999V40.2959H629.303C632.807 40.2959 635.484 39.4691 637.335 37.8164C639.252 36.0975 640.211 33.6844 640.211 30.5771C640.211 27.3378 639.252 24.892 637.335 23.2393C635.484 21.5866 632.807 20.7598 629.303 20.7598H612V7.66992H631.386ZM611.999 74.9053H636.394C640.823 74.9053 644.227 73.9463 646.607 72.0293C648.987 70.046 650.178 67.2031 650.178 63.501C650.178 59.8649 648.987 57.1206 646.607 55.2695C644.228 53.3526 640.856 52.3946 636.493 52.3945H611.999V74.9053Z"/></g><path d="M32.7604 87.4506C32.0233 88.1831 30.8281 88.1831 30.0909 87.4506L8.45288 65.9485C-2.81763 54.7488 -2.81763 36.5904 8.45288 25.3907C8.97709 24.8698 9.827 24.8698 10.3512 25.3907L51.4471 66.2285C52.1843 66.961 52.1843 68.1487 51.4471 68.8813L32.7604 87.4506Z" fill="#B4BCC8"/><path d="M35.3829 43.3719C34.8671 42.8423 34.8732 41.9897 35.3966 41.4677L76.4272 0.544909C77.1632 -0.189157 78.3479 -0.180458 79.0733 0.564338L97.4615 19.4444C98.1869 20.1891 98.1783 21.388 97.4423 22.1221L75.8387 43.669C64.5861 54.892 46.4734 54.759 35.3829 43.3719Z" fill="#8C95A3"/></svg>';n.appendChild(a);t.appendChild(n);e.appendChild(t)}function rt(e){return e?"slide-up"===y?"cb-banner-animate-initial-center-bottom":"slide-down"===y?"cb-banner-animate-initial-center-top":"zoom-in"===y?"cb-banner-animate-initial-center-zoom":"cb-banner-animate-fade":"slide-up"===y?"cb-banner-animate-bottom":"slide-down"===y?"cb-banner-animate-top":"zoom-in"===y?"cb-banner-animate-zoom-in":"cb-banner-animate-fade"}function at(){if(!document.getElementById("cb-initial-banner"))if(document.body){var e="ccpa"===i;var t=document.createElement("div");if(e){var n=document.createElement("div");n.className="cb-banner";n.id="cb-initial-banner";n.style.display="none";var r=document.createElement("div");r.className="cb-banner-body";var a=document.createElement("h3");a.textContent=J("title",k);r.appendChild(a);var o=document.createElement("p");var c=q(W("ccpaDescription")||W("description"),_);if(m&&Y()){o.appendChild(document.createTextNode(c+" "));var s=document.createElement("a");s.textContent=J("privacyPolicy",S);s.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(s,m);o.appendChild(s);o.appendChild(document.createTextNode("."))}else o.textContent=c;r.appendChild(o);var l=document.createElement("p");l.style.marginTop="20px";l.style.marginBottom="0";var d=document.createElement("button");d.id="cb-ccpa-donotsell-link";d.type="button";d.textContent=W("doNotSell");d.style.cssText="background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;text-align:left;display:inline;";l.appendChild(d);r.appendChild(l);n.appendChild(r);Qe(n,"cb-close-initial-btn");t.appendChild(n);var p=document.createElement("div");p.className="cb-banner cb-ccpa-prefs";p.id="cb-preferences-banner";p.style.display="none";"left"===v?p.classList.add("prefs-left"):"right"===v?p.classList.add("prefs-right"):p.classList.add("prefs-center");var b=document.createElement("div");b.className="cb-banner-body";var f=document.createElement("h3");f.textContent=W("optOutPreference");b.appendChild(f);var y=document.createElement("p");var h=(W("ccpaOptOutPreferenceIntro")||W("ccpaOptOut")||"").replace(/s*More info.?s*$/i,"").trim();if(m&&Y()){y.appendChild(document.createTextNode(h+" "));var x=document.createElement("a");x.textContent=W("privacyPolicy");x.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(x,m);y.appendChild(x);y.appendChild(document.createTextNode("."))}else y.textContent=h;y.style.lineHeight="1.45";b.appendChild(y);var C=document.createElement("label");C.style.cssText="display:flex !important;align-items:center !important;gap:10px !important;margin:20px 0 0 0 !important;padding:0 !important;cursor:pointer;font-size:13px !important;font-weight:500 !important;";var w=document.createElement("span");w.style.cssText="flex:1;line-height:1.4 !important;";w.textContent=W("doNotSell");var O=document.createElement("input");O.type="checkbox";O.id="cb-ccpa-optout";O.style.cssText="flex-shrink:0 !important;display:inline-block !important;position:static !important;float:none !important;margin:0 !important;padding:0 !important;width:16px !important;min-width:16px !important;height:16px !important;opacity:1 !important;visibility:visible !important;transform:none !important;clip:auto !important;pointer-events:auto !important;-webkit-appearance:auto !important;appearance:auto !important;";O.checked=!!(cbDNS());C.appendChild(O);C.appendChild(w);b.appendChild(C);p.appendChild(b);var B=document.createElement("div");B.className="cb-banner-footer";var L=document.createElement("button");L.id="cb-cancel-prefs-btn";L.textContent=U("cancel");B.appendChild(L);var A=document.createElement("button");A.id="cb-save-prefs-btn";A.textContent=W("saveMyPreferences")||W("save");B.appendChild(A);p.appendChild(B);nt(p);et(p);t.appendChild(p)}else{var H=function(e){var t=document.createElement("div");t.style.borderBottom="1px solid #e5e7eb";var n=document.createElement("div");n.style.cssText="display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";var r=document.createElement("button");r.type="button";r.setAttribute("aria-expanded","false");r.textContent="+";r.style.cssText="flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";var a=document.createElement("span");a.className="cb-gdpr-cat-label";a.style.cssText="flex:1;font-size:11px;font-weight:600;";a.textContent=e.labelText;n.appendChild(r);n.appendChild(a);var i=document.createElement("div");i.style.flexShrink="0";if(e.alwaysActive){var o=document.createElement("span");o.style.cssText="font-size:11px;font-weight:600;color:#374151;";o.textContent=J("alwaysActive",20);i.appendChild(o)}else{var c=document.createElement("input");c.type="checkbox";c.id=e.checkboxId;e.defaultChecked&&(c.checked=!0);c.style.cssText="position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";var s=document.createElement("button");s.type="button";s.className="cb-pref-toggle-track";s.setAttribute("role","switch");s.setAttribute("aria-label",e.labelText);var l=function(){s.setAttribute("aria-checked",c.checked?"true":"false")};s.addEventListener("click",function(){c.checked=!c.checked;l()});l();i.appendChild(c);i.appendChild(s)}n.appendChild(i);var d=document.createElement("div");d.className="cb-gdpr-cat-desc";d.style.cssText="display:grid;grid-template-rows:0fr;opacity:0;font-size:13px;line-height:1.5;transition:grid-template-rows .3s ease,opacity .25s ease;";var p=document.createElement("div");p.style.cssText="overflow:hidden;min-height:0;padding:0 12px 12px 44px;";p.textContent=e.descText;if(e.gLink){var gl=document.createElement("a");gl.href="https://business.safety.google/privacy/";gl.target="_blank";gl.rel="noopener noreferrer";gl.className="cb-google-privacy-link";gl.textContent=e.gLink;gl.style.cssText="display:block;margin-top:6px;color:inherit;text-decoration:underline;";p.appendChild(gl)}d.appendChild(p);var b=function(e){e.style.gridTemplateRows="1fr";e.style.opacity=""};var f=function(e){e.style.gridTemplateRows="0fr";e.style.opacity="0"};r.addEventListener("click",function(){var e="true"!==r.getAttribute("aria-expanded");var n=t.parentNode;if(n){var a=n.children;for(var i=0;i<a.length;i++){var o=a[i].querySelector(".cb-gdpr-cat-desc");var c=a[i].querySelector("button[aria-expanded]");if(o&&o!==d){f(o);if(c){c.textContent="+";c.setAttribute("aria-expanded","false")}}}}e?b(d):f(d);r.textContent=e?"−":"+";r.setAttribute("aria-expanded",e?"true":"false")});t.appendChild(n);t.appendChild(d);return t};var T=document.createElement("div");T.className="cb-banner";T.id="cb-initial-banner";T.style.display="none";var P=document.createElement("div");P.className="cb-banner-body";var z=document.createElement("h3");z.textContent=W("title");P.appendChild(z);var N=document.createElement("p");var j=W("description");if(m&&Y()){N.appendChild(document.createTextNode(j+" "));var V=document.createElement("a");V.textContent=W("privacyPolicy");V.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(V,m);N.appendChild(V);N.appendChild(document.createTextNode("."))}else N.textContent=j;P.appendChild(N);T.appendChild(P);var M=document.createElement("div");M.className="cb-banner-footer";var D=document.createElement("button");D.id="cb-preferences-btn";D.textContent=q(U("customise"),E);G()&&M.appendChild(D);var F=document.createElement("button");F.id="cb-reject-all-btn";F.textContent=q(U("rejectAll"),E);$()&&M.appendChild(F);var Z=document.createElement("button");Z.id="cb-accept-all-btn";Z.textContent=q(U("acceptAll"),E);M.appendChild(Z);T.appendChild(M);Qe(T,"cb-close-initial-btn");t.appendChild(T);var R=document.createElement("div");R.className="cb-banner";R.id="cb-preferences-banner";R.style.display="none";"left"===v?R.classList.add("prefs-left"):"right"===v?R.classList.add("prefs-right"):R.classList.add("prefs-center");var X=document.createElement("div");X.className="cb-banner-body";var K=document.createElement("h3");K.textContent=J("cookiePreferences",k);X.appendChild(K);var Q=document.createElement("p");var te=(q(W("managePreferences"),_)||"").replace(/s*More info.?s*$/i,"").trim();if(m&&Y()){Q.appendChild(document.createTextNode(te+" "));var ne=document.createElement("a");ne.textContent=J("privacyPolicy",S);ne.style.cssText="color:#007aff;text-decoration:underline;cursor:pointer;";ae(ne,m);Q.appendChild(ne);Q.appendChild(document.createTextNode("."))}else Q.textContent=te;X.appendChild(Q);var re=document.createElement("div");re.className="cb-gdpr-accordion";re.style.cssText="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";var ie=J("strictlyNecessary",20)||J("essential",20);re.appendChild(H({labelText:ie,alwaysActive:!0,descText:J("essentialDescription",300)}));var oe=se()||I&&I.accepted&&I.categories||{};re.appendChild(H({labelText:J("marketing",20),checkboxId:"cb-pref-marketing",defaultChecked:!!oe.marketing,descText:J("marketingDescription",300),gLink:gPL()?gPT():""}));re.appendChild(H({labelText:J("analytics",20),checkboxId:"cb-pref-analytics",defaultChecked:!!oe.analytics,descText:J("analyticsDescription",300)}));re.appendChild(H({labelText:J("preferences",20),checkboxId:"cb-pref-preferences",defaultChecked:!!oe.preferences,descText:J("preferencesDescription",300)}));re.lastChild&&(re.lastChild.style.borderBottom="none");X.appendChild(re);R.appendChild(X);var ce=document.createElement("div");ce.className="cb-banner-footer";var le=document.createElement("button");le.id="cb-prefs-reject-btn";le.textContent=q(U("rejectAll"),E);ce.appendChild(le);var de=document.createElement("button");de.id="cb-save-prefs-btn";de.textContent=q(U("saveMyPreferences")||U("save"),E);ce.appendChild(de);R.appendChild(ce);nt(R);et(R);t.appendChild(R)}document.body.appendChild(t);g&&(document.body.style.overflow="hidden");if(!window.__cbResizeInit){window.__cbResizeInit=!0;window.addEventListener("resize",function(){var e=document.getElementById("cb-initial-banner");e&&"none"!==e.style.display&&"hidden"!==e.style.visibility&&ee(e)})}var pe=document.getElementById("cb-initial-banner");if(pe){var be=ee(pe);pe.style.display="flex";pe.style.visibility="visible";pe.style.opacity="1";u&&pe.classList.add(rt(be))}}else setTimeout(at,100)}function it(){g&&(document.body.style.overflow="")}function ot(){try{if(p&&!1===p.showBannerLogo)return!1;if(p&&0===p.showBannerLogo)return!1;var e=R();var t=TRANSLATIONS.config||{};var n=null!=t.floatingButtonEnabled?t.floatingButtonEnabled:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).floatingButtonEnabled;return!1!==n&&"0"!==n&&"false"!==String(n).toLowerCase()}catch(e){return!0}}function ct(){try{var e=parseInt(localStorage.getItem(L+"_closed")||"0",10);if(!e)return!1;if(ot())return!0;if(Date.now()-e<864e5)return!0;localStorage.removeItem(L+"_closed");return!1}catch(e){return!1}}function st(){try{if(p&&p.bannerLogoPosition)return"right"===p.bannerLogoPosition?"right":"left";var e=R();var t=TRANSLATIONS.config||{};var n;return"right"===(null!=t.floatingButtonPosition?t.floatingButtonPosition:(TRANSLATIONS[e]||TRANSLATIONS.en||{}).floatingButtonPosition)?"right":"left"}catch(e){return"left"}}function lt(){var e="http://www.w3.org/2000/svg";var t=document.createElementNS(e,"svg");t.setAttribute("xmlns",e);t.setAttribute("viewBox","0 0 40 40");t.setAttribute("width","44");t.setAttribute("height","44");t.setAttribute("aria-hidden","true");t.setAttribute("focusable","false");t.style.cssText="display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";var n=document.createElementNS(e,"circle");n.setAttribute("cx","20");n.setAttribute("cy","20");n.setAttribute("r","18");n.setAttribute("fill","#007aff");t.appendChild(n);var r=[{cx:"14",cy:"14",r:"2.2"},{cx:"24",cy:"18",r:"2.5"},{cx:"17",cy:"25",r:"2"}];for(var a=0;a<r.length;a++){var i=document.createElementNS(e,"circle");i.setAttribute("cx",r[a].cx);i.setAttribute("cy",r[a].cy);i.setAttribute("r",r[a].r);i.setAttribute("fill","#ffffff");t.appendChild(i)}return t}function dt(){try{var e=document.getElementsByTagName("script");for(var t=e.length-1;t>=0;t--){var n=e[t].src||"";if(-1!==n.indexOf("/consentbit/")||-1!==n.indexOf("/client_data/"))return new URL(n).origin}}catch(e){}return""}function pt(){if(!document.getElementById("cb-floating-trigger")&&ot()){var e=st();var t=n||"";var a=r||"";if(!t){var i=dt();if(i){t=i+"/embed/floating-logo.svg";a||(a=t)}}var o=document.createElement("button");o.id="cb-floating-trigger";o.type="button";o.setAttribute("aria-label",W("cookiePreferences"));o.style.cssText="position:fixed;bottom:28px;"+("right"===e?"right:16px;":"left:16px;")+"z-index:2147483646;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;";if(t){var c=document.createElement("img");c.alt="";c.src=t;c.setAttribute("width","44");c.setAttribute("height","44");c.draggable=!1;c.style.cssText="display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";var s=!1;c.addEventListener("error",function e(){if(s||!a||t===a){c.removeEventListener("error",e);c.parentNode&&c.parentNode.replaceChild(lt(),c)}else{s=!0;c.src=a}});o.appendChild(c)}else o.appendChild(lt());document.body.appendChild(o)}}function bt(){return u?"left"===v?"zoom-in"===y?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-prefs-left":"right"===v?"zoom-in"===y?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-prefs-right":"slide-up"===y?"cb-banner-animate-center-bottom":"slide-down"===y?"cb-banner-animate-center-top":"zoom-in"===y?"cb-banner-animate-prefs-zoom-in":"cb-banner-animate-fade":""}function ft(e){if(e){var t=F.split(" ");for(var n=0;n<t.length;n++)t[n]&&e.classList.remove(t[n])}}function mt(){Ke();at();pt();var e=document.getElementById("cb-initial-banner");var t=document.getElementById("cb-preferences-banner");var n=document.getElementById("cb-preferences-btn");var r=document.getElementById("cb-accept-all-btn");var a=document.getElementById("cb-reject-all-btn");var o=document.getElementById("cb-prefs-reject-btn");var c=document.getElementById("cb-cancel-prefs-btn");var s=document.getElementById("cb-save-prefs-btn");var l=document.getElementById("cb-ccpa-donotsell-link");var d="ccpa"===i;function p(){if(e){e.style.setProperty("display","none","important");e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade")}if(t){t.style.display="none";ft(t)}var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="flex");it()}function b(){if(e){if(t){t.style.display="none";ft(t)}var n=ee(e);e.style.setProperty("display","flex","important");e.style.setProperty("visibility","visible","important");e.style.setProperty("opacity","1","important");e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade","cb-banner-animate-zoom-in");u&&e.classList.add(rt(n));g&&(document.body.style.overflow="hidden")}}function f(){e.style.display="none";var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="none");t.style.display="flex";t.style.visibility="visible";t.style.opacity="1";ft(t);var r=bt();r&&t.classList.add(r)}var m=document.getElementById("cb-floating-trigger");m&&m.addEventListener("click",function(e){e&&e.preventDefault&&e.preventDefault();e&&e.stopPropagation&&e.stopPropagation();b()});n&&n.addEventListener("click",function(){if(e&&t){if(!d){var n=se()||I&&I.categories||{};var r=function(e,t){var n=document.getElementById(e);if(n){n.checked=!!t;var r=n.parentNode&&n.parentNode.querySelector("button.cb-pref-toggle-track");r&&r.setAttribute("aria-checked",n.checked?"true":"false")}};r("cb-pref-analytics",n.analytics);r("cb-pref-preferences",n.preferences);r("cb-pref-marketing",n.marketing)}e.classList.remove("cb-banner-animate-left","cb-banner-animate-right","cb-banner-animate-top","cb-banner-animate-bottom","cb-banner-animate-fade");f()}});o&&o.addEventListener("click",function(){var e={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!1,preferences:!1,marketing:!1}};De(["analytics","marketing","preferences"]);oe(e);le(e,{status:"rejected"});ce(e.categories);Xe(e.categories,"[PrefsReject]");We(e.categories);p()});var y=document.getElementById("cb-close-initial-btn");var v=document.getElementById("cb-close-prefs-btn");y&&y.addEventListener("click",function(){try{localStorage.setItem(L+"_closed",String(Date.now()))}catch(e){}p()});v&&v.addEventListener("click",function(){try{localStorage.setItem(L+"_closed",String(Date.now()))}catch(e){}p()});d&&l&&l.addEventListener("click",function(){e&&t&&f()});c&&c.addEventListener("click",function(){b()});a&&a.addEventListener("click",function(){if(!d){var e={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!1,preferences:!1,marketing:!1}};De(["analytics","marketing","preferences"]);oe(e);le(e,{status:"rejected"});ce(e.categories);Xe(e.categories,"[Reject]");We(e.categories)}p()});r&&r.addEventListener("click",function(){if(d){var e={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:!1}};oe(e);le(e,{status:"given"});je({analytics:!0,marketing:!0,preferences:!0,essential:!0});$e(!1)}else{var t={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!0,preferences:!0,marketing:!0}};oe(t);le(t,{status:"given"});ce(t.categories);je(t.categories);Xe(t.categories,"[Accept]")}p()});s&&s.addEventListener("click",function(){if(d){var e=document.getElementById("cb-ccpa-optout");var t=!(!e||!e.checked);var n={accepted:!0,timestamp:(new Date).toISOString(),ccpa:{doNotSell:t}};oe(n);le(n,{status:t?"rejected":"given"});t&&De(cbLaw&&cbLaw.optOut||["analytics","marketing","preferences"]);t||je({analytics:!0,marketing:!0,preferences:!0,essential:!0});$e(t)}else{var r=document.getElementById("cb-pref-analytics");var a=document.getElementById("cb-pref-preferences");var i=document.getElementById("cb-pref-marketing");var o={accepted:!0,timestamp:(new Date).toISOString(),categories:{essential:!0,analytics:!(!r||!r.checked),preferences:!(!a||!a.checked),marketing:!(!i||!i.checked)}};var c=[];o.categories.analytics||c.push("analytics");o.categories.marketing||c.push("marketing");o.categories.preferences||c.push("preferences");c.length&&De(c);oe(o);le(o,{status:"partial"});ce(o.categories);je(o.categories);Xe(o.categories,"[Save]");We(o.categories)}p()})}function gt(){mt();var e=document.getElementById("cb-initial-banner");if(e){e.style.display="flex";e.style.visibility="visible";e.style.opacity="1"}var t=document.getElementById("cb-floating-trigger");t&&(t.style.display="none")}function ut(){if("gdpr"===i){qe();if("advanced"===cbGcm&&!window.__cbConsentDefaultSet){xe();he()("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500});window.__cbConsentDefaultSet=!0}if(I.accepted)Xe(I.categories||{},"[Reload]");else{_e({});updateUetConsent({});s&&Ye()}}else if("ccpa"===i){if("off"!==cbGcm&&!window.__cbConsentDefaultSet){xe();he()("consent","default",{analytics_storage:"denied",ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",functionality_storage:"denied",personalization_storage:"denied",security_storage:"granted",wait_for_update:500});window.__cbConsentDefaultSet=!0}s&&Ye();if(!window.__cbGtmInstall||I&&I.accepted)$e(!!(cbDNS()))}if(!window.__CB_WEBFLOW_MODE__)try{je()}catch(e){}try{var cbDenNow=function(){var cbAll=["analytics","marketing","preferences"];return!I||!I.accepted?("gdpr"===((window.__CONSENT_SITE__||{}).bannerType||"gdpr")||cbQcOff?cbAll:[]):I.ccpa?(I.ccpa.doNotSell?(cbLaw&&cbLaw.optOut||cbAll):[]):I.categories?cbAll.filter(function(c){return!I.categories[c]}):[]};var cbDen=cbDenNow();if(cbDen.length){De(cbDen);setTimeout(function(){try{var cbLater=cbDenNow();cbLater.length&&De(cbLater)}catch(e){}},2500)}}catch(e){}if(window.__CB_WEBFLOW_MODE__){mt();if(I.accepted||ct()){var e=document.getElementById("cb-initial-banner");if(e){e.style.setProperty("display","none","important");e.style.setProperty("visibility","hidden","important")}var t=document.getElementById("cb-preferences-banner");t&&t.style.setProperty("display","none","important");var n=document.getElementById("cb-floating-trigger");n&&(n.style.display="flex")}else if(o){var r=document.getElementById("cb-initial-banner");if(r){r.style.display="flex";r.style.setProperty("visibility","visible","important");r.style.setProperty("opacity","1","important")}var a=document.getElementById("cb-floating-trigger");a&&(a.style.display="none")}else{var c=document.getElementById("cb-initial-banner");if(c){c.style.setProperty("display","none","important");c.style.setProperty("visibility","hidden","important")}var l=document.getElementById("cb-floating-trigger");l&&l.style.setProperty("display","none","important")}}else if(o)if(I.accepted||ct()){mt();var d=document.getElementById("cb-floating-trigger");d&&(d.style.display="flex");var p=document.getElementById("cb-initial-banner");if(p){p.style.setProperty("display","none","important");p.style.setProperty("visibility","hidden","important")}}else gt();try{be()}catch(e){}function b(){document.addEventListener("click",function(e){var t=e.target;for(;t&&t!==document.body;){var n=t.hasAttribute&&t.hasAttribute("data-consentbit-trigger");var r=t.hasAttribute&&t.hasAttribute("data-consentbit-banner");if(n||r){e.preventDefault();e.stopPropagation();if(n)try{localStorage.removeItem(L);localStorage.removeItem(L+"_closed");I={accepted:!1,timestamp:null}}catch(e){}var a=document.getElementById("cb-initial-banner");if(a){a.style.display="flex";a.style.visibility="visible";a.style.opacity="1";g&&(document.body.style.overflow="hidden");var i=document.getElementById("cb-floating-trigger");i&&(i.style.display="none");a.scrollIntoView({behavior:"smooth",block:"start"})}else{gt();setTimeout(function(){var e=document.getElementById("cb-initial-banner");e&&e.scrollIntoView({behavior:"smooth",block:"start"})},100)}return!1}t=t.parentElement}},!0)}"loading"===document.readyState?document.addEventListener("DOMContentLoaded",b):b()}}();
${getBannerCookieListScript()}
`;

  // Cross-domain consent (Profile → Advanced settings, handlers/consentFamily.js): linked sites
  // on one main domain share one choice through a cookie on that domain. The bridge
  // (handlers/consentShareBridge.js) runs before the runtime and only reads/writes the
  // runtime's own localStorage entries. '' for every site in no family → script unchanged.
  // Ported from cdnTest.js 2026-11-24.
  let consentShare = await consentShareForBanner(db, resolvedSite).catch((e) => {
    console.warn('[ConsentShare] family lookup failed:', e?.message);
    return null;
  });
  // Plan rules (2026-11-27, same as cdnTest.js): sharing needs the MAIN domain on Growth —
  // main domain downgraded or cancelled → no bridge for the whole group (links stay saved).
  // A linked site off Growth under two-way only receives (served as one-way).
  if (consentShare) {
    const primaryGrowth = consentShare.isPrimary
      ? effectivePlanId === 'growth'
      : await siteServesGrowth(db, env, consentShare.primary);
    if (!primaryGrowth) consentShare = null;
    else if (!consentShare.isPrimary && effectivePlanId !== 'growth' && consentShare.direction === 'two_way') {
      consentShare = { ...consentShare, direction: 'one_way' };
    }
  }
  // IAB/TCF banners share too (bridge mode 'iab': the TCF runtime's cookieConsentPrefs storage).
  // Same pick as serveKind below (banner_type iab on Essential/Growth). Ported from cdnTest.js
  // 2026-11-27; IAB choices are only ever shared between IAB banners (bridge `compatible`).
  const shareIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab' &&
    (effectivePlanId === 'growth' || effectivePlanId === 'essential');
  const shareBridge = consentShare
    ? consentShareBridge({
        siteId: String(resolvedSite.id),
        primaryId: consentShare.primaryId,
        isPrimary: consentShare.isPrimary,
        root: consentShare.root,
        direction: consentShare.direction,
        bannerType: shareIab ? 'iab' : String(effectiveBannerType || 'gdpr').toLowerCase(),
        apiBase,
        expiryDays: Number(customization?.cookieExpirationDays) || 30,
        mode: shareIab ? 'iab' : undefined,
        // Ported from cdnTest.js 2026-11-27 (live had subdomains only):
        //   cats   — cookie categories this site uses; a shared choice that didn't cover all of
        //            them is not reused, so the banner asks again.
        //   xhosts — linked sites on a DIFFERENT main domain (seattlenewmedia.com ↔ consentbit.com):
        //            no shared cookie reaches them, so the choice is handed over on links to them.
        cats: (() => {
          const c = ['analytics', 'marketing', 'preferences'].filter((k) => Array.isArray(cookieList?.[k]) && cookieList[k].length > 0);
          return c.length ? c : null;
        })(),
        xhosts: (consentShare.xhosts || []).filter(
          (h) => h && h !== String(resolvedSite.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(),
        ),
        // Cross-domain consent section 4 ("Tell visitors which sites are covered"): the switch
        // turns the "Your choice also applies to …" line on/off; listUrl adds "See all sites".
        // Ported from cdnTest.js 2026-11-26 (was missing here, so the line never showed live).
        notice: consentShare.showList === false ? null : {
          hosts: consentShare.hosts.filter((h) => h && h !== String(resolvedSite.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase()),
          url: consentShare.listUrl || '',
          lang: String(customization?.resolvedLanguage || customization?.language || 'en'),
          auto: customization?.autoDetectLanguage === true || customization?.autoDetectLanguage === 1,
        },
      })
    : '';
  const consentShareSig = consentShare
    ? `${consentShare.primaryId}.${consentShare.direction}.${consentShare.hosts.length}.${(consentShare.xhosts || []).length}.${consentShare.showList === false ? 'n' : 'y'}${consentShare.listUrl ? [...consentShare.listUrl].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36) : ''}`
    : '';

  const SCRIPT_VERSION = '2026-11-05-prefs-design';
  const customizationUpdatedAt = customization?.updatedAt || customization?.updated_at || '';
  const translationsSig = await (async () => {
    try {
      const tr = customization?.translations;
      if (!tr) return '';
      const s = typeof tr === 'string' ? tr : JSON.stringify(tr);
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
      return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  })();
  // "Disable banner on pages" (webapp Cookie Banner → Settings, handlers/bannerPages.js):
  // owner pages apply on Growth only; other plans keep just the hard-coded SKIP_PATHS_BY_SITE.
  const pagesSite = effectivePlanId === 'growth' ? resolvedSite : null;
  const pagesSig = skipPathsSignature(resolvedSite.id, pagesSite);
  const etag = `"${resolvedSite.id}-${resolvedSite.updatedAt || ''}-${customizationUpdatedAt}-${translationsSig}-${cookieListSig}-${SCRIPT_VERSION}${pagesSig ? '-' + pagesSig : ''}${consentShareSig ? `-cs${consentShareSig}` : ''}${bannerRegionActive ? `-r${outsideBannerRegion ? 'none' : effectiveBannerType}` : ''}"`;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }
function remToPx(rem, baseFontSize = 16) {
  return rem * baseFontSize;
}

const banerBr=remToPx(parseFloat(customization?.bannerBorderRadius) || 12);
const isGoogleAc = enTrans?.isGoogleAc === true || enTrans?.isGoogleAc === 1 || enTrans?.isGoogleAc === '1' || String(enTrans?.isGoogleAc || '').toLowerCase() === 'true';

  // First-layer GVL text, fetched here so the banner paints it in the right
  // language on the first frame instead of showing English until the GVL lands.
  // Only for sites that actually serve the IAB banner — a GDPR/CCPA site must not
  // pay for these subrequests. Best-effort: on failure this returns empty values
  // and the banner fills the spans itself, exactly as before.
  // With auto-detect on, the language is a client-side decision the server cannot
  // see, so fall back to Accept-Language — in practice it agrees with
  // navigator.language. A mismatch only costs the flicker we already had today;
  // it can never render the wrong language for longer than the GVL takes to load.
  const gvlBakeLang = siteConfigPayload?.customization?.autoDetectLanguage === true
    ? (request.headers.get('Accept-Language') || '').split(',')[0].trim()
    : (siteConfigPayload?.customization?.resolvedLanguage || 'en');
  const gvlPrefetch = String(resolvedSite.banner_type || '').toLowerCase() === 'iab'
    ? await prefetchGvlBannerText(gvlBakeLang, isGoogleAc)
    : null;
const loaderIab=`
${inlineConfig}
${getLoaderIabScript(customization, { rawPos: customization?.position || 'bottom-left', bannerLayoutVisual: enTrans?.bannerLayoutVisual, textAlign: (typeof textAlign !== 'undefined' && (textAlign === 'center' || textAlign === 'right')) ? textAlign : 'left', bannerEntranceAnimation: siteConfigPayload?.customization?.bannerEntranceAnimation, hideBranding: siteConfigPayload?.customization?.hideBranding === true, gvlPrefetch }, isGoogleAc)}
`

  const loaderCore = loader.replace(inlineConfig, '');
  const loaderWebflow = `${inlineConfig}${getWebflowSetupScript()}
` + loaderCore;

  const loaderIabCore = loaderIab.replace(inlineConfig, '');
  const loaderIabWebflow = `${inlineConfig}${getWebflowSetupScript()}
(function(){function _cbInstallTcfBridge(){if(!window.__tcfapi){setTimeout(_cbInstallTcfBridge,150);return;}try{window.__tcfapi('addEventListener',2,function(a,b){if(!b)return;if(a.eventStatus==='useractioncomplete'||a.eventStatus==='tcloaded'){var c=!!(a.purpose&&a.purpose.consents&&a.purpose.consents[1]);var d={essential:true,analytics:c,marketing:c,preferences:c};window.userConsent=d;try{document.dispatchEvent(new CustomEvent('consentUpdated',{detail:d,bubbles:true}));}catch(e){}}});}catch(e){}}_cbInstallTcfBridge();})();
` + loaderIabCore;

  const iabAllowed = effectivePlanId === 'growth' || effectivePlanId === 'essential';
  const wantsIab = String(resolvedSite.banner_type || '').toLowerCase() === 'iab';
  const rawIsWebflow = String(resolvedSite.platform || '').toLowerCase() === 'webflow';
  const isWebflowV2 = rawIsWebflow && String(resolvedSite.version || '').toLowerCase() === 'v2';
  const isWebflow = rawIsWebflow && !isWebflowV2;
  const serveKind = (wantsIab && iabAllowed && isWebflow) ? 'iabwebflow'
    : (wantsIab && iabAllowed) ? 'iab'
    : isWebflow ? 'webflow'
    : 'standard';
  const why = {
    wantsIab,
    iabAllowed,
    isWebflow,
    isWebflowV2,
    version: resolvedSite.version || null,
    plan: effectivePlanId,
    orgId: orgIdForDebug,
    subscriptionStatus: subStatusForDebug,
    siteId: resolvedSite.id,
    cdnScriptId: resolvedSite.cdnScriptId,
    bannerType: resolvedSite.banner_type,
    regionMode: resolvedSite.region_mode,
    platform: resolvedSite.platform,
    bannerEnabled,
  };
  const bannerIsCcpa = String(effectiveBannerType || '').toLowerCase() === 'ccpa';

  // Microsoft issued ConsentBit CMP ID 165. Sent as a NUMBER, not a string: the
  // integration guide writes `source: <your-cmp-id>` unquoted while quoting the
  // storage values, so JSON.stringify() below must emit 165 rather than "165".
  const clarityCmpSource = siteConfigPayload.clarityCmpId || 165;
  const clarityBootstrap = siteConfigPayload.clarityConsentMode === false ? '' :
    `try{` +
    `window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments);};` +
    `var ca=c?(e?'denied':'granted'):(d&&d.analytics?'granted':'denied');` +
    `var cm=c?(e?'denied':'granted'):(d&&d.marketing?'granted':'denied');` +
    `window.clarity('consentv2',{source:${JSON.stringify(clarityCmpSource)},ad_Storage:cm,analytics_Storage:ca});` +
    `window.__cbClaritySignal=cm+'|'+ca;` +
    `}catch(_){}`;
  // Microsoft UET Consent Mode default, emitted alongside the Clarity signal and before
  // the gtag work for the same reasons. This one is load-bearing for a different reason
  // too: UET assumes ad_storage GRANTED when it finds no default at all, so the default
  // has to be queued before bat.js can run — which is what makes it safe for the loader
  // to stop blocking the UET tag. GDPR: default denied, then the stored decision as an
  // update. CCPA (opt-out): default granted unless the visitor opted out. Sets the same
  // __cbUetSignal fingerprint updateUetConsent() dedupes against.
  const uetBootstrap = siteConfigPayload.uetConsentMode === false ? '' :
    `try{` +
    `window.uetq=window.uetq||[];` +
    `var ua=c?(e?'denied':'granted'):(d&&d.marketing?'granted':'denied');` +
    `window.uetq.push('consent','default',{ad_storage:c?ua:'denied'});` +
    `if(!c&&ua==='granted')window.uetq.push('consent','update',{ad_storage:'granted'});` +
    `window.__cbUetSignal=ua;` +
    `}catch(_){}`;
  // The hoist at the end moves every queued gtag('consent', ...) command to the front of
  // dataLayer while gtag.js has not yet processed the queue (push is still Array.prototype.push).
  // Webflow's built-in Google Analytics integration queues gtag('js') + gtag('config') ABOVE our
  // tag, so without it config ran with no consent state: _ga, _gcl_au, Ads remarketing and Xandr
  // fired before any choice (Monitaur, 2026-09-17, measured in a real browser).
  // Google part of the bootstrap. Advanced (default) = exactly the previous bootstrap. Basic
  // and Off (gcmMode, see above) send nothing to Google before consent; the GTM-template
  // install (window.__cbGtmInstall) keeps Advanced because the template sets its own defaults.
  const gcmBootAdvanced = `window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};window.gtag('set','ads_data_redaction',true);window.gtag('set','url_passthrough',true);window.gtag('set','developer_id.dN2Q3Yj',true);var g=window.__cbConsentDefaultSet===true;if(!c){if(!g){window.gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',functionality_storage:'denied',personalization_storage:'denied',security_storage:'granted',wait_for_update:500});}if(d){window.gtag('consent','update',{analytics_storage:d.analytics?'granted':'denied',ad_storage:d.marketing?'granted':'denied',ad_user_data:d.marketing?'granted':'denied',ad_personalization:d.marketing?'granted':'denied',functionality_storage:d.preferences?'granted':'denied',personalization_storage:d.preferences?'granted':'denied'});}}else if(!g){window.gtag('consent','default',{ad_storage:e?'denied':'granted',analytics_storage:e?'denied':'granted',ad_user_data:e?'denied':'granted',ad_personalization:e?'denied':'granted',functionality_storage:e?'denied':'granted',personalization_storage:e?'denied':'granted',security_storage:'granted'});}${outsideBannerRegion ? "if(!e){window.gtag('consent','update',{ad_storage:'granted',analytics_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',functionality_storage:'granted',personalization_storage:'granted'});}" : ''}try{var L=window.dataLayer;if(L&&L.push===Array.prototype.push){var h=[],r=[];for(var k=0;k<L.length;k++){var it=L[k];(it&&it[0]==='consent'?h:r).push(it);}if(h.length&&r.length&&L[0]!==h[0]){L.length=0;Array.prototype.push.apply(L,h.concat(r));}}}catch(_){}window.__cbConsentDefaultSet=true;`;
  // Basic, returning visitor who accepted Analytics or Marketing: publish the stored choice
  // as the consent default (before the released Google tags run), then hoist it. Opt-out
  // (CCPA) visitors have nothing to accept first, so they get the Advanced block.
  const gcmBootBasicGdpr = `window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};window.gtag('set','ads_data_redaction',true);window.gtag('set','url_passthrough',true);window.gtag('set','developer_id.dN2Q3Yj',true);if(window.__cbConsentDefaultSet!==true){window.gtag('consent','default',{ad_storage:d.marketing?'granted':'denied',analytics_storage:d.analytics?'granted':'denied',ad_user_data:d.marketing?'granted':'denied',ad_personalization:d.marketing?'granted':'denied',functionality_storage:d.preferences?'granted':'denied',personalization_storage:d.preferences?'granted':'denied',security_storage:'granted'});}try{var L=window.dataLayer;if(L&&L.push===Array.prototype.push){var h=[],r=[];for(var k=0;k<L.length;k++){var it=L[k];(it&&it[0]==='consent'?h:r).push(it);}if(h.length&&r.length&&L[0]!==h[0]){L.length=0;Array.prototype.push.apply(L,h.concat(r));}}}catch(_){}window.__cbConsentDefaultSet=true;`;
  const gcmBoot = gcmMode === 'off'
    ? `if(window.__cbGtmInstall){${gcmBootAdvanced}}`
    : gcmMode === 'basic'
      ? `if(window.__cbGtmInstall||c){${gcmBootAdvanced}}else if(hasStored&&d&&(d.analytics||d.marketing)){${gcmBootBasicGdpr}}`
      : gcmBootAdvanced;
  const consentModeBootstrap = `(function(){try{var c=${bannerIsCcpa ? 'true' : 'false'};var d=null,e=false,hasStored=false,sg=false;try{for(var i=0;i<localStorage.length;i++){var w=localStorage.key(i);if(w&&w.indexOf('consentbit_prefs_')===0){try{var x=localStorage.getItem(w);if(x){d=JSON.parse(atob(x));break;}}catch(_){}}}}catch(_){}try{for(var i=0;i<localStorage.length;i++){var w=localStorage.key(i);if(w&&w.indexOf('consentbit_')===0&&w.indexOf('consentbit_prefs_')!==0){try{var v=JSON.parse(localStorage.getItem(w));if(v&&v.accepted){hasStored=true;if(v.gpc)sg=true;if(!d&&v.categories)d=v.categories;if(v.ccpa&&v.ccpa.doNotSell)e=true;break;}}catch(_){}}}}catch(_){}try{if(navigator.globalPrivacyControl===true&&c&&!(hasStored&&sg)){e=true;}}catch(_){}${quebecDefaultOff ? "if(c&&!hasStored){e=true;}" : ""}${clarityBootstrap}${uetBootstrap}${gcmBoot}}catch(_){}})();\n`;

  // "off" pages stop the script before anything runs; "hide" pages only hide the banner +
  // floating button (IAB has its own element list). Both '' when the site has no such pages.
  const pageHideGuard = buildHidePathGuard(pagesSite);
  const pageHideGuardIab = buildHidePathGuard(pagesSite, { iab: true });
  const scriptToServe =
    buildSkipPathGuard(resolvedSite.id, pagesSite) +
    getDebugModeScript({ consoleOnly: gcmDebugConsole }) +
    (serveKind === 'iab' ? (pageHideGuardIab + shareBridge + loaderIab) : serveKind === 'iabwebflow' ? (pageHideGuardIab + shareBridge + loaderIabWebflow) : serveKind === 'webflow' ? (pageHideGuard + shareBridge + loaderWebflow) : (pageHideGuard + shareBridge + consentModeBootstrap + loader));


  return new Response(scriptToServe, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'ETag': etag,
      'X-ConsentBit-Loader': serveKind,
      'X-ConsentBit-Plan': String(effectivePlanId || 'free'),
      'X-ConsentBit-IabAllowed': iabAllowed ? '1' : '0',
      'X-ConsentBit-OrgId': orgIdForDebug ? String(orgIdForDebug) : 'none',
      'X-ConsentBit-Webflow': isWebflow ? '1' : '0',
      // Geo debug: the country Cloudflare saw for THIS request (VPN "virtual" locations
      // often resolve elsewhere) and the geo-target verdict. The visitor's own data only.
      'X-ConsentBit-Country': `${country || 'none'}${regionCode ? '-' + regionCode : ''}${isEU ? ' eu' : ''}`,
      'X-ConsentBit-RegionalLang': (regionalActive || (lawFixes && regionalLanguages && planAllowsPaidRegions && iabBundleServed))
        ? `qc=${regionalLanguages.quebec ? 1 : 0} br=${regionalLanguages.brazil ? 1 : 0} lang=${langOverride || iabLangOverride || '-'}${iabBundleServed ? ' iab' : ''}`
        : 'off',
      'X-ConsentBit-Banner': `${effectiveBannerType} enabled=${bannerEnabled ? 1 : 0}${bannerRegionActive ? (outsideBannerRegion ? ' region=outside' : ' region=shown') : ''}`,
      // Page languages: off | plan | iab | regional | none | <codes shipped>
      'X-ConsentBit-PageLangs': pageLangStatus,
    },
  });
}