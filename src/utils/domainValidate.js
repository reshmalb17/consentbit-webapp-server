/**
 * Normalize domain to hostname for comparison (lowercase, no www, no path).
 */
export function normalizeHostname(domain) {
  if (!domain || typeof domain !== 'string') return '';
  let host = domain.trim().toLowerCase();
  try {
    if (!host.startsWith('http://') && !host.startsWith('https://')) {
      host = 'https://' + host;
    }
    const u = new URL(host);
    host = u.hostname || host;
  } catch (_) {
    host = host.split('/')[0].split(':')[0];
  }
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

/**
 * Get the origin hostname from the request (Origin or Referer header).
 */
export function getRequestOriginHostname(request) {
  const origin = request.headers.get('Origin') || request.headers.get('Referer') || '';
  if (!origin) return '';
  try {
    const u = new URL(origin);
    let host = (u.hostname || '').toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch (_) {
    return '';
  }
}

/**
 * Return true if the request is from a domain that matches the site's allowed domain.
 * Prevents script from working when copied to another site (domain binding).
 */
export function requestDomainMatchesSite(site, request) {
  const allowed = normalizeHostname(site.domain);
  const actual = getRequestOriginHostname(request);
  if (!allowed || !actual) return false;
  return actual === allowed;
}

// ── Staging hosts vs. the customer's own domain ──────────────────────────────
//
// A site is often registered with the site builder's staging URL (foo.webflow.io)
// and only later gets a real domain attached to the SAME script. Staging hosts
// live on vendor-owned domains, so "matches none of these suffixes" is a reliable
// test for "this is the customer's own domain".
//
// Nothing here decides on its own that a host BELONGS to a site — a copied embed
// sends exactly the same headers as the real one. It only tells us which hosts
// are already on file and which are worth proving via services/domainResolver.js.

const STAGING_HOST_SUFFIXES = [
  '.webflow.io',
  '.framer.website',
  '.framer.app',
  '.framer.media',
  '.wixsite.com',
  '.myshopify.com',
  '.squarespace.com',
  '.pages.dev',
  '.vercel.app',
  '.netlify.app',
  '.github.io',
];

export function isStagingHost(raw) {
  const h = normalizeHostname(raw);
  if (!h) return false;
  return STAGING_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** host === allowed, or a subdomain of it. */
export function hostMatches(host, allowed) {
  const h = normalizeHostname(host);
  const a = normalizeHostname(allowed);
  if (!h || !a) return false;
  return h === a || h.endsWith(`.${a}`);
}

/** Every host a Site row already knows about, including additionalDomains. */
export function siteKnownHosts(site) {
  if (!site) return [];
  const raw = [
    site.domain,
    site.stagingUrl ?? site.stagingurl,
    site.customDomain ?? site.customdomain,
  ];
  const extra = site.additionalDomains ?? site.additionaldomains;
  if (extra) {
    try {
      const parsed = JSON.parse(extra);
      if (Array.isArray(parsed)) raw.push(...parsed);
    } catch (_) {}
  }
  return [...new Set(raw.map(normalizeHostname).filter(Boolean))];
}

/**
 * Decide what to do with an incoming host.
 *
 *   { allowed: true,  candidate: null }  → already on file, serve it
 *   { allowed: false, candidate: host }  → unknown, but worth proving ownership
 *   { allowed: false, candidate: null }  → not ours, block (unchanged behaviour)
 *
 * `candidate` is a QUESTION, never an answer. Only services/domainResolver.js,
 * which checks the host against the platform's own records, may act on it.
 */
export function authorizeRequestHost(site, rawHost, options = {}) {
  const host = normalizeHostname(rawHost);
  // No Origin/Referer at all — nothing to judge. Unchanged: such requests pass.
  if (!host) return { allowed: true, candidate: null, reason: 'no-host' };

  for (const known of siteKnownHosts(site)) {
    if (hostMatches(host, known)) return { allowed: true, candidate: null, reason: 'known-host' };
  }

  const stagingHint = normalizeHostname(options.stagingHost || '');
  if (stagingHint && hostMatches(host, stagingHint)) {
    return { allowed: true, candidate: null, reason: 'kv-staging' };
  }

  // Pre-existing rule: Webflow staging previews are always let through, even for
  // sites registered under their custom domain. Kept as-is.
  if (host.endsWith('.webflow.io')) {
    return { allowed: true, candidate: null, reason: 'webflow-staging' };
  }

  // A real-looking host on a platform whose records we can check. Worth asking
  // the platform about — but not worth trusting yet.
  const platform = String(site?.platform || '').toLowerCase();
  if (!isStagingHost(host) && (platform === 'webflow' || platform === 'framer')) {
    return { allowed: false, candidate: host, reason: 'unproven-host' };
  }

  return { allowed: false, candidate: null, reason: 'not-authorized' };
}
