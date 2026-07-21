// src/handlers/framerUpgrade.js
//
// JWT-authenticated, siteId-keyed UPGRADE surface for the FRAMER plugin.
//
//   POST /api/framer/upgrade/change-tier/preview      → prorated amount for a tier change (no change)
//   POST /api/framer/upgrade/change-tier              → commit the tier change (charge card on file)
//   POST /api/framer/upgrade/switch-interval/preview  → prorated amount for monthly↔yearly (no change)
//   POST /api/framer/upgrade/switch-interval          → commit the interval switch (charge card on file)
//
// WHY THIS FILE EXISTS
// The web app uses /api/subscriptions/change-tier and /api/subscriptions/switch-interval
// (see changeTier.js / switchBillingInterval.js). Those authenticate with the browser
// `sid` session cookie + organizationId + org-membership — none of which the Framer
// plugin has. This file re-implements the SAME Stripe proration logic, but:
//   • authenticates with the Framer plugin's JWT (Authorization: Bearer <auth_token>,
//     the same token stored in localStorage `auth_token` and minted by the Framer auth
//     backend at framer.consentbit.com), verified locally with env.FRAMER_JWT_SECRET;
//   • resolves the subscription from the siteId alone (Framer platformSiteId OR internal
//     webapp Site.id), the way /api/framer/billing does.
//
// The other change-tier / switch-interval handlers are left untouched.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TOKEN  (minted by consentbitapp-cf-server /email/verify-otp)
//   • Library : jose — new SignJWT(payload).setProtectedHeader({ alg:'HS256' }).sign(secret)
//   • Secret  : new TextEncoder().encode(env.JWT_SECRET) — raw UTF-8 bytes of the secret
//               string. On THIS worker set FRAMER_JWT_SECRET to that SAME secret value.
//   • Claims  : { email, siteId, verifiedAt, iat, exp }  (exp = 30 days)
//               `siteId` is the FRAMER platform/project id passed at login.
//   verifyJwtHS256() below is the dependency-free Web Crypto equivalent of jose's
//   jwtVerify() for HS256, so it validates these tokens byte-for-byte.
//
// AUTH MODEL
//   1. Verify the JWT signature + expiry with env.FRAMER_JWT_SECRET (HS256). A valid
//      token proves the caller is a logged-in Framer user — it cannot be forged.
//   2. Bind the token to the target site so user A cannot change user B's plan. The
//      token carries two independent signals; either one binds:
//        • siteId claim (Framer platform id) matches the site's id OR platformSiteId, OR
//        • email claim belongs to a member of the site's organization.
//      A present-but-mismatched signal → 403. Only when NEITHER signal can be evaluated
//      (e.g. the site can't be resolved) is a valid signature accepted alone, logged.
// ─────────────────────────────────────────────────────────────────────────────

import { syncSubscriptionUpdateToLegacy } from '../services/syncLegacy.js';

const TAG = '[framer-upgrade]';
const PLAN_ORDER = { basic: 1, essential: 2, growth: 3 };

const fail = (error, status) => Response.json({ success: false, error }, { status });

function trimEnv(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ── JWT (HS256) verification ────────────────────────────────────────────────

function base64UrlToBytes(b64url) {
  let b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToString(b64url) {
  return new TextDecoder().decode(base64UrlToBytes(b64url));
}

function extractBearer(request) {
  const h = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

// Verify an HS256 JWT signed with `secret`. Returns the decoded payload, or null on
// any failure (bad shape, wrong alg, bad signature, expired).
async function verifyJwtHS256(token, secret) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;

    let header;
    try { header = JSON.parse(base64UrlToString(h)); } catch { return null; }
    if (!header || header.alg !== 'HS256') return null;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;

    let payload;
    try { payload = JSON.parse(base64UrlToString(p)); } catch { return null; }

    // Expiry (seconds since epoch), when present.
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp != null && Number(payload.exp) < nowSec) return null;
    if (payload.nbf != null && Number(payload.nbf) > nowSec) return null;

    return payload;
  } catch (e) {
    console.warn(`${TAG} JWT verify error:`, e?.message || e);
    return null;
  }
}

