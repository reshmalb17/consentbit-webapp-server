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
