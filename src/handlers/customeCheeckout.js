// POST /api/custom-checkout
//
// Implements the direct Stripe.js checkout flow:
//   Frontend tokenizes card with Stripe.js → sends paymentMethodId to this endpoint
//   Backend creates Stripe Customer + Subscription → charges card
//   On success: creates/finds user account, adds site, saves plan, returns session cookie
//
// Body (phase 1 — initial payment):
//   { paymentMethodId, email, domain, siteName, planId, interval }
//
// Body (phase 2 — after 3DS confirmation by frontend):
//   { subscriptionId, email, domain, siteName, planId, interval }
//
// Response on immediate success:
//   { success: true, provisioned: true, isNewUser, user, siteId, subscriptionId }
//   + Set-Cookie: sid=...
//
// Response when 3DS required:
//   { success: true, requiresAction: true, clientSecret, subscriptionId }
//   → frontend calls stripe.confirmCardPayment(clientSecret), then re-posts with subscriptionId

import {
  getUserByEmail,
  createUser,
  createSession,
  getOrCreateOrganizationForUser,
  createSite,
  saveSubscription,
  getSiteTrialUsed,
  markTrialUsed,
  generateUniqueLicenseKey,
  canonicalEmbedOrigin,
  buildEmbedScriptUrl,
  getSubscriptionByOrganization,
  normalizeDomain,
} from '../services/db.js';
import { injectScriptIntoWebflowHead } from './webflowFreeRegister.js';
import { sendPaidPlanEmail } from '../services/email.js';

const VALID_PLAN_IDS = ['basic', 'essential', 'growth'];

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
}

function trimEnv(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toTimestamp(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
  return ts;
}

function getPriceId(env, planId, interval) {
  const key = `STRIPE_PRICE_${planId.toUpperCase()}_${interval === 'yearly' ? 'YEARLY' : 'MONTHLY'}`;
  return trimEnv(env[key]);
}

async function fetchStripeInvoice(secret, subId, interval) {
  if (!secret || !subId) return null;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/invoices?subscription=${subId}&limit=1`,
      { headers: { Authorization: `Bearer ${secret}` } }
    );
    const json = await res.json();
    const inv = json?.data?.[0];
    if (!inv || inv.error) return null;
    return {
      invoiceNumber: inv.number || null,
      invoiceUrl:    inv.hosted_invoice_url || null,
      invoicePdf:    inv.invoice_pdf || null,
      amountPaid:    inv.amount_paid != null ? (inv.amount_paid / 100).toFixed(2) : null,
      currency:      (inv.currency || 'usd').toUpperCase(),
      date:          inv.created ? new Date(inv.created * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null,
      interval:      interval || 'monthly',
    };
  } catch (e) {
    console.warn('[CustomCheckout] could not fetch Stripe invoice', e?.message);
    return null;
  }
}

/** Find existing Stripe customer by email or create a new one, attaching the payment method. */
async function findOrCreateStripeCustomer(secret, email, paymentMethodId) {
  const normalized = email.trim().toLowerCase();
  const query = encodeURIComponent(`email:'${normalized}'`);
  const searchRes = await fetch(
    `https://api.stripe.com/v1/customers/search?query=${query}&limit=1`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const searchData = await searchRes.json();
  if (searchData.error) {
    throw new Error(searchData.error.message || 'Stripe customer search failed');
  }
  if (searchData.data?.length > 0 && searchData.data[0].id) {
    const customerId = searchData.data[0].id;
    await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ description: '' }).toString(),
    });
    if (paymentMethodId) {
      const attachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ customer: customerId }).toString(),
      });
      const attachData = await attachRes.json();
      if (attachData.error) {
        if (attachData.error.code === 'payment_method_already_attached') {
          // Already attached to this customer — safe to proceed
        } else if (attachData.error.code === 'resource_missing') {
          throw new Error(
            `PaymentMethod ${paymentMethodId} not found in this Stripe account. ` +
            `This almost always means the frontend Stripe publishable key (pk_...) belongs to a different account or different mode (test vs live) than the backend's STRIPE_SECRET_KEY. ` +
            `Verify both keys come from the same Stripe account and are both either test or live.`
          );
        } else {
          throw new Error(attachData.error.message || 'Failed to attach payment method');
        }
      }
    }
    return customerId;
  }
  const params = new URLSearchParams();
  params.set('email', normalized);
  if (paymentMethodId) params.set('payment_method', paymentMethodId);
  const createRes = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const created = await createRes.json();
  if (created.error) {
    throw new Error(created.error.message || 'Failed to create Stripe customer');
  }
  return created.id;
}

