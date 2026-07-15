// handlers/webflowCheckoutToken.js
//
// New v2 Webflow checkout entry point. The Webflow Designer extension has no
// session and no email on hand, so this endpoint:
//   1. takes the site context the extension DOES have (platformId, domain, plan…)
//   2. resolves the workspace email server-side from the OAuth record
//      (WEBFLOW_AUTHENTICATION KV, keyed by the Webflow site id)
//   3. stores a short-lived checkout token in CHECKOUT_TOKENS KV
//   4. returns { token } — the extension opens /checkoutplan?t=<token>
//
// It lives on consent-manager (which holds the Stripe keys used by the
// subsequent /api/custom-checkout call) so the whole paid flow runs on one
// worker. The token is written with the SAME `checkout-token:<token>` key the
// existing GET /api/checkout-token reads, so the checkoutplan page can exchange it.
//
//   POST /api/v2/webflow-checkout-token
//   body: { platformId, domain?, plan?, interval?, platform?, version?, email?, billingEmail? }
//   → { token }  (CORS *, no session)

import { getWebflowOAuthTokenBySite, getWebflowOAuthTokenByUser } from '../services/db.js';
import { capturePostHogEvent } from '../services/posthog.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const STRING_KEYS = ['email', 'domain', 'platform', 'platformId', 'billingEmail', 'version', 'plan', 'interval'];
const TOKEN_TTL_SECONDS = 600;

// Displayed plan pricing (USD): monthly rate and the per-month equivalent when
// billed yearly. Mirrors the Select Plan screen — used only for analytics props.
const PLAN_PRICE = {
  basic: { monthly: 9, annual: 7 },
  essential: { monthly: 20, annual: 16 },
  growth: { monthly: 56, annual: 45 },
};

