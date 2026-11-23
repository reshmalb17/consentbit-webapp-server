// src/data/neverBlockBySite.js
// Vendors the banner must NEVER block on a given site, keyed by Site.id.
// Server-side only: the vendor is removed from the block rules served to that site
// (scriptBlockProviders + the site's custom cookie rules), so the runtime has nothing to
// match it with. Every other site is unaffected.
//
// Keywords are matched case-insensitively against each alternative of a provider pattern
// ('hotjar\\.com|posthog\\.com|app\\.posthog' → the posthog parts are dropped).

export const NEVER_BLOCK_BY_SITE = {
  // accounts.consentbit.com — our own dashboard (consentbitwebapp). PostHog is our product
  // analytics there; the banner is on it only to test cross-domain consent (2026-11-19).
  'dafe59ee-d1f3-442d-83db-0652bbe3c821': ['posthog'],
};

/** Block providers with the given vendor keywords removed. Providers left empty are dropped. */
export function stripVendorsFromProviders(providers, keywords) {
  if (!keywords?.length) return providers;
  const kws = keywords.map((k) => String(k).toLowerCase());
  const out = [];
  for (const p of providers || []) {
    const parts = String(p?.pattern || '').split('|').filter((alt) => !kws.some((k) => alt.toLowerCase().includes(k)));
    if (parts.length) out.push({ ...p, pattern: parts.join('|') });
  }
  return out;
}

/** Custom cookie / script rules that do not mention any of the vendor keywords. */
export function stripVendorsFromRules(rules, keywords) {
  if (!keywords?.length) return rules;
  const kws = keywords.map((k) => String(k).toLowerCase());
  return (rules || []).filter((r) => {
    const text = JSON.stringify(r || {}).toLowerCase();
    return !kws.some((k) => text.includes(k));
  });
}
