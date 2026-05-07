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
} from '../services/db.js';
import { injectScriptIntoWebflowHead } from './webflowFreeRegister.js';

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

/** Find existing Stripe customer by email or create a new one, attaching the payment method. */
async function findOrCreateStripeCustomer(secret, email, paymentMethodId) {
  const normalized = email.trim().toLowerCase();
  const query = encodeURIComponent(`email:'${normalized}'`);
  console.log('[CustomCheckout/Stripe] searching customer by email', normalized);
  const searchRes = await fetch(
    `https://api.stripe.com/v1/customers/search?query=${query}&limit=1`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const searchData = await searchRes.json();
  console.log('[CustomCheckout/Stripe] customer search result', { httpStatus: searchRes.status, found: searchData?.data?.length || 0, error: searchData?.error });
  if (searchData.error) {
    throw new Error(searchData.error.message || 'Stripe customer search failed');
  }
  if (searchData.data?.length > 0 && searchData.data[0].id) {
    const customerId = searchData.data[0].id;
    if (paymentMethodId) {
      console.log('[CustomCheckout/Stripe] attaching PM to existing customer', { customerId, paymentMethodId });
      const attachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ customer: customerId }).toString(),
      });
      const attachData = await attachRes.json();
      console.log('[CustomCheckout/Stripe] attach result', { httpStatus: attachRes.status, error: attachData?.error });
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
  console.log('[CustomCheckout/Stripe] creating new customer', normalized);
  const createRes = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const created = await createRes.json();
  console.log('[CustomCheckout/Stripe] customer create result', { httpStatus: createRes.status, id: created?.id, error: created?.error });
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

  const licenseKey = await generateUniqueLicenseKey(db);
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
    if (platformSiteIdToStore) { sets.push(`platformSiteId = COALESCE(platformSiteId, ?${binds.length + 1}), platform = COALESCE(platform, ?${binds.length + 2})`); binds.push(platformSiteIdToStore, 'webflow'); }
    sets.push(`updatedAt = ?${binds.length + 1}`); binds.push(new Date().toISOString());
    binds.push(site.id);
    await db.prepare(`UPDATE Site SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run().catch(() => {});
  }

  const session = await createSession(db, { userId: user.id });
  return { user, isNewUser, session, org, site };
}

async function postCheckoutWebflowInject(env, { wfSiteId, site, request }) {
  if (!wfSiteId || !env.WEBFLOW_AUTHENTICATION) return;
  try {
    const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(wfSiteId);
    if (!kvRaw) { console.warn('[CustomCheckout] no KV entry for wfSiteId=%s — skipping script inject', wfSiteId); return; }
    const kvEntry = JSON.parse(kvRaw);
    const accessToken = kvEntry.accessToken;
    if (!accessToken) { console.warn('[CustomCheckout] no accessToken in KV for wfSiteId=%s', wfSiteId); return; }

    const embedOrigin = canonicalEmbedOrigin(request, env);
    const scriptUrl = buildEmbedScriptUrl(embedOrigin, site.cdnScriptId)
      || `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;

    const result = await injectScriptIntoWebflowHead(wfSiteId, scriptUrl, accessToken, '[CustomCheckout]', kvEntry.webflowScriptId ?? null);
    console.log('[CustomCheckout] Webflow script inject result=%s scriptUrl=%s', result.success, scriptUrl);

    // Update KV with webapp linkage flags
    const updatedKv = {
      ...kvEntry,
      webappSiteId: site.id,
      webappScriptUrl: scriptUrl,
      cdnScriptId: site.cdnScriptId,
      registeredThroughApp: true,
      isWebappMigrated: true,
      ...(result.webflowScriptId ? { webflowScriptId: result.webflowScriptId } : {}),
    };
    await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify(updatedKv));
    console.log('[CustomCheckout] KV updated for wfSiteId=%s webappSiteId=%s', wfSiteId, site.id);
  } catch (e) {
    console.error('[CustomCheckout] postCheckoutWebflowInject failed', e?.message);
  }
}

