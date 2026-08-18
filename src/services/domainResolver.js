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
      const hit = domains.customDomains.find((d) => hostMatches(host, d));
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
