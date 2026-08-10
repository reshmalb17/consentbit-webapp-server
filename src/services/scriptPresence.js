// src/services/scriptPresence.js
//
// "Is the ConsentBit script still on this site?"
//
// Used by services/subscriptionEndSweep.js once a subscription's paid period has
// lapsed, to tell apart a customer who removed the banner from one who is still
// serving it after they stopped paying.
//
// This is deliberately SEPARATE from handlers/verifyScript.js. That one answers
// "did the operator install the embed we just gave them", is driven by a request
// carrying an expected scriptUrl, and writes verified/verified_at. This one runs
// unattended against whatever the site looks like today, has only the database
// row to go on, and must recognise EVERY generation of the embed — including the
// ones the current app no longer hands out.
//
// Detection is layered, strongest signal first:
//   1. the site's own cdnScriptId / Site.id appears in a script src   → certain
//   2. a script src points at a known ConsentBit host                 → certain
//   3. an inline script BODY references a ConsentBit endpoint         → certain
//   4. a script carries a known ConsentBit id attribute               → likely
//
// Layer 3 matters more than it looks: the oldest embed is an inline loader that
// fetches https://api.consentbit.com/consent.js at runtime, so there is no src
// attribute to match at all. Scanning only src= would report those sites as
// "removed" when the banner is in fact still running.

/**
 * Hosts that only ever serve ConsentBit. A script src on any of these is ours,
 * whichever generation of the embed produced it.
 */
const CONSENTBIT_HOSTS = [
  'api.consentbit.com',
  'app.consentbit.com',
  'cdn.consentbit.com',
  'manager.consentbit.com',
  'consent-webapp-manager.web-8fb.workers.dev',
];

/**
 * Substrings identifying a ConsentBit script hosted somewhere shared, where the
 * host alone is not conclusive. Kept in step with CB_URL_MARKERS in
 * handlers/webflowScriptCleanup.js — that list is the record of every embed the
 * old and new apps have injected.
 */
const CONSENTBIT_URL_MARKERS = [
  'cdn.jsdelivr.net/gh/reshmalb17/', // all old-app jsdelivr repos (cmp_script, cmp_script_V2, …)
  'gh/seattlenewmedia/consentbit-public', // hosted consent.js repo
  'consentbitstyle.css',
  'consentbit.css',
];

/** Path shapes the workers serve the per-site script from. */
const CONSENTBIT_PATH_MARKERS = ['/client_data/', '/consentbit/', '/consentv2/', '/api/v2/cdn/runtime/'];

/** id="" values the embeds have used, oldest first. Lower-cased for matching. */
const CONSENTBIT_SCRIPT_IDS = [
  'consentbit',
  'consentbitbanner',
  'appscript',
  'consentscript2025',
  'consentscriptv22025',
  'consentscriptversion22025',
  'consentscriptversion312025',
];

const FETCH_TIMEOUT_MS = 15000;

/** A browser UA — some hosts serve a challenge page to obviously-robotic clients. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36 ConsentBit-ScriptCheck/1.0';

/**
 * The URL to check for a site: the customer-facing address if there is one,
 * otherwise the platform domain. Returns null when the row has neither.
 */
export function checkUrlForSite(site) {
  const raw = String(site?.customDomain || site?.domain || '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

/** Every `<script …>` open tag with the raw body that follows it. */
function collectScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ attrs: m[1] || '', body: m[2] || '' });
  }
  // Self-closing / unterminated tags carry no body but still have a src.
  const openOnly = /<script\b([^>]*)\/>/gi;
  while ((m = openOnly.exec(html)) !== null) {
    out.push({ attrs: m[1] || '', body: '' });
  }
  return out;
}