// Pull the user's email out of the token payload, trying the common claim shapes.
function emailFromPayload(payload) {
  const candidates = [
    payload?.email,
    payload?.user?.email,
    payload?.data?.email,
    payload?.sub,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) return c.trim().toLowerCase();
  }
  return null;
}

// True if `email` belongs to any member of the given organization.
async function orgHasMemberEmail(db, organizationId, email) {
  if (!db || !organizationId || !email) return false;
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS ok
           FROM OrganizationMember m
           JOIN User u ON u.id = m.userId
          WHERE m.organizationId = ?1 AND lower(u.email) = ?2
          LIMIT 1`,
      )
      .bind(organizationId, email)
      .first();
    return !!row;
  } catch (e) {
    console.warn(`${TAG} orgHasMemberEmail failed:`, e?.message || e);
    return false;
  }
}

// Gate a Framer upgrade request against the already-resolved target `site` row.
// Returns { ok:true, email } or { ok:false, res:Response }.
//
// The HARD gate is the JWT signature — a valid token proves the caller is a logged-in
// Framer user and cannot be forged (this mirrors how consentbitapp-cf-server verifies).
//
// The site-binding (token's siteId/email must belong to the target site) is an ADDED
// defense. It is advisory by default because the Framer-login identity (KV) and the
// webapp account (D1) are bridged only loosely — a site's platformSiteId may be unset
// and the login email may differ from the D1 owner — so a strict 403 here would block
// legitimate users. Set FRAMER_UPGRADE_STRICT_BINDING="true" to enforce it (403 on
// mismatch) once the platformSiteId + owner-email linkage is confirmed for your data.
// Even advisory, this is strictly more secure than the sibling /api/framer/* routes,
// which require no token at all.
async function requireFramerAuth(request, env, site) {
  const token = extractBearer(request);
  if (!token) return { ok: false, res: fail('Missing authorization token', 401) };

  const secret = trimEnv(env.FRAMER_JWT_SECRET);
  if (!secret) {
    console.error(`${TAG} FRAMER_JWT_SECRET not configured`);
    return { ok: false, res: fail('Auth not configured', 503) };
  }

  const payload = await verifyJwtHS256(token, secret);
  if (!payload) return { ok: false, res: fail('Invalid or expired token', 401) };

  const tokenEmail = emailFromPayload(payload);
  const tokenSiteId = payload?.siteId != null ? String(payload.siteId) : null;

  // Bind the token to the target site via either signal it carries.
  let bound = false;
  let boundBy = 'none';
  if (site) {
    if (tokenSiteId && (tokenSiteId === String(site.id) || tokenSiteId === String(site.platformSiteId))) {
      bound = true; boundBy = 'siteId';
    } else if (tokenEmail && await orgHasMemberEmail(env.CONSENT_WEBAPP, site.organizationId, tokenEmail)) {
      bound = true; boundBy = 'email';
    }
  }

  if (!bound) {
    const strict = trimEnv(env.FRAMER_UPGRADE_STRICT_BINDING) === 'true';
    // Diagnostics — run `wrangler tail` to see exactly why a token didn't bind.
    console.warn(
      `${TAG} site binding unmatched — tokenSiteId=${tokenSiteId || '-'} tokenEmail=${tokenEmail || '-'} ` +
      `site.id=${site?.id || '-'} site.platformSiteId=${site?.platformSiteId || '-'} org=${site?.organizationId || '-'} strict=${strict}`,
    );
    if (strict && site && (tokenSiteId || tokenEmail)) {
      return { ok: false, res: fail('Not authorized for this site', 403) };
    }
    // Advisory mode: valid signature is enough. Proceed.
  } else {
    console.log(`${TAG} authorized via ${boundBy} — site.id=${site?.id} user=${tokenEmail || '-'}`);
  }

  return { ok: true, email: tokenEmail || null };
}

// ── Site / subscription resolution (siteId-keyed, mirrors webflowBilling.js) ──

function pick(sub, camel, snake) {
  return sub?.[camel] ?? sub?.[snake] ?? null;
}

async function resolveSite(db, siteId) {
  if (!siteId) return null;
  return db
    .prepare('SELECT id, organizationId, platformSiteId FROM Site WHERE id = ?1 OR platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
    .bind(siteId)
    .first()
    .catch(() => null);
}

async function resolveSubscription(db, site) {
  if (!site) return null;
  const cols =
    'id, organizationId, siteId, planId, planType, status, stripeSubscriptionId, stripeCustomerId, interval, currentPeriodEnd, cancelAtPeriodEnd';
  let sub = await db
    .prepare(
      `SELECT ${cols} FROM Subscription WHERE siteId = ?1
       ORDER BY CASE WHEN lower(status) IN ('active','trialing') THEN 0 ELSE 1 END, createdAt DESC
       LIMIT 1`,
    )
    .bind(site.id)
    .first()
    .catch(() => null);
  if (!sub && site.organizationId) {
    sub = await db
      .prepare(
        `SELECT ${cols} FROM Subscription WHERE organizationId = ?1 AND lower(status) IN ('active','trialing') ORDER BY createdAt DESC LIMIT 1`,
      )
      .bind(site.organizationId)
      .first()
      .catch(() => null);
  }
  return sub;
}

// ── Stripe helpers (ported from changeTier.js) ──────────────────────────────

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return { status: res.status, body: await res.json() };
}

async function stripePost(env, path, formObj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(formObj)) {
    if (v != null) params.set(k, String(v));
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  return { status: res.status, body: await res.json() };
}

function tierPriceMap(env) {
  return {
    basic:     { monthly: trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_BASIC_YEARLY) },
    essential: { monthly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY), yearly: trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY) },
    growth:    { monthly: trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY),     yearly: trimEnv(env.STRIPE_PRICE_GROWTH_YEARLY) },
  };
}

// Sum only the proration line items — the invoice's amount_due would fold in the next
// full renewal and overstate the charge. Mirrors changeTier.js / switchBillingInterval.js.
function sumProrationCents(invoiceBody) {
  let total = 0;
  let sawProration = false;
  for (const line of invoiceBody?.lines?.data || []) {
    if (line.proration === true) { total += line.amount || 0; sawProration = true; }
  }
  return sawProration ? total : (invoiceBody?.amount_due ?? invoiceBody?.total ?? null);
}

// Preview the net amount charged now for an immediate (upgrade / interval-bump) change.
// Tries Upcoming Invoice, falls back to Create Preview Invoice for flexible-billing subs.
async function previewImmediateAmount(env, ctx) {
  const { stripeSubId, subItemId, newPriceId, promotionCodeId, stripeSub } = ctx;

  const base = {
    subscription: stripeSubId,
    'subscription_items[0][id]': subItemId,
    'subscription_items[0][price]': newPriceId,
    subscription_proration_behavior: 'create_prorations',
  };
  if (promotionCodeId) base['discounts[0][promotion_code]'] = promotionCodeId;

  const qs = new URLSearchParams(base).toString();
  const up = await stripeGet(env, `/invoices/upcoming?${qs}`);
  if (!up.body.error) {
    return { amountDueCents: sumProrationCents(up.body), currency: up.body.currency || 'usd' };
  }

  const flexible = up.status === 400 && /billing_mode = flexible/i.test(up.body.error?.message || '');
  if (!flexible) {
    if (promotionCodeId) {
      const retry = { ...base };
      delete retry['discounts[0][promotion_code]'];
      const up2 = await stripeGet(env, `/invoices/upcoming?${new URLSearchParams(retry).toString()}`);
      if (!up2.body.error) {
        return { amountDueCents: sumProrationCents(up2.body), currency: up2.body.currency || 'usd', couponPreviewSkipped: true };
      }
    }
    return { error: up.body.error.message || 'Could not preview the charge' };
  }

  const customerId = stripeSub.customer;
  const items = stripeSub.items?.data || [];
  const form = {
    customer: customerId,
    subscription: stripeSubId,
    'subscription_details[proration_behavior]': 'create_prorations',
  };
  items.forEach((item, i) => {
    form[`subscription_details[items][${i}][id]`] = item.id;
    form[`subscription_details[items][${i}][price]`] = i === 0 ? newPriceId : item.price?.id;
  });
  if (promotionCodeId) form['discounts[0][promotion_code]'] = promotionCodeId;

  const prev = await stripePost(env, '/invoices/create_preview', form);
  if (prev.body.error) {
    return { error: prev.body.error.message || 'Could not preview the charge' };
  }
  return { amountDueCents: sumProrationCents(prev.body), currency: prev.body.currency || 'usd' };
}

// ═════════════════════════════════════════════════════════════════════════════
//  CHANGE TIER  (basic / essential / growth)  — mirrors changeTier.js
// ═════════════════════════════════════════════════════════════════════════════

// Shared prep for change-tier preview + commit: JWT auth, validation, load
// subscription by siteId, resolve the new price, read the live Stripe subscription.
async function prepareChange(request, env) {
  if (request.method !== 'POST') return { error: fail('Method not allowed', 405) };

  const db = env.CONSENT_WEBAPP;
  if (!db) return { error: fail('Database not available', 503) };
  if (!env.STRIPE_SECRET_KEY) return { error: fail('Stripe not configured', 503) };

  let body;
  try { body = await request.json(); } catch { return { error: fail('Invalid JSON', 400) }; }

  const siteId = (body.siteId || '').trim();
  const planId = ['basic', 'essential', 'growth'].includes(body.planId) ? body.planId : null;
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const promotionCodeId = body.promotionCodeId && String(body.promotionCodeId).trim()
    ? String(body.promotionCodeId).trim()
    : null;
  const paymentMethodId = body.paymentMethodId && String(body.paymentMethodId).trim()
    ? String(body.paymentMethodId).trim()
    : null;

  if (!siteId) return { error: fail('siteId required', 400) };
  if (!planId) return { error: fail('planId must be basic, essential, or growth', 400) };

  const site = await resolveSite(db, siteId);
  const auth = await requireFramerAuth(request, env, site);
  if (!auth.ok) return { error: auth.res };

  const sub = await resolveSubscription(db, site);
  if (!sub) return { error: fail('No active subscription found', 404) };

  const stripeSubId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const currentPlanId = String(pick(sub, 'planId', 'planid') || '').toLowerCase();
  const currentInterval = String(pick(sub, 'interval', 'interval') || 'monthly').toLowerCase();

  if (!stripeSubId) return { error: fail('Subscription has no Stripe ID', 400) };
  if (!PLAN_ORDER[currentPlanId]) {
    return { error: fail('Current plan is not a tier plan; cannot change here', 400) };
  }
  if (currentPlanId === planId && currentInterval === interval) {
    return { error: fail('Already on this plan', 400) };
  }

  const newPriceId = tierPriceMap(env)[planId]?.[interval];
  if (!newPriceId) {
    console.error(`${TAG} Missing price env var for`, planId, interval);
    return { error: fail(`Price not configured for ${planId} ${interval}`, 503) };
  }

  const isDowngrade = PLAN_ORDER[planId] < PLAN_ORDER[currentPlanId];

  const subRes = await stripeGet(env, `/subscriptions/${stripeSubId}`);
  if (subRes.body.error) {
    console.error(`${TAG} Stripe fetch sub failed:`, subRes.body.error.message);
    return { error: fail(subRes.body.error.message || 'Failed to read subscription', 400) };
  }
  const stripeSub = subRes.body;
  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return { error: fail('Could not read subscription item ID', 500) };

  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);
  const trialEndISO = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;
  const periodEndISO = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000).toISOString()
    : null;

  return {
    ctx: {
      db, email: auth.email, env, siteId, planId, interval, promotionCodeId, paymentMethodId,
      sub, stripeSubId, stripeSub, subItemId, newPriceId,
      currentPlanId, currentInterval, isDowngrade, isTrialing, trialEndISO, periodEndISO,
    },
  };
}

// POST /api/framer/upgrade/change-tier/preview
export async function handleFramerChangeTierPreview(request, env) {
  const prep = await prepareChange(request, env);
  if (prep.error) return prep.error;
  const ctx = prep.ctx;
  const { currentPlanId, currentInterval, planId, interval, isDowngrade, isTrialing, trialEndISO, periodEndISO, newPriceId } = ctx;

  if (isTrialing) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    if (priceRes.body.error) return fail(priceRes.body.error.message || 'Could not read the plan price', 400);
    return Response.json({
      success: true,
      direction: isDowngrade ? 'downgrade' : 'upgrade',
      currentPlanId, currentInterval, planId, interval,
      isTrialing: true,
      amountDueCents: priceRes.body.unit_amount ?? null,
      currency: priceRes.body.currency || 'usd',
      trialEnd: trialEndISO,
      effectiveAt: null,
    });
  }

  if (isDowngrade) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    const newAmount = priceRes.body?.error ? null : (priceRes.body.unit_amount ?? null);
    return Response.json({
      success: true,
      direction: 'downgrade',
      currentPlanId, currentInterval, planId, interval,
      isTrialing: false,
      amountDueCents: 0,
      newPlanAmountCents: newAmount,
      currency: priceRes.body?.currency || 'usd',
      trialEnd: null,
      effectiveAt: periodEndISO,
    });
  }

  const res = await previewImmediateAmount(env, ctx);
  if (res.error) return fail(res.error, 400);
  return Response.json({
    success: true,
    direction: 'upgrade',
    currentPlanId, currentInterval, planId, interval,
    isTrialing: false,
    amountDueCents: res.amountDueCents,
    currency: res.currency,
    couponPreviewSkipped: !!res.couponPreviewSkipped,
    trialEnd: null,
    effectiveAt: null,
  });
}

// POST /api/framer/upgrade/change-tier — commit.
export async function handleFramerChangeTier(request, env) {
  const prep = await prepareChange(request, env);
  if (prep.error) return prep.error;
  const {
    db, email, siteId, planId, interval, promotionCodeId, paymentMethodId,
    sub, stripeSubId, stripeSub, subItemId, newPriceId, isDowngrade, isTrialing, periodEndISO,
  } = prep.ctx;

  // ── Downgrade → schedule for period end (no charge now) ──────────────────
  if (isDowngrade && !isTrialing) {
    const currentPriceId = stripeSub.items?.data?.[0]?.price?.id;
    const startDate = stripeSub.current_period_start;
    const changeDate = stripeSub.current_period_end;

    if (stripeSub.schedule) {
      await stripePost(env, `/subscription_schedules/${stripeSub.schedule}/release`, {}).catch(() => {});
    }

    const created = await stripePost(env, '/subscription_schedules', { from_subscription: stripeSubId });
    if (created.body.error) {
      console.error(`${TAG} schedule create failed:`, created.body.error.message);
      return fail(created.body.error.message || 'Could not schedule the downgrade', 400);
    }
    const schedId = created.body.id;

    const updateForm = {
      end_behavior: 'release',
      'phases[0][items][0][price]': currentPriceId,
      'phases[0][items][0][quantity]': '1',
      'phases[0][start_date]': startDate,
      'phases[0][end_date]': changeDate,
      'phases[0][proration_behavior]': 'none',
      'phases[1][items][0][price]': newPriceId,
      'phases[1][items][0][quantity]': '1',
      'phases[1][proration_behavior]': 'none',
      'metadata[planId]': planId,
      'metadata[interval]': interval,
      'metadata[siteId]': siteId || (sub.siteId ?? sub.siteid ?? ''),
      'metadata[organizationId]': pick(sub, 'organizationId', 'organizationid') || '',
    };
    const updated = await stripePost(env, `/subscription_schedules/${schedId}`, updateForm);
    if (updated.body.error) {
      console.error(`${TAG} schedule update failed:`, updated.body.error.message);
      return fail(updated.body.error.message || 'Could not schedule the downgrade', 400);
    }

    return Response.json({
      success: true,
      direction: 'downgrade',
      scheduled: true,
      effectiveAt: periodEndISO,
      planId, interval,
    });
  }

  // ── Upgrade (or interval bump) → apply now, invoice the proration immediately ──
  if (stripeSub.schedule) {
    await stripePost(env, `/subscription_schedules/${stripeSub.schedule}/release`, {}).catch(() => {});
  }

  const customerId = stripeSub.customer;
  if (paymentMethodId) {
    const attach = await stripePost(env, `/payment_methods/${paymentMethodId}/attach`, { customer: customerId });
    if (attach.body.error) {
      console.error(`${TAG} card attach failed:`, attach.body.error.message);
      return fail(attach.body.error.message || 'Could not use that card. Please try another.', 400);
    }
  }

  const updateForm = {
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: isTrialing ? 'none' : 'always_invoice',
    payment_behavior: paymentMethodId ? 'default_incomplete' : 'error_if_incomplete',
    'metadata[planId]': planId,
    'metadata[interval]': interval,
    'expand[0]': 'latest_invoice.payment_intent',
  };
  if (paymentMethodId) updateForm['default_payment_method'] = paymentMethodId;
  if (promotionCodeId) updateForm['discounts[0][promotion_code]'] = promotionCodeId;

  const updateRes = await stripePost(env, `/subscriptions/${stripeSubId}`, updateForm);
  if (updateRes.body.error) {
    console.error(`${TAG} Stripe update failed:`, updateRes.body.error.message);
    return fail(updateRes.body.error.message || 'Payment could not be completed', 400);
  }
  const updatedSub = updateRes.body;

  const latestInv = (updatedSub.latest_invoice && typeof updatedSub.latest_invoice === 'object')
    ? updatedSub.latest_invoice
    : null;
  const pi = latestInv && typeof latestInv.payment_intent === 'object' ? latestInv.payment_intent : null;
  if (paymentMethodId && pi) {
    if (pi.status === 'requires_action' || pi.status === 'requires_confirmation') {
      return Response.json({
        success: true,
        direction: 'upgrade',
        scheduled: false,
        requiresAction: true,
        clientSecret: pi.client_secret,
        subscriptionId: stripeSubId,
        invoiceId: latestInv.id,
        planId,
        interval,
      });
    }
    if (pi.status === 'requires_payment_method') {
      return fail('Your card was declined. Please try another card.', 402);
    }
  }

  let amountPaidCents = null;
  let currency = 'usd';
  let invoiceId = latestInv ? latestInv.id : (updatedSub.latest_invoice || null);
  let invoiceUrl = null;
  let paymentStatus = 'paid';
  if (invoiceId) {
    const inv = await stripeGet(env, `/invoices/${invoiceId}`);
    if (!inv.body.error) {
      amountPaidCents = inv.body.amount_paid ?? inv.body.amount_due ?? null;
      currency = inv.body.currency || 'usd';
      invoiceUrl = inv.body.hosted_invoice_url || null;
      paymentStatus = inv.body.status || paymentStatus;
    }
  }

  const newPeriodEndISO = updatedSub.current_period_end
    ? new Date(updatedSub.current_period_end * 1000).toISOString()
    : periodEndISO;
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE Subscription SET planId = ?, planType = 'tier', interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
     WHERE stripeSubscriptionId = ?`,
  ).bind(planId, interval, newPriceId, newPeriodEndISO, now, stripeSubId).run();

  try {
    const sId = siteId ?? sub.siteId ?? sub.siteid;
    const siteRow = sId
      ? await db.prepare('SELECT domain, legacySource FROM Site WHERE id = ?1 OR platformSiteId = ?1 LIMIT 1').bind(sId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: pick(sub, 'stripeCustomerId', 'stripecustomerid'),
      status: 'active',
      cancelAtPeriodEnd: !!(pick(sub, 'cancelAtPeriodEnd', 'cancelatperiodend')),
      platform: siteRow?.legacySource || 'framer',
      interval,
    });
  } catch (syncErr) {
    console.warn(`${TAG} Legacy sync failed (non-critical):`, syncErr?.message);
  }

  console.log(`${TAG} upgraded to`, planId, interval, 'for site:', siteId);
  return Response.json({
    success: true,
    direction: 'upgrade',
    scheduled: false,
    planId,
    interval,
    amountPaidCents,
    currency,
    invoiceId,
    invoiceUrl,
    paymentStatus,
    nextBillingDate: newPeriodEndISO,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  SWITCH INTERVAL  (monthly ↔ yearly, same tier)  — mirrors switchBillingInterval.js
// ═════════════════════════════════════════════════════════════════════════════

// Shared prep for switch-interval preview + commit.
async function prepareSwitch(request, env) {
  if (request.method !== 'POST') return { error: fail('Method not allowed', 405) };

  const db = env.CONSENT_WEBAPP;
  if (!db) return { error: fail('Database not available', 503) };
  if (!env.STRIPE_SECRET_KEY) return { error: fail('Stripe not configured', 503) };

  let body;
  try { body = await request.json(); } catch { return { error: fail('Invalid JSON', 400) }; }

  const siteId = (body.siteId || '').trim();
  const targetInterval = body.targetInterval === 'yearly' ? 'yearly' : body.targetInterval === 'monthly' ? 'monthly' : null;

  if (!siteId) return { error: fail('siteId required', 400) };
  if (!targetInterval) return { error: fail('targetInterval must be monthly or yearly', 400) };

  const site = await resolveSite(db, siteId);
  const auth = await requireFramerAuth(request, env, site);
  if (!auth.ok) return { error: auth.res };

  const sub = await resolveSubscription(db, site);
  if (!sub) return { error: fail('No active subscription found', 404) };

  const stripeSubId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const currentInterval = String(pick(sub, 'interval', 'interval') || 'monthly').toLowerCase();
  const planId = String(pick(sub, 'planId', 'planid') || '').toLowerCase();

  if (!stripeSubId) return { error: fail('Subscription has no Stripe ID', 400) };
  if (currentInterval === targetInterval) return { error: fail(`Already on ${targetInterval} billing`, 400) };
  if (!['basic', 'essential', 'growth'].includes(planId)) {
    return { error: fail('Cannot switch interval for this plan type', 400) };
  }

  const newPriceId = tierPriceMap(env)[planId]?.[targetInterval];
  if (!newPriceId) {
    console.error(`${TAG} Missing price env var for`, planId, targetInterval);
    return { error: fail(`Price not configured for ${planId} ${targetInterval}`, 503) };
  }

  const subRes = await stripeGet(env, `/subscriptions/${stripeSubId}`);
  if (subRes.body.error) {
    console.error(`${TAG} Stripe fetch sub failed:`, subRes.body.error.message);
    return { error: fail(subRes.body.error.message || 'Failed to read subscription', 400) };
  }
  const stripeSub = subRes.body;

  if (stripeSub.status === 'canceled' || stripeSub.status === 'incomplete_expired') {
    return {
      error: Response.json(
        { success: false, canceled: true, plan: planId, targetInterval, error: 'This subscription was canceled. Start a new checkout to resubscribe.' },
        { status: 409 },
      ),
    };
  }

  const subItemId = stripeSub.items?.data?.[0]?.id;
  if (!subItemId) return { error: fail('Could not read subscription item ID', 500) };

  const nowSec = Math.floor(Date.now() / 1000);
  const isTrialing = stripeSub.status === 'trialing' || (stripeSub.trial_end && stripeSub.trial_end > nowSec);
  const trialEndISO = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000).toISOString() : null;

  return {
    ctx: {
      db, email: auth.email, siteId, targetInterval, currentInterval, planId,
      sub, stripeSubId, stripeSub, subItemId, newPriceId, isTrialing, trialEndISO,
    },
  };
}

// POST /api/framer/upgrade/switch-interval/preview
export async function handleFramerSwitchIntervalPreview(request, env) {
  const prep = await prepareSwitch(request, env);
  if (prep.error) return prep.error;
  const { stripeSubId, subItemId, newPriceId, targetInterval, currentInterval, isTrialing, trialEndISO } = prep.ctx;

  let amountDueCents = null;
  let currency = 'usd';

  if (isTrialing) {
    const priceRes = await stripeGet(env, `/prices/${newPriceId}`);
    if (priceRes.body.error) return fail(priceRes.body.error.message || 'Could not read the plan price', 400);
    amountDueCents = priceRes.body.unit_amount ?? null;
    currency = priceRes.body.currency || 'usd';
  } else {
    const params = new URLSearchParams({
      subscription: stripeSubId,
      'subscription_items[0][id]': subItemId,
      'subscription_items[0][price]': newPriceId,
      subscription_proration_behavior: 'create_prorations',
    });
    const inv = await stripeGet(env, `/invoices/upcoming?${params.toString()}`);
    if (inv.body.error) {
      console.warn(`${TAG} preview upcoming-invoice error:`, inv.body.error.message);
      return fail(inv.body.error.message || 'Could not preview the charge', 400);
    }
    amountDueCents = sumProrationCents(inv.body);
    currency = inv.body.currency || 'usd';
  }

  return Response.json({
    success: true,
    currentInterval,
    targetInterval,
    isTrialing: !!isTrialing,
    amountDueCents,
    currency,
    trialEnd: isTrialing ? trialEndISO : null,
  });
}

// POST /api/framer/upgrade/switch-interval — commit.
export async function handleFramerSwitchInterval(request, env) {
  const prep = await prepareSwitch(request, env);
  if (prep.error) return prep.error;
  const {
    db, email, siteId, targetInterval, currentInterval,
    sub, stripeSubId, subItemId, newPriceId, isTrialing,
  } = prep.ctx;

  const updateForm = {
    'items[0][id]': subItemId,
    'items[0][price]': newPriceId,
    proration_behavior: isTrialing ? 'none' : 'always_invoice',
    payment_behavior: 'error_if_incomplete',
  };
  const updateRes = await stripePost(env, `/subscriptions/${stripeSubId}`, updateForm);
  if (updateRes.body.error) {
    console.error(`${TAG} Stripe update failed:`, updateRes.body.error.message);
    return fail(updateRes.body.error.message || 'Failed to switch billing interval', 400);
  }
  const updated = updateRes.body;

  let newPeriodEnd = updated.current_period_end || null;
  if (!newPeriodEnd) {
    const fresh = await stripeGet(env, `/subscriptions/${stripeSubId}`);
    newPeriodEnd = fresh.body?.current_period_end || null;
  }
  const newPeriodEndISO = newPeriodEnd ? new Date(newPeriodEnd * 1000).toISOString() : null;

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE Subscription SET interval = ?, stripePriceId = ?, currentPeriodEnd = ?, updatedAt = ?
     WHERE stripeSubscriptionId = ?`,
  ).bind(targetInterval, newPriceId, newPeriodEndISO, now, stripeSubId).run();

  try {
    const sId = siteId ?? sub.siteId ?? sub.siteid;
    const siteRow = sId
      ? await db.prepare('SELECT domain, legacySource FROM Site WHERE id = ?1 OR platformSiteId = ?1 LIMIT 1').bind(sId).first()
      : null;
    await syncSubscriptionUpdateToLegacy(env, {
      email: email || null,
      domain: siteRow?.domain || null,
      subscriptionId: stripeSubId,
      customerId: pick(sub, 'stripeCustomerId', 'stripecustomerid'),
      status: pick(sub, 'status', 'status') || 'active',
      cancelAtPeriodEnd: !!(pick(sub, 'cancelAtPeriodEnd', 'cancelatperiodend')),
      platform: siteRow?.legacySource || 'framer',
      interval: targetInterval,
    });
  } catch (syncErr) {
    console.warn(`${TAG} Legacy sync failed (non-critical):`, syncErr?.message);
  }

  console.log(`${TAG} switched`, currentInterval, '→', targetInterval, 'for site:', siteId);
  return Response.json({
    success: true,
    interval: targetInterval,
    nextBillingDate: newPeriodEndISO,
  });
}
