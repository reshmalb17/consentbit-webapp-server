// handlers/gtm.js
//
// NOT ROUTED. Kept for the dashboard-sync idea described below, which was built and
// then set aside: the GTM template now only sets Consent Mode defaults and never
// touches the site's region_mode, so nothing calls this. Wire it back up in
// src/index.js (dispatch case + PUBLIC_PATHS + a rate limit) if that work resumes —
// and read the SECURITY note first, because the caller is an anonymous browser.
//
// Region surface for the ConsentBit GTM template (Community Template Gallery).
//
// The template is sandboxed JavaScript running in the visitor's browser. It has no
// session, cannot read a response body, and its only outbound call is sendPixel()
// — a plain GET. So this endpoint is shaped around that constraint:
//
//   GET  /api/gtm/region?scriptId=X            → read  { regionMode, bannerType, bothAllowed }
//   GET  /api/gtm/region?scriptId=X&mode=ccpa  → write, answers with a 1x1 GIF (the beacon)
//   POST /api/gtm/region { scriptId, regionMode } → write, answers with JSON (dashboard/banner)
//
// SECURITY. The caller is an anonymous visitor's browser and the Script ID is public
// (it is in the page source of every site running ConsentBit), so this endpoint is
// deliberately narrow:
//
//   * only 'gdpr' | 'ccpa' are accepted — 'both' is an Essential/Growth entitlement
//     and is never settable from here, in either direction;
//   * a site already on region_mode='both' is left alone, so a beacon can never
//     clear a paid configuration;
//   * banner_type='iab' sites are left alone;
//   * the Origin/Referer host must authorize for the site, using the same check the
//     CDN applies before serving the script at all (utils/domainValidate.js);
//   * unchanged values are not written, so this costs one read per *change*, not
//     one write per pageview.
import { authorizeRequestHost } from '../utils/domainValidate.js';
import { resolveEffectivePlanId, BOTH_REGIONS_PLANS } from './bannerCustomization.js';

/** Region modes the GTM template is allowed to set. 'both' is intentionally absent. */
const GTM_SETTABLE_REGION_MODES = ['gdpr', 'ccpa'];

/** region_mode → banner_type, mirroring the mapping in handlers/bannerCustomization.js. */
const BANNER_TYPE_FOR_REGION_MODE = { gdpr: 'gdpr', ccpa: 'ccpa' };

/** Transparent 1x1 GIF — the body sendPixel() expects back. */
const PIXEL_BYTES = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

