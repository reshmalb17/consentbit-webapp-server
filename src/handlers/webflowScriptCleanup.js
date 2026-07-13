// src/handlers/webflowScriptCleanup.js
//
// Detect and remove LEGACY ConsentBit scripts that the OLD live app auto-injected
// into a Webflow site's <head> via the Registered Scripts API ("Code added by
// Apps"). The NEW app installs the banner by manual copy-paste into the head
// custom-code field instead — so before a legacy user pastes + verifies, we must
// strip the old API-injected script(s), otherwise the site would load the banner
// twice (double consent logic) and verify could pass on the stale old tag.
//
//   GET  /api/webflow/script-cleanup?siteId=<id>   → report (detect only)
//   POST /api/webflow/script-cleanup  { siteId }   → remove the detected legacy scripts
//
// Why this is safe: Webflow keeps API-registered scripts ("Code added by Apps")
// in a DIFFERENT store from the raw head/footer custom code the user pastes by
// hand. The Data API's custom_code endpoint only manages the former, so removing
// legacy entries here can NEVER touch the user's new manual paste.
//
// Token: read from the WEBFLOW_AUTHENTICATION KV entry keyed by siteId (same
// source webflowFreeRegister.js uses in this worker). The token carries the
// custom_code:read/write scope and is never exposed to the client.

const TAG = '[webflow-script-cleanup]';
const WEBFLOW_API = 'https://api.webflow.com/v2';

// ── ConsentBit app-injected script markers ───────────────────────────────────
//
// The new app installs the banner by MANUAL copy-paste into the head custom-code
// field. Therefore ANY ConsentBit script that was injected via the Registered
// Scripts API ("Code added by Apps") must be removed — both the old live app's
// versions AND the new app's own auto-injected runtime script — otherwise the
// banner loads twice. The manual paste lives in a different store the Data API
// cannot see, so removing every app-registered ConsentBit script never touches it.
//
// Matching on displayName PREFIX (not an exact commit-hash URL) catches every
// past and future version at once.
const CB_NAME_PREFIXES = [
  'ConsentScript2025',          // V1  (old live app: displayName `ConsentScript2025<ts>`)
  'ConsentScriptV22025',        // V2  (old live app: displayName `ConsentScriptV22025<ts>`)
  'ConsentScriptVersion22025',  // V2 (defensive: tolerate the longer variant too)
  'ConsentScriptVersion312025', // V2.1 / V3
  'appscript',                  // inline loader (api.consentbit.com/consent.js)
  'ConsentBitBanner',           // runtime loader injected by the new app's API path
];

// URL fragments (in hostedLocation for hosted scripts, or sourceCode for inline
// scripts) that identify a ConsentBit app-injected script. Lower-cased for matching.
const CB_URL_MARKERS = [
  'cdn.jsdelivr.net/gh/reshmalb17/',            // ALL old-app jsdelivr repos (cmp_script, cmp_script_V2, …)
  'gh/seattlenewmedia/consentbit-public',       // hosted consent.js repo
  'api.consentbit.com/consent.js',              // old inline loader target
  '/api/v2/cdn/runtime/',                        // new app runtime loader
  'app.consentbit.com',                          // new app host
  '/consentbit/',                                // worker-hosted /consentbit/<id>/script.js
];

// Read the stored Webflow OAuth access token for a site from KV. Returns null
// when the site was never authorized through the app.
async function resolveAccessToken(env, siteId) {
  try {
    const raw = await env.WEBFLOW_AUTHENTICATION?.get(siteId);
    if (!raw) return null;
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return entry?.accessToken || null;
  } catch {
    return null;
  }
}

function webflowHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'accept-version': '1.0.0',
  };
}

/**
 * Is this registered script a ConsentBit app-injected script AT ALL (old OR new)?
 * Matches by displayName prefix OR by any known ConsentBit URL. This alone does
 * NOT decide removal — the current install matches too; see referencesCurrentInstall.
 */
function isConsentBitScript(reg, sourceCode) {
  const name = reg?.displayName || '';
  const hay = `${(reg?.hostedLocation || '')} ${(sourceCode || '')}`.toLowerCase();

  const byName = CB_NAME_PREFIXES.some((p) => name.startsWith(p));
  const byUrl = CB_URL_MARKERS.some((m) => hay.includes(m));
  return byName || byUrl;
}