/**
 * After payment succeeds: find or create user account, create/get site, save subscription.
 * Order: payment already processed → create user → create org → create site → save sub → create session
 */
async function provisionAccount(db, env, request, {
  email,
  domain,
  siteName,
  planId,
  interval,
  stripeSubscriptionId,
  stripeCustomerId,
  stripePriceId,
  subscriptionStatus,
  currentPeriodStart,
  currentPeriodEnd,
  amountCents,
  billingEmail,
  wfSiteId,
  platform,
}) {
  const [existingUser] = await Promise.all([getUserByEmail(db, email)]);
  const isNewUser = !existingUser;
  const user = existingUser ?? await createUser(db, { email, name: null });

  const orgName = user.name ? `${user.name}'s Organization` : 'My Organization';
  const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: orgName });
  const organizationId = org?.id ?? org?.organizationId;

  const embedOrigin = canonicalEmbedOrigin(request, env);
  const site = await createSite(db, {
    organizationId,
    name: siteName || domain,
    domain,
    origin: embedOrigin,
    bannerType: 'gdpr',
    regionMode: 'gdpr',
  });

  const trialAlreadyUsed = await getSiteTrialUsed(db, site.id);
  if (!trialAlreadyUsed && subscriptionStatus === 'trialing') {
    await markTrialUsed(db, site.id);
  }

  // Reuse existing license key on upgrade so the site key stays stable across plan changes.
  const existingSubForSite = await getSubscriptionByOrganization(db, organizationId).catch(() => null);
  const existingLicenseKey = existingSubForSite?.licenseKey ?? existingSubForSite?.licensekey ?? null;
  const licenseKey = existingLicenseKey || await generateUniqueLicenseKey(db);
  await saveSubscription(db, {
    organizationId,
    siteId: site.id,
    stripeSubscriptionId,
    stripeCustomerId,
    stripePriceId,
    planType: 'tier',
    planId,
    interval,
    status: subscriptionStatus,
    currentPeriodStart,
    currentPeriodEnd,
    licenseKey,
    amountCents: amountCents ?? null,
  });

  // Store billingEmail and platformSiteId on Site
  const billingEmailToStore = billingEmail || null;
  const platformSiteIdToStore = wfSiteId || null;
  if (billingEmailToStore || platformSiteIdToStore) {
    const sets = [];
    const binds = [];
    if (billingEmailToStore) { sets.push(`billingEmail = ?${binds.length + 1}`); binds.push(billingEmailToStore); }
    if (platformSiteIdToStore) {
      const platformToStore = (String(platform || '').trim().toLowerCase()) || 'webflow';
      sets.push(`platformSiteId = COALESCE(platformSiteId, ?${binds.length + 1}), platform = COALESCE(platform, ?${binds.length + 2})`);
      binds.push(platformSiteIdToStore, platformToStore);
    }
    sets.push(`updatedAt = ?${binds.length + 1}`); binds.push(new Date().toISOString());
    binds.push(site.id);
    await db.prepare(`UPDATE Site SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run().catch(() => {});
  }

  // Store billingEmail on User so all future email lookups find it
  if (billingEmailToStore && organizationId) {
    db.prepare(
      'UPDATE User SET billingEmail = ?1, updatedAt = ?2 WHERE id = (SELECT userId FROM OrganizationMember WHERE organizationId = ?3 LIMIT 1)'
    ).bind(billingEmailToStore, new Date().toISOString(), organizationId).run().catch(() => {});
  }

  const session = await createSession(db, { userId: user.id });
  return { user, isNewUser, session, org, site };
}

/**
 * Merge paid-plan flags onto the platform's KV entry without changing existing fields.
 * - Webflow → WEBFLOW_AUTHENTICATION
 * - Framer  → AUTH_STORE_FRAMER
 *
 * Adds (or overwrites only these keys):
 *   webAppSiteId, userId, cdnScriptId, paid: true
 * Everything else in the existing KV value is preserved.
 */
async function persistPaidStatusToKv(env, { platform, platformSiteId, site, user }) {
  if (!platformSiteId) return;
  const p = String(platform || '').toLowerCase();
  const kv = p === 'framer' ? env.AUTH_STORE_FRAMER : env.WEBFLOW_AUTHENTICATION;
  if (!kv) {
    console.warn('[CustomCheckout] KV binding missing for platform=%s', p || 'webflow');
    return;
  }

  try {
    let existing = null;
    try {
      const raw = await kv.get(platformSiteId);
      existing = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[CustomCheckout] KV get failed (treating as empty)', e?.message);
    }

    const newFields = {
      webAppSiteId: site.id,
      userId: user.id,
      cdnScriptId: site.cdnScriptId ?? site.cdnscriptid ?? null,
      paid: true,
    };
    const merged = existing && typeof existing === 'object'
      ? { ...existing, ...newFields }
      : newFields;

    await kv.put(platformSiteId, JSON.stringify(merged));
    console.log('[CustomCheckout] paid-status KV updated', { platform: p || 'webflow', platformSiteId, mergedWithExisting: !!existing });
  } catch (e) {
    console.error('[CustomCheckout] persistPaidStatusToKv failed', e?.message);
  }
}

/**
 * Merge paid-plan flags onto the platform's KV entry without changing existing fields.
 * - Webflow → WEBFLOW_AUTHENTICATION
 * - Framer  → AUTH_STORE_FRAMER
 *
 * Adds (or overwrites only these keys):
 *   webAppSiteId, userId, cdnScriptId, paid: true
 * Everything else in the existing KV value is preserved.
 */
// async function persistPaidStatusToKv(env, { platform, platformSiteId, site, user }) {
//   if (!platformSiteId) return;
//   const p = String(platform || '').toLowerCase();
//   const kv = p === 'framer' ? env.AUTH_STORE_FRAMER : env.WEBFLOW_AUTHENTICATION;
//   if (!kv) {
//     console.warn('[CustomCheckout] KV binding missing for platform=%s', p || 'webflow');
//     return;
//   }

//   try {
//     let existing = null;
//     try {
//       const raw = await kv.get(platformSiteId);
//       existing = raw ? JSON.parse(raw) : null;
//     } catch (e) {
//       console.warn('[CustomCheckout] KV get failed (treating as empty)', e?.message);
//     }

//     const newFields = {
//       webAppSiteId: site.id,
//       userId: user.id,
//       cdnScriptId: site.cdnScriptId ?? site.cdnscriptid ?? null,
//       paid: true,
//     };
//     const merged = existing && typeof existing === 'object'
//       ? { ...existing, ...newFields }
//       : newFields;

//     await kv.put(platformSiteId, JSON.stringify(merged));
//     console.log('[CustomCheckout] paid-status KV updated', { platform: p || 'webflow', platformSiteId, mergedWithExisting: !!existing });
//   } catch (e) {
//     console.error('[CustomCheckout] persistPaidStatusToKv failed', e?.message);
//   }
// }

async function postCheckoutWebflowInject(env, { wfSiteId, site, request, user, billingEmail }) {
  console.log('[CustomCheckout] postCheckoutWebflowInject start', { wfSiteId, siteId: site?.id, cdnScriptId: site?.cdnScriptId });
  if (!wfSiteId || !env.WEBFLOW_AUTHENTICATION) {
    console.warn('[CustomCheckout] postCheckoutWebflowInject skipped: missing wfSiteId or WEBFLOW_AUTHENTICATION binding');
    return;
  }
  try {
    const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(wfSiteId);
    if (!kvRaw) { console.warn('[CustomCheckout] no KV entry for wfSiteId=%s — skipping script inject', wfSiteId); return; }
    const kvEntry = JSON.parse(kvRaw);
    const accessToken = kvEntry.accessToken;
    console.log('[CustomCheckout] postCheckoutWebflowInject KV found', { accessToken: !!accessToken, existingWebappSiteId: kvEntry.webappSiteId });
    if (!accessToken) { console.warn('[CustomCheckout] no accessToken in KV for wfSiteId=%s', wfSiteId); return; }

    const embedOrigin = canonicalEmbedOrigin(request, env);
    const scriptUrl = buildEmbedScriptUrl(embedOrigin, site.cdnScriptId)
      || `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;
    console.log('[CustomCheckout] postCheckoutWebflowInject scriptUrl:', scriptUrl);

    const result = await injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, '[CustomCheckout]', kvEntry.webflowScriptId ?? null);
    console.log('[CustomCheckout] postCheckoutWebflowInject injection result:', { success: result.success, webflowScriptId: result.webflowScriptId });

    // Update KV with webapp linkage flags
    const updatedKv = {
      ...kvEntry,
      webappSiteId: site.id,
      webappScriptUrl: scriptUrl,
      cdnScriptId: site.cdnScriptId,
      registeredThroughApp: true,
      isWebappMigrated: true,
      ...(result.webflowScriptId ? { webflowScriptId: result.webflowScriptId } : {}),
      ...(user?.email ? { email: user.email } : {}),
      ...(billingEmail ? { billingEmail } : {}),
    };
    await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify(updatedKv));
    console.log('[CustomCheckout] postCheckoutWebflowInject KV updated with webappSiteId:', site.id);

    // Publish the Webflow site so the injected script goes live immediately
    if (result.success) {
      try {
        const WEBFLOW_API = 'https://api.webflow.com/v2';
        const pubHeaders = {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'accept-version': '1.0.0',
        };
        let customDomains = [];
        try {
          const siteInfoRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}`, { headers: pubHeaders });
          if (siteInfoRes.ok) {
            const siteInfo = await siteInfoRes.json();
            customDomains = (siteInfo.customDomains || []).map(d => d.url || d.name).filter(Boolean);
          }
        } catch (_) {}
        const publishRes = await fetch(`${WEBFLOW_API}/sites/${wfSiteId}/publish`, {
          method: 'POST',
          headers: pubHeaders,
          body: JSON.stringify({ publishToWebflowSubdomain: true, customDomains }),
        });
        if (!publishRes.ok) {
          const err = await publishRes.text();
          console.warn('[CustomCheckout] postCheckoutWebflowInject Webflow publish failed status=%s body=%s', publishRes.status, err);
        } else {
          console.log('[CustomCheckout] postCheckoutWebflowInject Webflow site published wfSiteId=%s', wfSiteId);
        }
      } catch (publishErr) {
        console.warn('[CustomCheckout] postCheckoutWebflowInject Webflow publish error (non-fatal):', publishErr?.message);
      }
    }
  } catch (e) {
    console.error('[CustomCheckout] postCheckoutWebflowInject failed', e?.message, e?.stack);
  }
}

export async function handleCustomCheckout(request, env, ctx) {
  if (request.method !== 'POST') {
    console.warn('[CustomCheckout] rejected: method not POST');
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const secret = trimEnv(env.STRIPE_SECRET_KEY);
  const db = env.CONSENT_WEBAPP;

  console.log('[CustomCheckout] Stripe key mode:', secret ? (secret.startsWith('sk_live') ? 'LIVE' : 'TEST') : 'NOT SET');

  if (!secret) {
    console.error('[CustomCheckout] STRIPE_SECRET_KEY not set');
    return Response.json({ success: false, error: 'Stripe not configured. Set STRIPE_SECRET_KEY.' }, { status: 503 });
  }
  if (!db) {
    console.error('[CustomCheckout] CONSENT_WEBAPP DB binding not set');
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    console.error('[CustomCheckout] invalid JSON body', err);
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  const rawDomain = (body.domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  const siteName = (body.siteName || '').trim() || rawDomain;
  const planId = VALID_PLAN_IDS.includes(body.planId) ? body.planId : null;
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const paymentMethodId = (body.paymentMethodId || '').trim() || null;
  const subscriptionId = (body.subscriptionId || '').trim() || null;
  const wfSiteId = (body.wfSiteId || body.platformId || '').trim() || null;
  const billingEmail = (body.billingEmail || '').trim().toLowerCase() || null;
  const platform = ((body.platform || '').trim().toLowerCase()) || (wfSiteId ? 'webflow' : null);
  const confirmUpgrade = body.confirmUpgrade === true;
  const promotionCodeId = (body.promotionCodeId || '').trim() || null;

  if (!isValidEmail(email)) {
    console.warn('[CustomCheckout] validation failed: invalid email', email);
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (!rawDomain) {
    console.warn('[CustomCheckout] validation failed: missing domain');
    return Response.json({ success: false, error: 'domain is required' }, { status: 400 });
  }
  if (!planId) {
    console.warn('[CustomCheckout] validation failed: invalid planId', body.planId);
    return Response.json({ success: false, error: 'planId must be basic, essential, or growth' }, { status: 400 });
  }
  if (!paymentMethodId && !subscriptionId) {
    console.warn('[CustomCheckout] validation failed: missing paymentMethodId or subscriptionId');
    return Response.json({ success: false, error: 'paymentMethodId (initial) or subscriptionId (after 3DS) is required' }, { status: 400 });
  }

  const priceId = getPriceId(env, planId, interval);
  if (!priceId) {
    const envKey = `STRIPE_PRICE_${planId.toUpperCase()}_${interval === 'yearly' ? 'YEARLY' : 'MONTHLY'}`;
    console.error('[CustomCheckout] missing price env', envKey);
    return Response.json({
      success: false,
      error: `Stripe price not configured. Set ${envKey} to a recurring price_ id.`,
    }, { status: 503 });
  }

  // ── Pre-payment domain check ───────────────────────────────────────────────
  // Run this before touching Stripe so we never charge for a domain conflict.
  if (!subscriptionId) { // skip on phase-2 (3DS confirm) — domain was already checked in phase-1
    const canonDomain = normalizeDomain(rawDomain);
    const existingSite = canonDomain
      ? await db.prepare('SELECT id, organizationId FROM Site WHERE domain = ?1').bind(canonDomain).first().catch(() => null)
      : null;
    if (existingSite) {
      let existingSub = null;
      try { existingSub = await getSubscriptionByOrganization(db, existingSite.organizationId); } catch { /* ignore */ }
      const existingStatus = String(existingSub?.status || '').toLowerCase();
      const isActive = existingStatus === 'active' || existingStatus === 'trialing';
      if (isActive) {
        // Check if the existing site belongs to the same user (by email)
        const ownerUser = await db.prepare(
          'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
        ).bind(existingSite.organizationId).first().catch(() => null);
        const isSameAccount = ownerUser?.email?.toLowerCase() === email.toLowerCase();

        if (!isSameAccount) {
          // Different account — block completely, no upgrade allowed
          console.log('[CustomCheckout] domain pre-check: active under different account', { domain: canonDomain, existingPlan: existingSub?.planId });
          return Response.json({
            success: false,
            code: 'DOMAIN_TAKEN',
            canUpgrade: false,
            message: `This domain is already registered and active under a different account. Please contact support if you believe this is an error.`,
          }, { status: 409 });
        }

        // Same account — offer upgrade
        if (!confirmUpgrade) {
          console.log('[CustomCheckout] domain pre-check: active under same account', { domain: canonDomain, existingPlan: existingSub?.planId, siteId: existingSite.id });
          return Response.json({
            success: false,
            code: 'DOMAIN_EXISTS',
            canUpgrade: true,
            existingPlan: existingSub?.planId || 'unknown',
            existingSiteId: existingSite.id,
            message: `This domain already has an active ${existingSub?.planId || ''} plan on your account. Set confirmUpgrade: true to upgrade it.`,
          }, { status: 409 });
        }
      }
    }
  }

  const hasBrevoConfig = Boolean(env.BREVO_API_KEY);
  const cookieFlags = hasBrevoConfig
    ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

  // ── Phase 2: subscription already created, confirm provisioning after 3DS ──
  if (subscriptionId) {
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const sub = await subRes.json();
    if (sub.error) {
      return Response.json({ success: false, error: sub.error.message || 'Subscription not found' }, { status: 400 });
    }
    if (sub.status !== 'active' && sub.status !== 'trialing') {
      return Response.json({
        success: false,
        error: `Payment not yet confirmed. Subscription status: ${sub.status}. Complete the 3D Secure step first.`,
      }, { status: 402 });
    }
    try {
      const { user, isNewUser, session, site, org } = await provisionAccount(db, env, request, {
        email,
        domain: rawDomain,
        siteName,
        planId,
        interval,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: sub.customer,
        stripePriceId: sub.items?.data?.[0]?.price?.id || priceId,
        subscriptionStatus: sub.status,
        currentPeriodStart: toTimestamp(sub.current_period_start),
        currentPeriodEnd: toTimestamp(sub.current_period_end),
        amountCents: sub.items?.data?.[0]?.price?.unit_amount ?? null,
        billingEmail,
        wfSiteId,
        platform,
      });
      if (wfSiteId && platform === 'webflow') postCheckoutWebflowInject(env, { wfSiteId, site, request, user, billingEmail }).catch(e => console.error('[CustomCheckout] postCheckoutWebflowInject outer error', e?.message));
      if (platform && wfSiteId) persistPaidStatusToKv(env, { platform, platformSiteId: wfSiteId, site, user }).catch(() => {});
      const _orgId = org?.id ?? org?.organizationId;
      let _emailTo = billingEmail || email;
      let _emailSource = billingEmail ? 'checkout-billingEmail' : 'account-email';
      if (_orgId) {
        try {
          const _userRow = await db.prepare(
            'SELECT u.billingEmail FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
          ).bind(_orgId).first();
          if (_userRow?.billingEmail) { _emailTo = _userRow.billingEmail; _emailSource = 'user.billingEmail'; }
        } catch (e) { /* fall back to billingEmail || email */ }
      }
      const _invoiceData = await fetchStripeInvoice(secret, subscriptionId || sub?.id, interval);
      console.log('[CustomCheckout] sending paid-plan email', { to: _emailTo, source: _emailSource, domain: rawDomain, planId, hasInvoice: !!_invoiceData });
      sendPaidPlanEmail(env, ctx, { to: _emailTo, name: '', domain: rawDomain, planName: planId, invoice: _invoiceData });
      return Response.json(
        { success: true, provisioned: true, isNewUser, user: { id: user.id, email: user.email, name: user.name }, siteId: site.id, subscriptionId },
        { status: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${session.id}; ${cookieFlags}` } },
      );
    } catch (e) {
      if (e.code === 'DOMAIN_EXISTS') {
        return Response.json({ success: false, error: 'This domain is already registered to an active account.' }, { status: 409 });
      }
      console.error('[CustomCheckout] provisioning error (phase 2)', e);
      return Response.json({ success: false, error: 'Account setup failed after payment. Contact support with your email.' }, { status: 500 });
    }
  }

  // ── Phase 1: create customer + subscription ────────────────────────────────
  let customerId;
  try {
    customerId = await findOrCreateStripeCustomer(secret, email, paymentMethodId);
  } catch (e) {
    console.error('[CustomCheckout] findOrCreateStripeCustomer failed', e);
    return Response.json({ success: false, error: e.message || 'Failed to set up payment method' }, { status: 400 });
  }

  const subParams = new URLSearchParams();
  subParams.set('customer', customerId);
  subParams.set('items[0][price]', priceId);
  subParams.set('items[0][quantity]', '1');
  subParams.set('default_payment_method', paymentMethodId);
  subParams.set('payment_behavior', 'default_incomplete');
  subParams.set('payment_settings[save_default_payment_method]', 'on_subscription');
  subParams.set('expand[]', 'latest_invoice.payment_intent');
  subParams.set('trial_period_days', '14');
  // Store context in metadata so the webhook or phase-2 call can reference it
  subParams.set('metadata[source]', 'custom_checkout');
  subParams.set('metadata[email]', email);
  subParams.set('metadata[domain]', rawDomain);
  subParams.set('metadata[siteName]', siteName);
  subParams.set('metadata[planId]', planId);
  subParams.set('metadata[interval]', interval);
  if (wfSiteId) {
    subParams.set('metadata[platformId]', wfSiteId);
    subParams.set('metadata[platform]', 'webflow');
  }
  if (billingEmail) subParams.set('metadata[billingEmail]', billingEmail);

  // ── Apply promotion code (optional) ────────────────────────────────────────
  // Re-validate server-side — never trust the client's claim.
  if (promotionCodeId) {
    try {
      const verifyRes = await fetch(
        `https://api.stripe.com/v1/promotion_codes/${promotionCodeId}`,
        { headers: { Authorization: `Bearer ${secret}` } },
      );
      const verify = await verifyRes.json();
      if (verify.error || !verify.active) {
        return Response.json({ success: false, error: 'Promotion code is no longer valid' }, { status: 400 });
      }
      subParams.set('discounts[0][promotion_code]', promotionCodeId);
      subParams.set('metadata[promotionCode]', verify.code || '');
    } catch (e) {
      console.error('[CustomCheckout] promotion code verify failed', e?.message);
      return Response.json({ success: false, error: 'Promotion code validation failed' }, { status: 400 });
    }
  }

  const subRes = await fetch('https://api.stripe.com/v1/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: subParams.toString(),
  });
  const sub = await subRes.json();

  if (sub.error) {
    console.error('[CustomCheckout] Stripe subscription create failed', sub.error);
    return Response.json({ success: false, error: sub.error.message || 'Failed to create subscription' }, { status: 400 });
  }

  const subStatus = sub.status;
  const paymentIntent = sub.latest_invoice?.payment_intent;

  // Payment succeeded immediately (trial start or card charged without 3DS)
  if (subStatus === 'active' || subStatus === 'trialing') {
    try {
      const { user, isNewUser, session, site, org } = await provisionAccount(db, env, request, {
        email,
        domain: rawDomain,
        siteName,
        planId,
        interval,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: customerId,
        stripePriceId: sub.items?.data?.[0]?.price?.id || priceId,
        subscriptionStatus: subStatus,
        currentPeriodStart: toTimestamp(sub.current_period_start),
        currentPeriodEnd: toTimestamp(sub.current_period_end),
        amountCents: sub.items?.data?.[0]?.price?.unit_amount ?? null,
        billingEmail,
        wfSiteId,
        platform,
      });
      if (wfSiteId && platform === 'webflow') postCheckoutWebflowInject(env, { wfSiteId, site, request, user, billingEmail }).catch(e => console.error('[CustomCheckout] postCheckoutWebflowInject outer error', e?.message));
      if (platform && wfSiteId) persistPaidStatusToKv(env, { platform, platformSiteId: wfSiteId, site, user }).catch(() => {});
      const _orgId = org?.id ?? org?.organizationId;
      let _emailTo = billingEmail || email;
      let _emailSource = billingEmail ? 'checkout-billingEmail' : 'account-email';
      if (_orgId) {
        try {
          const _userRow = await db.prepare(
            'SELECT u.billingEmail FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
          ).bind(_orgId).first();
          if (_userRow?.billingEmail) { _emailTo = _userRow.billingEmail; _emailSource = 'user.billingEmail'; }
        } catch (e) { /* fall back to billingEmail || email */ }
      }
      const _invoiceData = await fetchStripeInvoice(secret, subscriptionId || sub?.id, interval);
      console.log('[CustomCheckout] sending paid-plan email', { to: _emailTo, source: _emailSource, domain: rawDomain, planId, hasInvoice: !!_invoiceData });
      sendPaidPlanEmail(env, ctx, { to: _emailTo, name: '', domain: rawDomain, planName: planId, invoice: _invoiceData });
      return Response.json(
        { success: true, provisioned: true, isNewUser, user: { id: user.id, email: user.email, name: user.name }, siteId: site.id, subscriptionId: sub.id },
        { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': `sid=${session.id}; ${cookieFlags}` } },
      );
    } catch (e) {
      if (e.code === 'DOMAIN_EXISTS') {
        return Response.json({ success: false, error: 'This domain is already registered to an active account.' }, { status: 409 });
      }
      console.error('[CustomCheckout] provisioning error (phase 1)', e);
      return Response.json({ success: false, error: 'Payment succeeded but account setup failed. Contact support.' }, { status: 500 });
    }
  }

  // 3DS required — return clientSecret for frontend to confirm
  if (
    paymentIntent?.status === 'requires_action' ||
    paymentIntent?.status === 'requires_payment_method'
  ) {
    return Response.json({
      success: true,
      requiresAction: true,
      clientSecret: paymentIntent.client_secret,
      subscriptionId: sub.id,
    });
  }

  console.error('[CustomCheckout] unexpected status', { subStatus, piStatus: paymentIntent?.status, sub });
  return Response.json({ success: false, error: `Unexpected subscription status: ${subStatus}` }, { status: 400 });
}

