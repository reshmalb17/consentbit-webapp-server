// src/services/domainResolver.js
//
// "This site is registered as foo.webflow.io, but a request just arrived from
//  example.com. Is that the same site?"
//
// The request itself cannot answer that. The embed is a plain <script> tag, so
// anyone who copies it onto their own page sends byte-identical Origin/Referer
// headers and the same cdnScriptId. Trusting the requester would let a copier
// bind THEIR domain to someone else's site — locking the real custom domain out
// of its own script and charging its pageviews to the wrong customer.
//
// So the request only ever proposes a candidate. Binding requires proof from the
// platform, which the copier does not control:
//
//   Webflow — GET /v2/sites/{id} lists the project's custom domains AND its
//             staging subdomain. The call is the same one
//             handlers/webflowPublish.js already makes. It both DISCOVERS and
//             PROVES, so one lookup settles both hosts at once.
//
//   Framer  — every published Framer page carries Framer's own project id:
//               <script src="https://events.framer.com/script?v=2" data-fid="...">
//             Fetch a host we already trust for this site and the candidate; if
//             the fids match it is the same Framer project. There is no Framer
//             API to list domains, so here the request is needed to DISCOVER the
//             candidate — the fid is what PROVES it.
//
// Note what is deliberately NOT used as proof: "the candidate page serves our
// cdnScriptId". A copied embed passes that trivially. It shows the script is
// deployed there, not that the domain belongs to the customer.

import { resolveWebflowOAuthToken, setSiteCustomDomain, setSiteStagingUrl } from './db.js';
import { normalizeHostname, isStagingHost, hostMatches, siteKnownHosts } from '../utils/domainValidate.js';

const TAG = '[domain-resolver]';
const FETCH_TIMEOUT_MS = 8000;

// Per-isolate throttle. Without it, a burst of traffic from an unknown host
// would fire one Webflow API call (or two page fetches) per request while the
// first is still in flight. Keyed by site+host so a genuine second domain is not
// held up behind a failed lookup for a different one.
const ATTEMPTS = new Map();
const RETRY_AFTER_MS = 10 * 60 * 1000;
const ATTEMPTS_MAX = 500;

function shouldAttempt(siteId, host) {
  const key = `${siteId}|${host}`;
  const last = ATTEMPTS.get(key);
  if (last && Date.now() - last < RETRY_AFTER_MS) return false;
  if (ATTEMPTS.size > ATTEMPTS_MAX) ATTEMPTS.clear();
  ATTEMPTS.set(key, Date.now());
  return true;
}

// ── Webflow ─────────────────────────────────────────────────────────────────

/**
 * The domains Webflow itself reports for a project.
 * Returns { subdomain, customDomains: [host] } or null when unavailable
 * (no OAuth token, revoked token, API down) — never throws.
 */