/**
 * Does this ConsentBit script belong to the site's CURRENT install? The new app
 * registers an inline script whose sourceCode embeds the site's own CDN script
 * URL — which contains its unique cdnScriptId (see webflowFreeRegister.js). A
 * script that references this id is the live current banner, NOT a leftover, and
 * must never be removed. An old previous-version script references a different id
 * (or an old jsdelivr/consent.js URL) and so will not match.
 */
function referencesCurrentInstall(reg, sourceCode, currentCdnScriptId) {
  if (!currentCdnScriptId) return false;
  const id = String(currentCdnScriptId).toLowerCase();
  const hay = `${(reg?.hostedLocation || '')} ${(sourceCode || '')} ${(reg?.displayName || '')}`.toLowerCase();
  return hay.includes(id);
}

/**
 * Read the site's current cdnScriptId from D1 (the id baked into the live embed
 * script URL). Used to tell the current install apart from old leftovers.
 */
async function resolveCurrentCdnScriptId(env, siteId) {
  try {
    const row = await env.CONSENT_WEBAPP
      ?.prepare('SELECT cdnScriptId FROM Site WHERE platformSiteId = ?1 AND cdnScriptId IS NOT NULL ORDER BY createdAt ASC LIMIT 1')
      .bind(siteId)
      .first();
    return row?.cdnScriptId || null;
  } catch {
    return null;
  }
}

