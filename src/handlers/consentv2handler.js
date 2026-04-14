// handlers/consentv2handler.js
import { getEffectivePlanForOrganization } from '../services/db.js';

export async function handleConsentV2Script(request, env, url) {
  try {
    return await _handleConsentV2Script(request, env, url);
  } catch (err) {
    console.error('[ConsentV2] Unhandled error:', err);
    return new Response(`// ConsentV2 error: ${err?.message || err}`, {
      status: 500,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }
}

async function _handleConsentV2Script(request, env, url) {
  const parts = url.pathname.split('/');

  let cdnScriptId = parts[parts.length - 1];
  // If last part is "script.js" or "consentv2.js", get the one before it
  if ((cdnScriptId === 'script.js' || cdnScriptId === 'consentv2.js') && parts.length > 2) {
    cdnScriptId = parts[parts.length - 2];
  }
  // Remove .js extension if present (e.g., "abc123.js" -> "abc123")
  if (cdnScriptId.endsWith('.js')) {
    cdnScriptId = cdnScriptId.slice(0, -3);
  }

  const db = env.CONSENT_WEBAPP;

  const site = await db
    .prepare(
      'SELECT id, name, domain, cdnScriptId, organizationId, organizationid FROM Site WHERE cdnScriptId = ?1'
    )
    .bind(cdnScriptId)
    .first();

  // Backward compatibility: some older installs used Site.id in the URL.
  let resolvedSite = site;
  if (!resolvedSite) {
    resolvedSite = await db
      .prepare(
        'SELECT id, name, domain, cdnScriptId, organizationId, organizationid FROM Site WHERE id = ?1'
      )
      .bind(cdnScriptId)
      .first();
  }

  if (!resolvedSite) {
    return new Response('// Unknown site script', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  // Domain validation — only serve the script to the registered domain.
  if (resolvedSite.domain) {
    const referer = request.headers.get('Referer') || request.headers.get('referer') || '';
    if (referer) {
      try {
        const refHost = new URL(referer).hostname.replace(/^www\./, '').toLowerCase();
        const siteHost = String(resolvedSite.domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
        if (refHost !== siteHost) {
          console.warn(`[ConsentV2] Domain mismatch: script for "${siteHost}" requested from "${refHost}" — blocking`);
          return new Response('// Script not authorized for this domain', {
            status: 403,
            headers: { 'Content-Type': 'application/javascript' },
          });
        }
      } catch (domainErr) {
        // Malformed Referer — fail safe and block
        console.warn('[ConsentV2] Could not parse Referer for domain check:', domainErr?.message);
        return new Response('// Script not authorized for this domain', {
          status: 403,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    }
    // No Referer header: allow through (browsers/proxies may strip it).
  }

  // Check subscription status — block script if subscription is canceled/expired.
  try {
    const orgId = resolvedSite.organizationId ?? resolvedSite.organizationid ?? null;
    if (orgId) {
      const { planId: resolvedPlanId, subscription } = await getEffectivePlanForOrganization(db, orgId, env);
      const status = subscription ? String(subscription.status || '').toLowerCase() : null;
      const INACTIVE_STATUSES = ['canceled', 'cancelled', 'past_due', 'unpaid', 'incomplete_expired'];
      if (status && INACTIVE_STATUSES.includes(status)) {
        return new Response('// Subscription inactive — banner disabled', {
          status: 402,
          headers: { 'Content-Type': 'application/javascript' },
        });
      }
    }
  } catch (subErr) {
    console.warn('[ConsentV2] Subscription check failed:', subErr?.message);
    // Fall through — do not block on DB errors
  }

  // Serve the consentv2.js asset
  const assetRequest = new Request(new URL('/consentv2.js', url.origin));
  const assetResponse = await env.ASSETS.fetch(assetRequest);

  if (!assetResponse.ok) {
    return new Response('// consentv2.js asset not found', {
      status: 502,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }

  return new Response(assetResponse.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