// GET /api/validate-coupon?code=<customer-facing code>
//
// Looks up an active Stripe promotion code by its customer-facing string and
// returns the underlying promo_xxx id + the coupon's discount details so the
// frontend can show "Coupon X — −20%" and re-send the promotionCodeId on
// checkout. Server-side re-validates the code before applying.
export async function handleValidateCoupon(request, env) {
  const secret = trimEnv(env.STRIPE_SECRET_KEY);
  if (!secret) {
    return Response.json({ valid: false, error: 'Stripe not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  if (!code) {
    return Response.json({ valid: false, error: 'code required' }, { status: 400 });
  }

  let promo = null;
  try {
    // Promotion codes don't support /search — use the list endpoint with `code` filter.
    // `code` is case-insensitive in Stripe's list filter.
    const params = new URLSearchParams({
      code,
      active: 'true',
      limit: '1',
    });
    const res = await fetch(
      `https://api.stripe.com/v1/promotion_codes?${params.toString()}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    const data = await res.json();
    if (data?.error) {
      console.warn('[ValidateCoupon] Stripe list error', data.error?.message);
      return Response.json({ valid: false, error: data.error.message || 'Coupon lookup failed' }, { status: 400 });
    }
    promo = data?.data?.[0];
  } catch (e) {
    console.error('[ValidateCoupon] fetch failed', e?.message);
    return Response.json({ valid: false, error: 'Coupon lookup failed' }, { status: 500 });
  }

  if (!promo || !promo.active) {
    return Response.json({ valid: false, error: 'Invalid or expired code' }, { status: 200 });
  }

  const c = promo.coupon || {};
  return Response.json({
    valid: true,
    promotionCodeId: promo.id,           // promo_xxx — send back on checkout
    code: promo.code,
    name: c.name || promo.code,
    percentOff: c.percent_off ?? null,
    amountOff: c.amount_off ?? null,     // in cents
    currency: c.currency || 'usd',
    duration: c.duration,                // 'once' | 'repeating' | 'forever'
    durationInMonths: c.duration_in_months ?? null,
  });
}
