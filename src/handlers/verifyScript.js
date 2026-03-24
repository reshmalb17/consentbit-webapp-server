// handlers/verifyScript.js
import { markSiteVerified } from '../services/db.js';

/**
 * Extract ConsentBit site / script id from embed URL path (dashboard or runtime CDN).
 */
function extractSiteIdFromPathOrUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let path = s;
  try {
    path = new URL(s).pathname;
  } catch (e) {
    // keep as-is (relative path)
  }
  const m1 = path.match(/\/client_data\/([^/]+)\/script\.js/i);
  const m2 = path.match(/\/consentbit\/([^/]+)\/script\.js/i);
  const m3 = path.match(/\/runtime\/([^/.?#]+)\.js/i);
  if (m1) return m1[1];
  if (m2) return m2[1];
  if (m3) return m3[1];
  return null;
}

function getAttrFromTagAttrs(attrs, name) {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const m = attrs.match(re);
  if (!m) return '';
  return (m[2] || m[3] || m[4] || '').trim();
}

function collectScriptOpenTagAttrStrings(html) {
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] || '');
  }
  return out;
}

function decodeHtmlAttrMinimal(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * True if this script tag is the ConsentBit embed for expectedSiteId (src + optional id/site attrs).
 */
function scriptOpenTagMatchesSite(attrsRaw, expectedSiteId) {
  const exp = String(expectedSiteId || '').trim();
  if (!exp) return { match: false, reason: 'no_expected_site_id' };

  const attrs = attrsRaw || '';
  let src = getAttrFromTagAttrs(attrs, 'src');
  src = decodeHtmlAttrMinimal(src);
  const idAttr = getAttrFromTagAttrs(attrs, 'id');
  const siteFromAttr =
    getAttrFromTagAttrs(attrs, 'siteid') ||
    getAttrFromTagAttrs(attrs, 'data-site-id') ||
    getAttrFromTagAttrs(attrs, 'data_site_id');

  if (siteFromAttr && siteFromAttr.toLowerCase() !== exp.toLowerCase()) {
    return { match: false, reason: 'site_attr_mismatch' };
  }

  let pathForExtract = src;
  try {
    pathForExtract = new URL(src, 'https://placeholder.local/').pathname;
  } catch (e) {
    pathForExtract = src;
  }
  const idFromSrc = extractSiteIdFromPathOrUrl(pathForExtract) || extractSiteIdFromPathOrUrl(src);

  if (idFromSrc && idFromSrc.toLowerCase() === exp.toLowerCase()) {
    return { match: true, how: 'src_site_id' };
  }

  // e.g. id="consentbit-banner-{siteId}-..." — must still tie to same site as src when src present
  if (idAttr) {
    const idLower = idAttr.toLowerCase();
    const expLower = exp.toLowerCase();
    if (idLower === 'consentbit' && idFromSrc && idFromSrc.toLowerCase() === expLower) {
      return { match: true, how: 'legacy_id_consentbit' };
    }
    if (idLower.includes(expLower) && src && src.toLowerCase().includes(expLower)) {
      return { match: true, how: 'banner_id_and_src' };
    }
  }

  return { match: false, reason: 'no_matching_src_or_id' };
}

export async function handleVerifyScript(request, env) {
  const db = env.CONSENT_WEBAPP;

  let body = null;

  try {
    body = await request.json();
  } catch (e) {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const publicUrl = body?.publicUrl?.trim() || '';
  const scriptUrl = body?.scriptUrl?.trim() || '';
  const siteId = body?.siteId;

  if (!publicUrl || !scriptUrl) {
    return Response.json(
      { success: false, error: 'publicUrl and scriptUrl are required' },
      { status: 400 },
    );
  }

  try {
    const resp = await fetch(publicUrl, { redirect: 'follow' });

    if (!resp.ok) {
      return Response.json(
        {
          success: false,
          error: 'Failed to fetch page: ' + resp.status + ' ' + resp.statusText,
        },
        { status: 502 },
      );
    }

    const html = await resp.text();
    const htmlLower = html.toLowerCase();

    // Embed URL uses cdnScriptId in the path; dashboard may send internal Site.id — prefer id from scriptUrl for HTML match.
    let expectedSiteId = extractSiteIdFromPathOrUrl(scriptUrl);
    if (
      !expectedSiteId &&
      siteId != null &&
      String(siteId).trim() !== ''
    ) {
      expectedSiteId = String(siteId).trim();
    }

    if (!expectedSiteId) {
      return Response.json({
        success: true,
        found: false,
        siteId: null,
        error:
          'Cannot verify: provide siteId or a scriptUrl containing /client_data/{id}/script.js, /consentbit/{id}/script.js, or /runtime/{id}.js',
      });
    }

    // Exact install string (what we show in the dashboard) — strongest match
    const scriptUrlLower = scriptUrl.toLowerCase();
    const scriptUrlNoProtocol = scriptUrl.replace(/^https?:\/\//i, '').toLowerCase();
    let scriptPathOnly = scriptUrl;
    try {
      const u = new URL(scriptUrl);
      scriptPathOnly = u.pathname + u.search;
    } catch (e) {}

    const hasExactInstallString =
      htmlLower.includes(scriptUrlLower) ||
      htmlLower.includes(scriptUrlNoProtocol) ||
      htmlLower.includes(String(scriptPathOnly).toLowerCase());

    const attrStrings = collectScriptOpenTagAttrStrings(html);
    let matchedTag = null;
    for (let i = 0; i < attrStrings.length; i++) {
      const r = scriptOpenTagMatchesSite(attrStrings[i], expectedSiteId);
      if (r.match) {
        matchedTag = { index: i, ...r };
        break;
      }
    }

    const found = Boolean(hasExactInstallString || matchedTag);

    // Do not treat "HEAD ok on script URL" or generic id="consentbit" alone as proof (removed).

    console.log('[VerifyScript]', {
      found,
      expectedSiteId,
      hasExactInstallString,
      matchedTag,
      publicUrl: publicUrl.substring(0, 80),
    });

    if (found && siteId) {
      await markSiteVerified(db, siteId, scriptUrl);
    }

    return Response.json({
      success: true,
      found,
      siteId: siteId || null,
      debug: {
        expectedSiteId,
        hasExactInstallString,
        matchedTag,
        scriptUrl: scriptUrl.substring(0, 120),
        publicUrl,
      },
    });
  } catch (err) {
    return Response.json(
      { success: false, error: err?.message || 'Verification error' },
      { status: 500 },
    );
  }
}
