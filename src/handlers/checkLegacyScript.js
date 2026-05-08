// handlers/checkLegacyScript.js
const FETCH_TIMEOUT_MS = 12000;

/**
 * Extract the raw HTML inside <head>...</head> (case-insensitive).
 * Returns empty string if not found.
 */
function extractHead(html) {
  const start = html.search(/<head[\s>]/i);
  if (start === -1) return '';
  const end = html.search(/<\/head>/i);
  if (end === -1) return html.slice(start);
  return html.slice(start, end);
}

/**
 * Check whether a ConsentBit script tag for the given site is present in headHtml.
 *
 * Webflow script:
 *   <script src="https://app.consentbit.com/api/v2/cdn/runtime/{cdnScriptId}.js" ...>
 *
 * Framer script:
 *   <script src="https://consentbit-public.pages.dev/consentbit.js" data-site-id="{siteId}" ...>
 */
function scriptFoundInHead(headHtml, { legacySource, cdnScriptId, siteId }) {
  const lower = headHtml.toLowerCase();

  if (legacySource === 'webflow') {
    if (!cdnScriptId) return false;
    // Only the legacy CDN runtime URL counts as verified for legacy sites
    const pattern = `/api/v2/cdn/runtime/${cdnScriptId.toLowerCase()}.js`;
    return lower.includes(pattern);
  }

  if (legacySource === 'framer') {
    const hasFramerSrc = lower.includes('consentbit-public.pages.dev/consentbit.js');
    if (!hasFramerSrc) return false;
    if (!siteId) return true; // src found, no id to match against
    return lower.includes(`data-site-id="${siteId.toLowerCase()}"`) ||
           lower.includes(`data-site-id='${siteId.toLowerCase()}'`);
  }

  return false;
}

export async function handleCheckLegacyScript(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { domain, legacySource, cdnScriptId, siteId } = body || {};

  if (!domain || !legacySource) {
    return Response.json({ success: false, error: 'domain and legacySource are required' }, { status: 400 });
  }

  const url = domain.startsWith('http') ? domain : `https://${domain}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html;
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'ConsentBit-ScriptChecker/1.0' },
    });
    if (!resp.ok) {
      return Response.json({
        success: false,
        found: false,
        inHead: false,
        error: `Site returned HTTP ${resp.status}`,
      });
    }
    html = await resp.text();
  } catch (err) {
    if (err?.name === 'AbortError') {
      return Response.json({ success: false, found: false, inHead: false, error: 'Request timed out' });
    }
    return Response.json({ success: false, found: false, inHead: false, error: err?.message || 'Fetch failed' });
  } finally {
    clearTimeout(timer);
  }

  const headHtml = extractHead(html);
  const inHead = scriptFoundInHead(headHtml, { legacySource, cdnScriptId, siteId });

  // Also check full page (for framer where script may be anywhere)
  const inBody = !inHead && scriptFoundInHead(html, { legacySource, cdnScriptId, siteId });

  // Extract all script src values from head for debugging
  const scriptSrcs = [...headHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
  return Response.json({
    success: true,
    found: inHead || inBody,
    inHead,
  });
}
