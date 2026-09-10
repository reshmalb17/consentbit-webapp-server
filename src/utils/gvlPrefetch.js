/**
 * Server-side prefetch of the GVL values the IAB banner's first layer displays.
 *
 * The opening paragraph names every TCF purpose, every special feature, and the
 * number of disclosed vendors. All three come from the Global Vendor List, which
 * the browser can only fetch *after* the banner has painted — so on a non-English
 * banner the first frame shows English purpose names and a placeholder vendor
 * count, then visibly swaps about a second later once the GVL lands.
 *
 * Baking the values into the served script makes that first paint correct. The
 * client-side updateDynamicCounts() still runs and still overwrites these spans;
 * it just writes near-identical text over itself, so nothing visibly changes.
 *
 * Every fetch here is best-effort. Any failure — network, timeout, bad JSON —
 * yields empty values, the banner falls back to exactly its previous behaviour,
 * and the script is still served. Nothing in this module may throw.
 */

const GVL_BASE = 'https://weathered-surf-ae57.narendra-3c5.workers.dev/gvl';
const ATP_LIST_URL = 'https://ancient-wind-15ae.narendra-3c5.workers.dev/gac/atp-list.json';

// Cloudflare edge-cache TTL for these subrequests. The GVL publishes weekly at
// most and the numbers move by a handful of vendors, so a day is conservative —
// and any drift is corrected client-side within a second anyway.
const CACHE_TTL_SECONDS = 86400;

// Hard ceiling per request. Serving the banner must never wait on the GVL: if a
// fetch is slow we drop it and fall back rather than delay the consent script.
const TIMEOUT_MS = 1500;

/**
 * Counting the vendors means parsing vendor-list.json, which is a couple of MB.
 * That is real CPU on a cache miss (roughly once a day per edge location), so it
 * is isolated behind this flag: turn it off and the purpose names are still baked
 * — the vendor count simply keeps expanding from its placeholder as it does today.
 */
const BAKE_VENDOR_COUNT = true;

// Mirrors SUPPORTED_LANGUAGES in Tcfmanager.js. Clamping here keeps an unexpected
// code from costing a subrequest that would only 404.
const SUPPORTED_LANGUAGES = ['en', 'nl', 'fr', 'de', 'it', 'pl', 'pt', 'es', 'sv'];

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

/**
 * GVL declaration maps are keyed by numeric id. Order matters — the banner lists
 * these names in id order, the same order updateDynamicCounts() produces from
 * Object.values(), so the baked text matches what replaces it.
 */
function namesInIdOrder(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
    .map((id) => {
      const entry = map[String(id)];
      return entry && typeof entry.name === 'string' ? entry.name : null;
    })
    .filter(Boolean);
}

/**
 * Fetch the first-layer GVL text for one language.
 *
 * @param {string} lang     two-letter code, already resolved by the caller
 * @param {boolean} withAtp include the Google Additional Consent partner count
 * @returns {Promise<{purposeNames: string[], specialFeatureNames: string[], vendorCount: number, atpCount: number}>}
 */
export async function prefetchGvlBannerText(lang, withAtp = false) {
  const empty = { purposeNames: [], specialFeatureNames: [], vendorCount: 0, atpCount: 0 };

  try {
    const raw = String(lang || 'en').trim().toLowerCase().split(/[-_]/)[0];
    const code = SUPPORTED_LANGUAGES.includes(raw) ? raw : 'en';

    const [purposes, vendorList, atpList] = await Promise.all([
      fetchJson(GVL_BASE + '/purposes-' + code + '.json'),
      BAKE_VENDOR_COUNT ? fetchJson(GVL_BASE + '/vendor-list.json') : Promise.resolve(null),
      withAtp ? fetchJson(ATP_LIST_URL) : Promise.resolve(null),
    ]);

    // Exclude vendors IAB has withdrawn — the banner counts the same way.
    let vendorCount = 0;
    if (vendorList && vendorList.vendors && typeof vendorList.vendors === 'object') {
      vendorCount = Object.keys(vendorList.vendors).filter((id) => {
        const v = vendorList.vendors[id];
        return v && !v.deletedDate;
      }).length;
    }

    const atpCount = (atpList && Array.isArray(atpList.providers)) ? atpList.providers.length : 0;

    return {
      purposeNames: namesInIdOrder(purposes && purposes.purposes),
      specialFeatureNames: namesInIdOrder(purposes && purposes.specialFeatures),
      vendorCount,
      atpCount,
    };
  } catch (e) {
    console.warn('[CDN] GVL prefetch failed; banner will fill its own spans', e);
    return empty;
  }
}