function attr(attrs, name) {
  const m = String(attrs || '').match(
    new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  );
  return m ? (m[2] || m[3] || m[4] || '').trim() : '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function hostOf(src) {
  try {
    return new URL(src, 'https://placeholder.local/').hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Does this one script tag belong to ConsentBit?
 * `siteIds` are the site's own identifiers (cdnScriptId, Site.id) — a match on
 * one of those is the strongest possible signal, so it is reported separately.
 */
function classifyScript({ attrs, body }, siteIds) {
  const src = decodeEntities(attr(attrs, 'src'));
  const srcLower = src.toLowerCase();
  const idLower = attr(attrs, 'id').toLowerCase();

  if (src) {
    for (const id of siteIds) {
      if (id && srcLower.includes(String(id).toLowerCase())) {
        return { match: true, how: 'site_id_in_src', strong: true };
      }
    }
    const host = hostOf(src);
    if (CONSENTBIT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return { match: true, how: 'consentbit_host', strong: true };
    }
    if (CONSENTBIT_URL_MARKERS.some((mk) => srcLower.includes(mk))) {
      return { match: true, how: 'known_script_url', strong: true };
    }
    if (CONSENTBIT_PATH_MARKERS.some((mk) => srcLower.includes(mk))) {
      return { match: true, how: 'consentbit_path', strong: true };
    }
  }

  // Inline loaders — the oldest embed fetches api.consentbit.com/consent.js from
  // inside the tag, so there is no src to inspect.
  if (body) {
    const bodyLower = body.toLowerCase();
    if (
      CONSENTBIT_HOSTS.some((h) => bodyLower.includes(h)) ||
      CONSENTBIT_URL_MARKERS.some((mk) => bodyLower.includes(mk))
    ) {
      return { match: true, how: 'inline_loader', strong: true };
    }
    for (const id of siteIds) {
      if (id && bodyLower.includes(String(id).toLowerCase())) {
        return { match: true, how: 'site_id_inline', strong: true };
      }
    }
  }

  if (idLower && CONSENTBIT_SCRIPT_IDS.includes(idLower)) {
    return { match: true, how: 'known_script_id', strong: false };
  }

  return { match: false };
}

/** The `<head>` slice of a document, or '' when there is no parseable head. */
function headOf(html) {
  const m = String(html).match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i);
  return m ? m[1] : '';
}

/**
 * Look for the ConsentBit script on one URL.
 *
 * Returns { ok, status, found, inHead, how, error }.
 *   ok:false  → the page could not be read at all. Says NOTHING about the
 *               script; the caller must not treat it as a removal on its own.
 *   ok:true   → the page was read. `found` is then a real answer.
 */
export async function checkScriptOnUrl(url, siteIds = []) {
  const ids = (Array.isArray(siteIds) ? siteIds : [siteIds]).filter(Boolean);

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, found: false, inHead: false, error: err?.message || 'fetch failed' };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, found: false, inHead: false, error: `HTTP ${res.status}` };
  }

  let html = '';
  try {
    html = await res.text();
  } catch (err) {
    return { ok: false, status: res.status, found: false, inHead: false, error: 'body unreadable' };
  }
  if (!html || html.length < 40) {
    return { ok: false, status: res.status, found: false, inHead: false, error: 'empty document' };
  }

  // Check the head first so we can report WHERE it was found, then the whole
  // document — a script in the body still means the banner is installed.
  const head = headOf(html);
  for (const [scope, source] of [
    ['head', head],
    ['document', html],
  ]) {
    if (!source) continue;
    for (const tag of collectScripts(source)) {
      const verdict = classifyScript(tag, ids);
      if (verdict.match) {
        return {
          ok: true,
          status: res.status,
          found: true,
          inHead: scope === 'head',
          how: verdict.how,
        };
      }
    }
  }

  return { ok: true, status: res.status, found: false, inHead: false };
}

/**
 * Check a Site row. Convenience wrapper that resolves the URL and the identifiers
 * the embed could carry.
 */
export async function checkScriptForSite(site) {
  const url = checkUrlForSite(site);
  if (!url) {
    return { ok: false, status: 0, found: false, inHead: false, error: 'no domain on record', url: null };
  }
  const ids = [site?.cdnScriptId, site?.id].filter(Boolean);
  const result = await checkScriptOnUrl(url, ids);
  return { ...result, url };
}