export async function handleWebflowCheckoutToken(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405, headers: CORS_HEADERS });
  }

  const kv = env.CHECKOUT_TOKENS;
  if (!kv) {
    console.error('[webflow-checkout-token] CHECKOUT_TOKENS KV binding missing');
    return Response.json({ error: 'checkout unavailable' }, { status: 503, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400, headers: CORS_HEADERS });
  }

  // Keep only the allowed string fields the client sent.
  const payload = {};
  for (const key of STRING_KEYS) {
    if (body[key] && typeof body[key] === 'string') payload[key] = body[key];
  }
  // Default the platform marker for the Webflow v2 flow.
  payload.platform = payload.platform || 'webflow';
  payload.version = payload.version || 'v2';

  // PRIMARY (authoritative): the CURRENT ConsentBit account owner for this site.
  // Ownership transfers rename the owner User in place, so this always reflects the
  // latest owner — unlike the Webflow OAuth-installer email below, which never
  // changes on transfer. Override any (possibly stale) email the client passed.
  if (payload.platformId && env.CONSENT_WEBAPP) {
    try {
      const owner = await env.CONSENT_WEBAPP
        .prepare(
          `SELECT u.email AS email, u.billingEmail AS billingEmail
             FROM Site s
             JOIN OrganizationMember m ON m.organizationId = s.organizationId AND lower(m.role) = 'owner'
             JOIN User u ON u.id = m.userId
            WHERE s.platformSiteId = ?1
            ORDER BY s.createdAt ASC LIMIT 1`,
        )
        .bind(payload.platformId)
        .first();
      if (owner?.email) {
        payload.email = String(owner.email).trim().toLowerCase();
        // Billing defaults to the account email unless the owner set a distinct one.
        payload.billingEmail = String(owner.billingEmail || owner.email).trim().toLowerCase();
        console.log('[webflow-checkout-token] resolved CURRENT owner email from D1 for', payload.platformId);
      }
    } catch (e) {
      console.warn('[webflow-checkout-token] owner email resolve failed (non-fatal)', e?.message || e);
    }
  }

  // Resolve the workspace email from the OAuth record when not provided.
  // 1. KV mirror (fast, but can be evicted or lack the .email field).
  if (!payload.email && payload.platformId && env.WEBFLOW_AUTHENTICATION) {
    try {
      const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(payload.platformId);
      if (kvRaw) {
        const kvEntry = typeof kvRaw === 'string' ? JSON.parse(kvRaw) : kvRaw;
        if (kvEntry?.email) {
          payload.email = String(kvEntry.email).trim().toLowerCase();
          console.log('[webflow-checkout-token] resolved email from KV for platformId', payload.platformId);
        }
      }
    } catch (e) {
      console.warn('[webflow-checkout-token] KV email resolve failed (non-fatal)', e?.message || e);
    }
  }
  // 2. Durable D1 OAuth record fallback (authoritative; survives KV eviction).
  //    WebflowOAuthSite[siteId].userKey → WebflowOAuthToken.authorizedBy(.user).email
  if (!payload.email && payload.platformId && env.CONSENT_WEBAPP) {
    try {
      const siteRow = await getWebflowOAuthTokenBySite(env.CONSENT_WEBAPP, payload.platformId);
      if (siteRow?.userKey) {
        const tokenRow = await getWebflowOAuthTokenByUser(env.CONSENT_WEBAPP, siteRow.userKey);
        const email = tokenRow?.authorizedBy?.email || tokenRow?.authorizedBy?.user?.email;
        if (email) {
          payload.email = String(email).trim().toLowerCase();
          console.log('[webflow-checkout-token] resolved email from D1 for platformId', payload.platformId);
        }
      }
    } catch (e) {
      console.warn('[webflow-checkout-token] D1 email resolve failed (non-fatal)', e?.message || e);
    }
  }
  if (!payload.email) {
    console.warn('[webflow-checkout-token] email NOT resolved for platformId', payload.platformId || 'none');
  }

  const token = crypto.randomUUID();
  await kv.put(`checkout-token:${token}`, JSON.stringify(payload), { expirationTtl: TOKEN_TTL_SECONDS });
  console.log('[webflow-checkout-token] stored token', token, 'keys:', Object.keys(payload));

  // plan_selected vs upgrade_initiated — both start checkout via this endpoint. If the
  // site already has an active PAID plan, this is an upgrade (funnel step 10); otherwise
  // it's the initial plan choice (step 3). Email is the distinct_id so it merges into the
  // same PostHog person as the rest of the funnel. The actual conversion is tracked later
  // by the Stripe webhook (subscription_activated).
  if (payload.email && payload.plan) {
    const billingCycle = /^(year|annual)/i.test(payload.interval || '') ? 'annual' : 'monthly';
    let currentPlan = null;
    try {
      if (payload.platformId && env.CONSENT_WEBAPP) {
        const site = await env.CONSENT_WEBAPP
          .prepare('SELECT id, organizationId FROM Site WHERE platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
          .bind(payload.platformId).first();
        if (site?.organizationId) {
          const sub = await env.CONSENT_WEBAPP
            .prepare('SELECT status, planId, planid FROM Subscription WHERE organizationId = ?1 ORDER BY updatedAt DESC LIMIT 1')
            .bind(site.organizationId).first();
          const planId = String(sub?.planId || sub?.planid || '').toLowerCase();
          const status = String(sub?.status || '').toLowerCase();
          if (['basic', 'essential', 'growth'].includes(planId) && ['active', 'trialing', 'past_due'].includes(status)) {
            currentPlan = planId;
          }
        }
      }
    } catch { /* treat as a new plan selection */ }

    if (currentPlan) {
      await capturePostHogEvent(env, payload.email, 'upgrade_initiated', {
        current_plan: currentPlan,
        target_plan: payload.plan,
        billing_cycle: billingCycle,
        platform: 'webflow',
        site_id: payload.platformId || null,
      });
    } else {
      await capturePostHogEvent(env, payload.email, 'plan_selected', {
        plan_tier: payload.plan,
        billing_cycle: billingCycle,
        plan_price: PLAN_PRICE[payload.plan]?.[billingCycle] ?? null,
        platform: 'webflow',
        site_id: payload.platformId || null,
      });
    }
  }

  return Response.json({ token }, { headers: CORS_HEADERS });
}