export async function handleCustomCheckout(request, env) {
  console.log('[CustomCheckout] >>> request received', { method: request.method, url: request.url });

  if (request.method !== 'POST') {
    console.warn('[CustomCheckout] rejected: method not POST');
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const secret = trimEnv(env.STRIPE_SECRET_KEY);
  const db = env.CONSENT_WEBAPP;

  console.log('[CustomCheckout] env check', {
    hasStripeSecret: Boolean(secret),
    hasDB: Boolean(db),
    hasBasicMonthly: Boolean(trimEnv(env.STRIPE_PRICE_BASIC_MONTHLY)),
    hasEssentialMonthly: Boolean(trimEnv(env.STRIPE_PRICE_ESSENTIAL_MONTHLY)),
    hasEssentialYearly: Boolean(trimEnv(env.STRIPE_PRICE_ESSENTIAL_YEARLY)),
    hasGrowthMonthly: Boolean(trimEnv(env.STRIPE_PRICE_GROWTH_MONTHLY)),
  });

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
    console.log('[CustomCheckout] parsed body', {
      hasPaymentMethodId: Boolean(body?.paymentMethodId),
      hasSubscriptionId: Boolean(body?.subscriptionId),
      email: body?.email,
      domain: body?.domain,
      siteName: body?.siteName,
      planId: body?.planId,
      interval: body?.interval,
    });
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

  console.log('[CustomCheckout] normalized input', { email, rawDomain, siteName, planId, interval, hasPM: !!paymentMethodId, hasSubId: !!subscriptionId });

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
  console.log('[CustomCheckout] resolved priceId', { planId, interval, priceId });
  if (!priceId) {
    const envKey = `STRIPE_PRICE_${planId.toUpperCase()}_${interval === 'yearly' ? 'YEARLY' : 'MONTHLY'}`;
    console.error('[CustomCheckout] missing price env', envKey);
    return Response.json({
      success: false,
      error: `Stripe price not configured. Set ${envKey} to a recurring price_ id.`,
    }, { status: 503 });
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
      const { user, isNewUser, session, site } = await provisionAccount(db, env, request, {
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
      });
      if (wfSiteId) postCheckoutWebflowInject(env, { wfSiteId, site, request }).catch(() => {});
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
  console.log('[CustomCheckout] phase 1: finding/creating Stripe customer for', email);
  let customerId;
  try {
    customerId = await findOrCreateStripeCustomer(secret, email, paymentMethodId);
    console.log('[CustomCheckout] Stripe customerId', customerId);
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

  console.log('[CustomCheckout] creating subscription', { email, domain: rawDomain, planId, interval });

  const subRes = await fetch('https://api.stripe.com/v1/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: subParams.toString(),
  });
  const sub = await subRes.json();
  console.log('[CustomCheckout] Stripe subscription response', {
    httpStatus: subRes.status,
    id: sub?.id,
    status: sub?.status,
    error: sub?.error,
    latestInvoicePaymentIntentStatus: sub?.latest_invoice?.payment_intent?.status,
  });

  if (sub.error) {
    console.error('[CustomCheckout] Stripe subscription create failed', sub.error);
    return Response.json({ success: false, error: sub.error.message || 'Failed to create subscription' }, { status: 400 });
  }

  const subStatus = sub.status;
  const paymentIntent = sub.latest_invoice?.payment_intent;

  // Payment succeeded immediately (trial start or card charged without 3DS)
  if (subStatus === 'active' || subStatus === 'trialing') {
    try {
      const { user, isNewUser, session, site } = await provisionAccount(db, env, request, {
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
      });
      if (wfSiteId) postCheckoutWebflowInject(env, { wfSiteId, site, request }).catch(() => {});
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
    console.log('[CustomCheckout] 3DS required — returning clientSecret', { subId: sub.id, piStatus: paymentIntent.status });
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