// Fetch the details (incl. sourceCode) of one registered script. Best-effort:
// returns null on any failure so classification falls back to list data.
async function fetchScriptDetail(siteId, scriptId, headers) {
  try {
    const res = await fetch(`${WEBFLOW_API}/sites/${siteId}/registered_scripts/${scriptId}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Resolve the site's applied scripts, its registered-script catalog, and the
 * subset of applied scripts that are legacy ConsentBit installs.
 * Returns { appliedScripts, legacy, kept } or throws with a client-safe message.
 */
async function analyzeSite(siteId, accessToken, currentCdnScriptId) {
  const headers = webflowHeaders(accessToken);

  // 1. Applied scripts ("Code added by Apps"). 404 = no custom-code block yet.
  let appliedScripts = [];
  {
    const res = await fetch(`${WEBFLOW_API}/sites/${siteId}/custom_code`, { headers });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      appliedScripts = Array.isArray(data.scripts) ? data.scripts : [];
    } else if (res.status !== 404) {
      const msg = (await res.json().catch(() => ({})))?.message || `HTTP ${res.status}`;
      throw new Error(`Webflow custom_code read failed: ${msg}`);
    }
  }

  // 2. Registered-script catalog → map by id for name/URL lookup.
  const registeredById = new Map();
  {
    const res = await fetch(`${WEBFLOW_API}/sites/${siteId}/registered_scripts`, { headers });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      for (const s of data.registeredScripts || []) {
        if (s?.id) registeredById.set(s.id, s);
      }
    } else if (res.status !== 404) {
      const msg = (await res.json().catch(() => ({})))?.message || `HTTP ${res.status}`;
      throw new Error(`Webflow registered_scripts read failed: ${msg}`);
    }
  }

  // 3. Classify each APPLIED script into: the CURRENT install (keep), an OLD
  //    ConsentBit leftover (remove), or an unrelated user script (keep). For any
  //    ConsentBit-looking script we fetch its source so we can check whether it
  //    references THIS site's cdnScriptId (→ current) or not (→ old leftover).
  const legacy = [];
  const kept = [];
  let hasCurrent = false;
  for (const applied of appliedScripts) {
    let reg = registeredById.get(applied.id) || { id: applied.id, displayName: '' };
    // Resolve full detail whenever the catalog entry is thin — the list endpoint
    // may omit hostedLocation/sourceCode, or the script may sit beyond the first
    // (unpaginated) catalog page, so `reg` would arrive with an empty name and no
    // URL. Without this, a real legacy script classifies as an unrelated user
    // script and is silently kept (the reported "old script not deleting" bug).
    if (!reg.hostedLocation && !reg.sourceCode) {
      const detail = await fetchScriptDetail(siteId, applied.id, headers);
      if (detail) {
        // Prefer whichever field is non-empty (the fallback reg carries an empty
        // displayName that must not clobber the real name from detail).
        reg = {
          id: applied.id,
          displayName: reg.displayName || detail.displayName || '',
          hostedLocation: reg.hostedLocation || detail.hostedLocation || null,
          sourceCode: reg.sourceCode || detail.sourceCode || null,
          version: reg.version || detail.version || null,
        };
      }
    }
    const sourceCode = reg.sourceCode || null;
    const looksConsentBit = isConsentBitScript(reg, sourceCode);
    const keepEntry = { id: applied.id, location: applied.location, version: applied.version };

    if (looksConsentBit && referencesCurrentInstall(reg, sourceCode, currentCdnScriptId)) {
      // The live current banner — keep it, and flag that the site is already installed.
      hasCurrent = true;
      kept.push(keepEntry);
    } else if (looksConsentBit) {
      // An old previous-version ConsentBit script — remove it.
      legacy.push({
        id: applied.id,
        displayName: reg.displayName || '',
        hostedLocation: reg.hostedLocation || null,
        location: applied.location || null,
        version: applied.version || reg.version || null,
      });
    } else {
      // Not ConsentBit — a script the user added themselves. Never touch it.
      kept.push(keepEntry);
    }
  }

  return { appliedScripts, legacy, kept, hasCurrent };
}

// ── GET: report only ─────────────────────────────────────────────────────────
export async function handleWebflowScriptCleanupReport(request, env) {
  const url = new URL(request.url);
  const siteId = url.searchParams.get('siteId') || url.searchParams.get('site_id');
  if (!siteId) return Response.json({ success: false, error: 'Missing siteId' }, { status: 400 });

  const accessToken = await resolveAccessToken(env, siteId);
  if (!accessToken) {
    return Response.json({ success: false, error: 'Site not authorized', code: 'NOT_AUTHORIZED' }, { status: 401 });
  }

  try {
    const currentCdnScriptId = await resolveCurrentCdnScriptId(env, siteId);
    const { legacy, hasCurrent } = await analyzeSite(siteId, accessToken, currentCdnScriptId);
    return Response.json({
      success: true,
      hasLegacy: legacy.length > 0,
      legacyCount: legacy.length,
      legacyScripts: legacy,
      hasCurrent, // true → the site already has the current-version script installed
    });
  } catch (e) {
    console.error(`${TAG} report failed for ${siteId}`, e?.message || e);
    return Response.json({ success: false, error: e?.message || 'Cleanup report failed' }, { status: 502 });
  }
}

// ── POST: remove the detected legacy scripts ─────────────────────────────────
export async function handleWebflowScriptCleanupRemove(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const siteId = body.siteId || body.site_id;
  if (!siteId) return Response.json({ success: false, error: 'Missing siteId' }, { status: 400 });

  const accessToken = await resolveAccessToken(env, siteId);
  if (!accessToken) {
    return Response.json({ success: false, error: 'Site not authorized', code: 'NOT_AUTHORIZED' }, { status: 401 });
  }

  try {
    const currentCdnScriptId = await resolveCurrentCdnScriptId(env, siteId);
    const { legacy, kept } = await analyzeSite(siteId, accessToken, currentCdnScriptId);

    if (legacy.length === 0) {
      return Response.json({ success: true, removed: [], removedCount: 0, message: 'No legacy scripts found' });
    }

    // Re-apply the custom-code block with only the kept (non-legacy) scripts.
    // This removes the legacy entries from "Code added by Apps" without touching
    // the user's manual head paste (a different store the API cannot see).
    const headers = webflowHeaders(accessToken);
    const res = await fetch(`${WEBFLOW_API}/sites/${siteId}/custom_code`, {
      method: kept.length > 0 ? 'PUT' : 'DELETE',
      headers,
      ...(kept.length > 0 ? { body: JSON.stringify({ scripts: kept }) } : {}),
    });

    if (!res.ok && res.status !== 404) {
      const msg = (await res.json().catch(() => ({})))?.message || `HTTP ${res.status}`;
      console.warn(`${TAG} remove failed for ${siteId}`, msg);
      return Response.json({ success: false, error: `Webflow update failed: ${msg}`, webflowStatus: res.status }, { status: 502 });
    }

    const removedIds = legacy.map((s) => s.id);
    console.log(`${TAG} ✓ removed ${removedIds.length} legacy script(s) for ${siteId}`);
    return Response.json({
      success: true,
      removed: removedIds,
      removedCount: removedIds.length,
      legacyScripts: legacy,
      remainingCount: kept.length,
    });
  } catch (e) {
    console.error(`${TAG} remove error for ${siteId}`, e?.message || e);
    return Response.json({ success: false, error: e?.message || 'Cleanup failed' }, { status: 502 });
  }
}
