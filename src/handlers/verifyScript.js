// handlers/verifyScript.js
import { markSiteVerified } from '../services/db.js';
const VERIFY_PAGE_FETCH_TIMEOUT_MS = 12000;

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

function normalizeIdSet(pathId, bodySiteId) {
  const out = new Set();
  if (pathId && String(pathId).trim()) out.add(String(pathId).trim());
  if (bodySiteId != null && String(bodySiteId).trim() !== '') {
    out.add(String(bodySiteId).trim());
  }
  return [...out];
}

/**
 * True if this script tag is the ConsentBit embed for one of the allowed site ids
 * (cdnScriptId in path and/or Site.id from the dashboard).
 */
function scriptOpenTagMatchesSite(attrsRaw, expectedSiteIds) {
  const ids = Array.isArray(expectedSiteIds)
    ? expectedSiteIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [String(expectedSiteIds || '').trim()].filter(Boolean);
  if (ids.length === 0) return { match: false, reason: 'no_expected_site_id' };

  const attrs = attrsRaw || '';
  let src = getAttrFromTagAttrs(attrs, 'src');
  src = decodeHtmlAttrMinimal(src);
  const idAttr = getAttrFromTagAttrs(attrs, 'id');
  const siteFromAttr =
    getAttrFromTagAttrs(attrs, 'siteid') ||
    getAttrFromTagAttrs(attrs, 'data-site-id') ||
    getAttrFromTagAttrs(attrs, 'data_site_id');

  if (siteFromAttr) {
    const ok = ids.some(
      (id) => id.toLowerCase() === siteFromAttr.toLowerCase(),
    );
    if (!ok) return { match: false, reason: 'site_attr_mismatch' };
  }

  let pathForExtract = src;
  try {
    pathForExtract = new URL(src, 'https://placeholder.local/').pathname;
  } catch (e) {
    pathForExtract = src;
  }
  const idFromSrc =
    extractSiteIdFromPathOrUrl(pathForExtract) || extractSiteIdFromPathOrUrl(src);

  if (
    idFromSrc &&
    ids.some((id) => id.toLowerCase() === idFromSrc.toLowerCase())
  ) {
    return { match: true, how: 'src_site_id', idFromSrc };
  }

  if (idAttr) {
    const idLower = idAttr.toLowerCase();
    for (const exp of ids) {
      const expLower = exp.toLowerCase();
      if (
        idLower === 'consentbit' &&
        idFromSrc &&
        idFromSrc.toLowerCase() === expLower
      ) {
        return { match: true, how: 'legacy_id_consentbit', idFromSrc };
      }
      if (
        idLower.includes(expLower) &&
        src &&
        src.toLowerCase().includes(expLower)
      ) {
        return { match: true, how: 'banner_id_and_src' };
      }
    }
  }

  return {
    match: false,
    reason: 'no_matching_src_or_id',
    idFromSrc: idFromSrc || null,
  };
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERIFY_PAGE_FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(publicUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'ConsentBit-Verifier/1.0' },
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const fetchedUrl = resp.url || publicUrl;

    if (!resp.ok) {
      console.warn('[VerifyScript] fetch failed', {
        status: resp.status,
        publicUrl,
        fetchedUrl,
      });
      let friendlyError;
      if (resp.status === 403 || resp.status === 401) {
        friendlyError = 'Your site is blocking automated requests. Please add the script to your site first, then click Verify again from your browser.';
      } else if (resp.status === 404) {
        friendlyError = 'Page not found. Please check the domain is correct and the site is live.';
      } else if (resp.status >= 500) {
        friendlyError = 'Your site returned a server error. Please ensure your site is live and try again.';
      } else {
        friendlyError = `Could not reach your site (HTTP ${resp.status}). Please ensure the domain is correct and publicly accessible.`;
      }
      return Response.json(
        { success: false, error: friendlyError },
        { status: 502 },
      );
    }

    const html = await resp.text();
    const htmlLower = html.toLowerCase();

    const idFromPath = extractSiteIdFromPathOrUrl(scriptUrl);
    const idFromBody =
      siteId != null && String(siteId).trim() !== ''
        ? String(siteId).trim()
        : null;
    const expectedSiteIds = normalizeIdSet(idFromPath, idFromBody);

    if (expectedSiteIds.length === 0) {
      console.warn('[VerifyScript] no site id from path or body', {
        scriptUrl: scriptUrl.substring(0, 160),
        siteId: siteId ?? null,
      });
      return Response.json({
        success: true,
        found: false,
        siteId: null,
        error:
          'Cannot verify: provide siteId or a scriptUrl containing /client_data/{id}/script.js, /consentbit/{id}/script.js, or /runtime/{id}.js',
        debug: {
          idFromPath: idFromPath || null,
          idFromBody: idFromBody || null,
        },
      });
    }

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
    const perTag = [];
    let matchedTag = null;
    for (let i = 0; i < attrStrings.length; i++) {
      const r = scriptOpenTagMatchesSite(attrStrings[i], expectedSiteIds);
      const srcRaw = getAttrFromTagAttrs(attrStrings[i], 'src');
      perTag.push({
        index: i,
        srcSnippet: (decodeHtmlAttrMinimal(srcRaw) || '').slice(0, 200),
        result: r,
      });
      if (r.match && !matchedTag) {
        matchedTag = { index: i, ...r };
      }
    }

    const found = Boolean(hasExactInstallString || matchedTag);

    const scriptSrcSamples = perTag.map((p) => p.srcSnippet).filter(Boolean);

    const debugPayload = {
      expectedSiteIds,
      idFromPath: idFromPath || null,
      idFromBody: idFromBody || null,
      hasExactInstallString,
      matchedTag,
      fetchedUrl,
      requestedUrl: publicUrl,
      htmlLength: html.length,
      scriptOpenTagCount: attrStrings.length,
      scriptSrcSamples: scriptSrcSamples.slice(0, 15),
      perTag: perTag.slice(0, 20),
      scriptUrlPreview: scriptUrl.substring(0, 160),
    };

    console.log(
      '[VerifyScript] result',
      JSON.stringify({
        found,
        ...debugPayload,
        perTag: debugPayload.perTag?.length,
      }),
    );

    if (!found) {
      console.warn('[VerifyScript] not found — check expectedSiteIds vs script tags on page', {
        expectedSiteIds,
        hasExactInstallString,
        sampleSrcs: scriptSrcSamples.slice(0, 5),
      });
    }

    if (found && siteId) {
      await markSiteVerified(db, siteId, scriptUrl);
    }

    return Response.json({
      success: true,
      found,
      siteId: siteId || null,
      debug: debugPayload,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return Response.json(
        {
          success: false,
          found: false,
          error: `Verification timed out after ${Math.round(VERIFY_PAGE_FETCH_TIMEOUT_MS / 1000)}s. Try again or verify a faster public URL.`,
        },
        { status: 504 },
      );
    }
    console.error('[VerifyScript] error', err);
    return Response.json(
      { success: false, error: err?.message || 'Verification error' },
      { status: 500 },
    );
  }
}