function pixelResponse() {
  return new Response(PIXEL_BYTES, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/** Site lookup by CDN script ID, falling back to the raw site ID (as the CDN does). */
async function resolveSiteByScriptId(db, scriptId) {
  const site = await db.prepare('SELECT * FROM Site WHERE cdnScriptId = ?1').bind(scriptId).first();
  if (site) return site;
  return db.prepare('SELECT * FROM Site WHERE id = ?1').bind(scriptId).first();
}

/**
 * Is this request coming from a page that belongs to the site it names?
 *
 * Unlike the CDN's copy, a MISSING Origin/Referer is rejected rather than allowed:
 * the CDN serves a script (harmless without a matching site), this endpoint writes.
 * A header-less caller is curl, not a browser.
 */
function isAuthorizedCaller(request, site) {
  const sourceHeader =
    request.headers.get('Origin') ||
    request.headers.get('origin') ||
    request.headers.get('Referer') ||
    request.headers.get('referer') ||
    '';
  if (!sourceHeader) return { ok: false, reason: 'no-origin', host: null };

  let host;
  try {
    host = new URL(sourceHeader).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return { ok: false, reason: 'bad-origin', host: null };
  }

  const decision = authorizeRequestHost(site, host);
  // 'no-host' can only come back for an empty host, which is already handled above.
  return { ok: decision.allowed && decision.reason !== 'no-host', reason: decision.reason, host };
}

/**
 * Apply a region mode coming from the GTM tag.
 *
 * Returns { applied: boolean, reason: string, regionMode: string } — `reason` is the
 * audit trail for why a write was skipped, and is logged rather than returned to the
 * beacon (which cannot read a body anyway).
 */
async function applyRegionMode(db, request, site, requestedMode) {
  const currentRegionMode = site.region_mode || 'gdpr';
  const currentBannerType = site.banner_type || 'gdpr';

  if (String(currentBannerType).toLowerCase() === 'iab') {
    return { applied: false, reason: 'IAB_SITE', regionMode: currentRegionMode };
  }

  // A paid multi-region setup is never downgraded by a browser beacon. The owner
  // changes this in the dashboard, where the plan gate already runs.
  if (currentRegionMode === 'both') {
    return { applied: false, reason: 'BOTH_REGIONS_SET', regionMode: currentRegionMode };
  }

  if (currentRegionMode === requestedMode) {
    return { applied: false, reason: 'UNCHANGED', regionMode: currentRegionMode };
  }

  const auth = isAuthorizedCaller(request, site);
  if (!auth.ok) {
    console.warn(
      `[GTM] region write BLOCKED for site ${site.id}: host="${auth.host}" reason=${auth.reason}`,
    );
    return { applied: false, reason: 'DOMAIN_MISMATCH', regionMode: currentRegionMode };
  }

  const bannerType = BANNER_TYPE_FOR_REGION_MODE[requestedMode];
  try {
    await db
      .prepare('UPDATE Site SET banner_type = ?1, region_mode = ?2, updatedAt = ?3 WHERE id = ?4')
      .bind(bannerType, requestedMode, new Date().toISOString(), site.id)
      .run();
  } catch (err) {
    console.warn('[GTM] region write failed:', err?.message);
    return { applied: false, reason: 'WRITE_FAILED', regionMode: currentRegionMode };
  }

  console.log(
    `[GTM] region ${currentRegionMode} → ${requestedMode} for site ${site.id} from ${auth.host}`,
  );
  return { applied: true, reason: 'APPLIED', regionMode: requestedMode };
}

export async function handleGtmRegion(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);
  const isBeacon = request.method === 'GET';

  let scriptId = '';
  let requestedMode = '';

  if (isBeacon) {
    scriptId = (url.searchParams.get('scriptId') || '').trim();
    requestedMode = (url.searchParams.get('mode') || '').trim().toLowerCase();
  } else if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }
    scriptId = String(body.scriptId || '').trim();
    requestedMode = String(body.regionMode || '').trim().toLowerCase();
    if (!requestedMode) {
      return Response.json({ success: false, error: 'regionMode required' }, { status: 400 });
    }
  } else {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!scriptId) {
    return isBeacon
      ? pixelResponse()
      : Response.json({ success: false, error: 'scriptId required' }, { status: 400 });
  }

  const site = await resolveSiteByScriptId(db, scriptId);
  if (!site) {
    // The beacon gets the same 200 GIF either way — whether a Script ID exists is
    // not something an anonymous caller should be able to probe.
    return isBeacon
      ? pixelResponse()
      : Response.json({ success: false, error: 'Site not found' }, { status: 404 });
  }

  // ── Read: no mode given (GET only) ──────────────────────────────────────────
  if (!requestedMode) {
    const planId = await resolveEffectivePlanId(db, env, site.id);
    return Response.json({
      success: true,
      regionMode: site.region_mode || 'gdpr',
      bannerType: site.banner_type || 'gdpr',
      // Whether the dashboard may offer GDPR+CCPA together. The plan id itself is
      // not returned — this endpoint is public.
      bothAllowed: planId != null && BOTH_REGIONS_PLANS.includes(planId),
    });
  }

  // ── Write ───────────────────────────────────────────────────────────────────
  if (!GTM_SETTABLE_REGION_MODES.includes(requestedMode)) {
    if (isBeacon) return pixelResponse();
    return Response.json(
      {
        success: false,
        error: "regionMode must be 'gdpr' or 'ccpa'. Running both regions is configured in the ConsentBit dashboard.",
        code: 'REGION_MODE_NOT_SETTABLE',
      },
      { status: 400 },
    );
  }

  const result = await applyRegionMode(db, request, site, requestedMode);

  if (isBeacon) return pixelResponse();
  return Response.json({
    success: true,
    applied: result.applied,
    reason: result.reason,
    regionMode: result.regionMode,
  });
}
