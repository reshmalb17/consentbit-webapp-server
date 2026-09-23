// Drops the paid-only banner features when a site's plan no longer includes them.
//
// "Both regions" (GDPR+CCPA geo-routing) and the IAB TCF banner are Essential/Growth
// only. A downgrade used to reset them in ONE place — Site.region_mode / banner_type —
// but the Designer app does not read its selection from there. It reads the saved
// banner customization, so on the next launch the app happily showed CCPA+GDPR / IAB
// again and re-saved it, undoing the clamp. The selection lives in three stores and
// all three have to agree:
//
//   1. D1  Site.region_mode / Site.banner_type          -> what cdnM.js serves
//   2. D1  BannerCustomization.translations             -> what the Designer app loads
//        .en.compliance = 'GDPR' | 'CCPA' | 'BOTH'
//        .en.isIab / .en.iab_enabled / .config.isIab ...
//   3. KV  Banner-Settings:{platformSiteId}.appData.compliance
//        -> takes precedence over (1) in the GET, so leaving it at ['gdpr','us']
//           alone was enough to bring the old selection back
//
// Every step is separately guarded: this is bookkeeping that runs after Stripe has
// already charged, so a failure here must never fail the caller. cdnM.js still clamps
// at serve time, which stays the real enforcement.

const PAID_REGION_PLANS = ['essential', 'growth'];

export function planAllowsPaidRegions(planId) {
  return PAID_REGION_PLANS.includes(String(planId || 'free').trim().toLowerCase());
}

const parseJson = (raw) => {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
};

// Turn off every IAB/GAC flag this project writes, in whichever of the two blocks
// (config / en) is present. Returns true when something actually changed.
function disableIabFlags(block) {
  if (!block || typeof block !== 'object') return false;
  let changed = false;
  for (const key of ['isIab', 'iab_enabled', 'isGoogleAc', 'googleAdditionalConsent']) {
    if (block[key] === true || block[key] === 'true' || block[key] === 1 || block[key] === '1') {
      block[key] = false;
      changed = true;
    }
  }
  return changed;
}

/**
 * Reset a site to GDPR-only / non-IAB when its plan excludes those features.
 * No-op for essential/growth, and for a site already on gdpr.
 *
 * @returns {Promise<{clamped: boolean, stores: string[]}>} which stores were rewritten
 */
export async function clampSiteToPlanEntitlements(env, db, { siteId, planId, logger } = {}) {
  const note = typeof logger === 'function' ? logger : () => {};
  const stores = [];
  if (!db || !siteId) return { clamped: false, stores };
  if (planAllowsPaidRegions(planId)) return { clamped: false, stores };

  const now = new Date().toISOString();

  // Resolve the real Site row first: callers pass either the D1 id or the Webflow
  // site id, and the KV key needs platformSiteId either way.
  let site = null;
  try {
    site = await db
      .prepare('SELECT id, platformSiteId, region_mode, banner_type FROM Site WHERE id = ?1 OR platformSiteId = ?1 LIMIT 1')
      .bind(siteId)
      .first();
  } catch (err) {
    note(`clamp: Site lookup failed (${err?.message || err})`);
    return { clamped: false, stores };
  }
  if (!site) return { clamped: false, stores };

  // 1. Site flags — what the CDN serves.
  try {
    const res = await db
      .prepare(
        `UPDATE Site
            SET region_mode = CASE WHEN lower(region_mode) = 'both' THEN 'gdpr' ELSE region_mode END,
                banner_type = CASE WHEN lower(banner_type) = 'iab' THEN 'gdpr' ELSE banner_type END,
                updatedAt = ?1
          WHERE id = ?2
            AND (lower(region_mode) = 'both' OR lower(banner_type) = 'iab')`,
      )
      .bind(now, site.id)
      .run();
    if ((res?.meta?.changes ?? 0) > 0) stores.push('Site');
  } catch (err) {
    note(`clamp: Site update failed (${err?.message || err})`);
  }

  // 2. Saved customization — what the Designer app loads on launch. This is the one
  //    that was missing: without it the app re-selected CCPA+GDPR / IAB every relaunch.
  try {
    const row = await db
      .prepare('SELECT translations FROM BannerCustomization WHERE siteId = ?1 LIMIT 1')
      .bind(site.id)
      .first();
    const translations = parseJson(row?.translations);
    if (translations && typeof translations === 'object') {
      let changed = false;
      if (translations.en && typeof translations.en === 'object') {
        const comp = String(translations.en.compliance || '').toUpperCase();
        if (comp === 'BOTH') { translations.en.compliance = 'GDPR'; changed = true; }
        if (disableIabFlags(translations.en)) changed = true;
      }
      if (disableIabFlags(translations.config)) changed = true;
      if (changed) {
        await db
          .prepare('UPDATE BannerCustomization SET translations = ?1 WHERE siteId = ?2')
          .bind(JSON.stringify(translations), site.id)
          .run();
        stores.push('BannerCustomization');
      }
    }
  } catch (err) {
    note(`clamp: BannerCustomization update failed (${err?.message || err})`);
  }

  // 3. KV Banner-Settings — read BEFORE D1 in the customization GET, so it has the
  //    final say on what the app shows.
  try {
    const wfSiteId = site.platformSiteId || null;
    if (wfSiteId && env?.WEBFLOW_AUTHENTICATION) {
      const kvKey = `Banner-Settings:${wfSiteId}`;
      const entry = await env.WEBFLOW_AUTHENTICATION.get(kvKey, { type: 'json' });
      const appData = entry?.appData;
      if (appData && Array.isArray(appData.compliance)) {
        const hadUs = appData.compliance.some((c) => {
          const v = String(c || '').toLowerCase();
          return v === 'us' || v === 'ccpa' || v === 'both';
        });
        if (hadUs) {
          appData.compliance = ['gdpr'];
          await env.WEBFLOW_AUTHENTICATION.put(
            kvKey,
            JSON.stringify({ ...entry, appData, updatedAt: now }),
          );
          stores.push('KV');
        }
      }
    }
  } catch (err) {
    note(`clamp: KV update failed (${err?.message || err})`);
  }

  if (stores.length) note(`plan ${planId} excludes both-regions/IAB — reset ${stores.join(' + ')} to gdpr`);
  return { clamped: stores.length > 0, stores };
}