export async function resolveWebflowSiteDomains(db, env, platformSiteId) {
  if (!platformSiteId) return null;

  let token = null;
  try {
    const row = await resolveWebflowOAuthToken(db, env.WEBFLOW_AUTHENTICATION, platformSiteId);
    token = row?.accessToken || null;
  } catch (e) {
    console.warn(`${TAG} token lookup failed for ${platformSiteId}: ${e?.message || e}`);
  }
  if (!token) return null;

  try {
    const res = await fetch(`https://api.webflow.com/v2/sites/${platformSiteId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`${TAG} webflow site lookup ${platformSiteId} -> HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const customDomains = Array.isArray(data.customDomains)
      ? data.customDomains.map((d) => normalizeHostname(d.url || d.name)).filter(Boolean)
      : [];
    const subdomain = data.shortName ? `${data.shortName}.webflow.io` : null;
    return { subdomain, customDomains };
  } catch (e) {
    console.warn(`${TAG} webflow site lookup failed ${platformSiteId}: ${e?.message || e}`);
    return null;
  }
}

// ── Framer ──────────────────────────────────────────────────────────────────

/**
 * Framer's own project id for a host, read out of the published page.
 * Same extraction as handlers/adminBackfillFramerSiteId.js.
 */
export async function resolveFramerSiteId(host) {
  const h = normalizeHostname(host);
  if (!h) return null;
  try {
    const res = await fetch(`https://${h}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConsentBit/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(
      /<script[^>]*src="https:\/\/events\.framer\.com\/script\?v=2"[^>]*data-fid="([^"]+)"/i
    );
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * True when both hosts are published from the same Framer project.
 * A copier who pasted our embed onto their own Framer site gets their own fid,
 * so they fail this; a host serving no Framer script at all fails it too.
 */
export async function verifyFramerSameSite(knownHost, candidateHost) {
  const [knownFid, candidateFid] = await Promise.all([
    resolveFramerSiteId(knownHost),
    resolveFramerSiteId(candidateHost),
  ]);
  if (!knownFid || !candidateFid) return false;
  return knownFid === candidateFid;
}

// ── Translated copies (Weglot and similar, any platform) ────────────────────

/**
 * Is `candidateHost` serving a translated copy of `site`?
 *
 * Translation tools mark the translated page with the original it came from.
 * On Coeo's en.coeo.events (Weglot) the raw HTML carries:
 *   <link href="https://www.coeo.events/" hreflang="sv" rel="alternate">
 *   <script id="weglot-data">{"originalCanonicalUrl":"https://www.coeo.events/", ...}
 *   <html ... data-wf-site="68496f4a3585a13831ea2697">
 * The ORIGINAL page carries none of these in its raw HTML (Weglot adds them
 * client-side), so all checks run on the candidate page only.
 *
 * Proof required:
 *   1. The page points back to a host already on file for this site — via an
 *      hreflang alternate link or the Weglot original URL.
 *   2. Where the platform stamps its own project id, it matches:
 *      Webflow data-wf-site === site.platformSiteId; Framer data-fid equal to
 *      the fid on a host already on file. This rules out a different site that
 *      merely links to this one.
 *
 * Never throws. Returns { translated, reason }.
 */
export async function detectTranslatedCopy(site, candidateHost) {
  const host = normalizeHostname(candidateHost);
  const known = siteKnownHosts(site).filter((h) => h !== host);
  if (!host || !known.length) return { translated: false, reason: 'no-known-host' };

  // Only a SUBDOMAIN of the licensed domain can be a covered translation
  // (en.coeo.events for coeo.events). A translation on a separate domain
  // (coeo.de) needs its own licence — decided 2026-10-14. Checked before any fetch.
  if (!known.some((k) => hostMatches(host, k))) {
    return { translated: false, reason: 'not-same-domain' };
  }

  let html = '';
  try {
    const res = await fetch(`https://${host}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConsentBit/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { translated: false, reason: `http-${res.status}` };
    // A redirect off the candidate (e.g. to the original site) is not a copy.
    if (normalizeHostname(res.url) !== host) return { translated: false, reason: 'redirected' };
    html = await res.text();
  } catch (_) {
    return { translated: false, reason: 'fetch-failed' };
  }

  const pointsTo = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\bhreflang\s*=/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (href) pointsTo.push(href[1]);
  }
  const weglotOriginal = html.match(/"originalCanonicalUrl"\s*:\s*"([^"]+)"/);
  if (weglotOriginal) pointsTo.push(weglotOriginal[1].replace(/\\\//g, '/'));

  const pointsBack = pointsTo
    .map(normalizeHostname)
    .some((h) => h && h !== host && known.includes(h));
  if (!pointsBack) return { translated: false, reason: 'no-link-to-original' };

  const platform = String(site?.platform || '').toLowerCase();
  if (platform === 'webflow') {
    const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
    const pageSiteId = html.match(/<html\b[^>]*\bdata-wf-site\s*=\s*["']([^"']+)["']/i)?.[1] || null;
    if (!platformSiteId || pageSiteId !== platformSiteId) {
      return { translated: false, reason: 'webflow-site-id-mismatch' };
    }
  } else if (platform === 'framer') {
    const pageFid = html.match(
      /<script[^>]*src="https:\/\/events\.framer\.com\/script\?v=2"[^>]*data-fid="([^"]+)"/i
    )?.[1] || null;
    const knownFid = pageFid ? await resolveFramerSiteId(known[0]) : null;
    if (!pageFid || pageFid !== knownFid) {
      return { translated: false, reason: 'framer-fid-mismatch' };
    }
  }

  return { translated: true, reason: 'translated-copy' };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Try to prove `candidateHost` belongs to `site`, and record it if so.
 *
 * Returns { matched, customDomain, stagingUrl, source, checked, reason }:
 *   matched === true means the host is now authorized for this site — the caller
 *   may serve it immediately without waiting for the next request.
 *
 * Both hosts are recorded, not just the new one: the platform hands back the
 * staging subdomain in the same answer, and a site registered under its custom
 * domain has never had its staging URL on file at all.
 *
 * Never throws: a resolver failure must not turn into a failed page load.
 */
export async function trackCustomDomain(db, env, site, candidateHost, options = {}) {
  const result = await trackPlatformDomain(db, env, site, candidateHost, options);
  // Not on the platform's own records — it may still be a translated copy of the
  // site (Weglot etc.). Never recorded here: the caller decides, once it knows
  // the plan, whether the licence covers it (LANGUAGE_DOMAIN_PLANS).
  if (!result.matched && result.checked && result.reason !== 'error') {
    try {
      const copy = await detectTranslatedCopy(site, candidateHost);
      if (copy.translated) {
        result.translated = true;
        result.reason = copy.reason;
      } else {
        result.reason = `${result.reason}|${copy.reason}`;
      }
    } catch (_) {}
  }
  return result;
}

async function trackPlatformDomain(db, env, site, candidateHost, options = {}) {
  const host = normalizeHostname(candidateHost);
  const siteId = site?.id;
  const result = {
    matched: false, customDomain: null, stagingUrl: null,
    source: null, checked: false, reason: '',
  };

  if (!db || !siteId || !host) {
    result.reason = 'missing-input';
    return result;
  }
  if (isStagingHost(host)) {
    result.reason = 'candidate-is-staging';
    return result;
  }
  if (!options.force && !shouldAttempt(siteId, host)) {
    result.reason = 'throttled';
    return result;
  }

  result.checked = true;
  const platform = String(site.platform || '').toLowerCase();
  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;

  try {
    if (platform === 'webflow') {
      const domains = await resolveWebflowSiteDomains(db, env, platformSiteId);
      if (!domains) {
        result.reason = 'webflow-unavailable';
        return result;
      }
      // Match on the whole list, not just the candidate: the visitor may have
      // arrived on the second domain of a multi-domain project, and every one of
      // them serves this same script.
      // Exact match: a subdomain of one of the project's domains is not on the
      // project unless Webflow lists it itself.
      const hit = domains.customDomains.find((d) => normalizeHostname(d) === host);
      if (!hit) {
        console.warn(`${TAG} ${host} is NOT a domain of webflow site ${platformSiteId} (site ${siteId})`);
        result.reason = 'not-on-platform';
        return result;
      }
      const primary = domains.customDomains[0];
      await setSiteCustomDomain(db, siteId, primary, {
        source: 'webflow_api',
        additionalDomains: domains.customDomains.slice(1),
        overwrite: options.overwrite === true,
      });
      // Webflow returned the staging subdomain in the same response — record it
      // while we have it, so both hosts are on file from one lookup.
      const staging = domains.subdomain || (isStagingHost(site.domain) ? normalizeHostname(site.domain) : null);
      if (staging) {
        await setSiteStagingUrl(db, siteId, staging, { overwrite: options.overwrite === true })
          .catch(() => false);
        result.stagingUrl = staging;
      }
      result.matched = true;
      result.customDomain = primary;
      result.source = 'webflow_api';
      result.reason = 'webflow-api-confirmed';
      return result;
    }

    if (platform === 'framer') {
      // Compare against a host already on file for this site — normally the
      // staging URL it was registered with.
      const knownHost = siteKnownHosts(site)[0];
      if (!knownHost) {
        result.reason = 'no-known-host';
        return result;
      }
      const same = await verifyFramerSameSite(knownHost, host);
      if (!same) {
        console.warn(`${TAG} ${host} does not share a Framer project with ${knownHost} (site ${siteId})`);
        result.reason = 'fid-mismatch';
        return result;
      }
      await setSiteCustomDomain(db, siteId, host, {
        source: 'framer_fid',
        overwrite: options.overwrite === true,
      });
      // The host we proved against is the staging URL whenever it looks like one
      // — that is the pair we just confirmed shares a Framer project.
      if (isStagingHost(knownHost)) {
        await setSiteStagingUrl(db, siteId, knownHost, { overwrite: options.overwrite === true })
          .catch(() => false);
        result.stagingUrl = knownHost;
      }
      result.matched = true;
      result.customDomain = host;
      result.source = 'framer_fid';
      result.reason = 'framer-fid-confirmed';
      return result;
    }

    // Every other platform: no authoritative record exists to check against, so
    // there is nothing that would distinguish the real domain from a copied
    // embed. Left blocked, exactly as before.
    result.reason = `unsupported-platform:${platform || 'none'}`;
    return result;
  } catch (e) {
    console.warn(`${TAG} tracking failed for site ${siteId} host ${host}: ${e?.message || e}`);
    result.reason = 'error';
    return result;
  }
}
