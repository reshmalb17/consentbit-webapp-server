// POST /api/webhooks/stripe - raw body required for signature verification
//
// Subscribe to: checkout.session.completed, payment_intent.succeeded, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed, charge.refunded, refund.created, refund.updated
//
//   payment_intent.succeeded  - bulk one-time payment: create license keys, add to queue (cron creates 4 subscriptions at a time)
//   checkout.session.completed - single: save subscription from session (per-site license); bulk: audit only (licenses enqueued from payment_intent.succeeded)
//   customer.subscription.updated / .deleted / invoice.payment_failed - sync Subscription table
//   charge.refunded / refund.created / refund.updated - a refund cancels the subscription and raises an admin-dashboard notification

import {
  ensureSchema,
  saveSubscription,
  getSubscriptionByStripeId,
  getSubscriptionBySiteId,
  savePaymentEvent,
  enqueueBulkLicenseJobs,
  markPaymentIntentProcessed,
  generateUniqueLicenseKey,
  generateLicenseKeys,
  createSite,
  inferTierPlanIdFromStripePriceId,
  markTrialUsed,
  claimPaymentFailureEmail,
} from '../services/db.js';
import { capturePostHogEvent as _phCapture, identifyPostHogPerson as _phIdentify, identifyPostHogSite as _phSite } from '../services/posthog.js';
import { captureGa4Event as _ga4Capture } from '../services/ga4.js';
import { sendWelcomeEmail, sendPaidPlanEmail, sendPaymentFailureEmail } from '../services/email.js';
import {
  syncPurchaseToLegacy,
  syncSubscriptionUpdateToLegacy,
  syncSubscriptionDeletedToLegacy,
} from '../services/syncLegacy.js';
import { addCustomerToClickUp, wasClickUpTaskCreated, markClickUpTaskCreated } from '../services/clickup.js';
import { createAdminNotification } from '../services/adminNotifications.js';
import {
  classifyTransition,
  recordPlanTransition,
  transitionDedupeKey,
} from '../services/planTransitions.js';

/**
 * ClickUp gets NEW PURCHASES ONLY — never a failed/pending transaction.
 * A subscription counts as purchased when Stripe says it is 'active' or 'trialing'.
 * Anything else ('incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'canceled')
 * means no money settled. When the subscription status isn't known (no subscription on
 * the session yet), fall back to the Checkout Session's own payment_status.
 */
function isPaidForClickUp({ rawSubStatus, paymentStatus }) {
  if (rawSubStatus) return rawSubStatus === 'active' || rawSubStatus === 'trialing';
  return paymentStatus === 'paid' || paymentStatus === 'no_payment_required';
}

/** Find existing Stripe customer by email, or create one (Use Case 3 / bulk guest checkout). */
async function findOrCreateStripeCustomerByEmail(env, email) {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret || !email || !email.includes('@')) return null;
  const normalized = email.trim().toLowerCase();
  try {
    const query = encodeURIComponent(`email:'${normalized}'`);
    const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=${query}&limit=1`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const searchData = await searchRes.json();
    if (searchData.data && searchData.data.length > 0 && searchData.data[0].id) {
      return searchData.data[0].id;
    }
    const createParams = new URLSearchParams();
    createParams.set('email', normalized);
    const createRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: createParams.toString(),
    });
    const createData = await createRes.json();
    if (createData.id) return createData.id;
    return null;
  } catch (e) {
    console.warn('[StripeWebhook] findOrCreateStripeCustomerByEmail failed', e.message);
    return null;
  }
}

const capturePostHogEvent = _phCapture;
const identifyPostHogPerson = _phIdentify;
const identifyPostHogSite = _phSite;

function toTimestamp(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
  return ts;
}

async function verifyStripeSignature(payload, signature, secret) {
  const parts = {};
  signature.split(',').forEach((p) => {
    const [k, v] = p.split('=');
    parts[k] = v;
  });
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex === v1;
}

async function injectWebflowScript(accessToken, wfSiteId, scriptSrc) {
  // Step 1: register the script (idempotent)
  const registerBody = {
    sourceCode: `(function(){var s=document.createElement('script');s.src=${JSON.stringify(scriptSrc)};s.async=true;s.setAttribute('data-display-name','ConsentBitScript2025');(document.head||document.getElementsByTagName('head')[0]).appendChild(s);})();`,
    version: '1.0.2',
    displayName: 'ConsentBitScript2025',
    location: 'header',
    canCopy: false,
  };
  const registerRes = await fetch(`https://api.webflow.com/v2/sites/${wfSiteId}/registered_scripts/inline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'accept-version': '1.0.0',
    },
    body: JSON.stringify(registerBody),
  });
  const registerData = await registerRes.json();

  if (registerRes.status === 401 || registerRes.status === 403) {
    return false;
  }

  let scriptId = registerData.id || registerData.scriptId;

  // Script already registered — derive the id from displayName (Webflow lowercases it)
  if (!scriptId && registerData.code === 'duplicate_registered_script') {
    scriptId = registerBody.displayName.toLowerCase().replace(/\s+/g, '');
  }

  if (!scriptId) {
    return false;
  }

  // Step 2: fetch existing applied scripts, remove old ConsentBit ones, add new
  let existingScripts = [];
  try {
    const listRes = await fetch(`https://api.webflow.com/v2/sites/${wfSiteId}/custom_code`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'accept-version': '1.0.0' },
    });
    const listData = await listRes.json();
    existingScripts = listData.scripts || [];
  } catch (e) {
    // could not fetch existing scripts
  }

  // Remove old ConsentBit scripts (ConsentBitBanner* from cb-server, consentbitscript2025 from previous runs)
  const filtered = existingScripts.filter(s => {
    const id = (s.id || '').toLowerCase();
    return !id.startsWith('consentbitbanner') && !id.startsWith('consentbitscript2025');
  });
  const applyBody = { scripts: [...filtered, { id: scriptId, location: 'header', version: registerBody.version }] };

  const applyRes = await fetch(`https://api.webflow.com/v2/sites/${wfSiteId}/custom_code`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'accept-version': '1.0.0',
    },
    body: JSON.stringify(applyBody),
  });
  const applyData = await applyRes.json();

  if (!applyRes.ok) {
    return false;
  }

  // Publish site so custom code changes go live immediately
  const publishRes = await fetch(`https://api.webflow.com/v2/sites/${wfSiteId}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'accept-version': '1.0.0',
    },
    body: JSON.stringify({ publishToWebflowSubdomain: true }),
  });
  await publishRes.json();
  return true;
}

async function handleLegacyWebflowUpgrade(env, db, siteId, newSubId, resolvedPlanId) {

  const siteRow = await db.prepare(
    'SELECT domain, platform, isLegacy, platformSiteId, cdnScriptId FROM Site WHERE id = ?1'
  ).bind(siteId).first();

  if (!siteRow) { return; }
  if (!siteRow.isLegacy) { return; }
  if (!['webflow', 'framer'].includes(siteRow.platform)) { return; }

  const domain = siteRow.domain;
  const wfSiteId = siteRow.platformSiteId;
  const cdnScriptId = siteRow.cdnScriptId;
  const isFramer = siteRow.platform === 'framer';
  const kv = isFramer ? env.ACTIVE_SITES_CONSENTBIT_FRAMER : env.ACTIVE_SITES_CONSENTBIT;


  // 1. Update plan in KV
  if (kv && domain) {
    const existing = await kv.get(domain, { type: 'json' });
    if (existing) {
      await kv.put(domain, JSON.stringify({ ...existing, plan: resolvedPlanId }));

      // Cancel old legacy Stripe subscription
      const oldLegacySubId = existing.subscriptionId;
      if (oldLegacySubId && oldLegacySubId !== newSubId && env.STRIPE_SECRET_KEY) {
        try {
          const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(oldLegacySubId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          await cancelRes.json();
        } catch (e) {
          // exception cancelling old legacy sub
        }
      }
    }
  }

  // 2. Write cdnScriptId, siteId, plan to WEBFLOW_AUTHENTICATION KV (keyed by platformSiteId)
  if (!isFramer && wfSiteId && env.WEBFLOW_AUTHENTICATION) {
    try {
      const raw = await env.WEBFLOW_AUTHENTICATION.get(wfSiteId);
      const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};

      let userEmail = null;
      let userBillingEmail = null;
      try {
        const userRow = await db.prepare(
          'SELECT u.email, u.billingEmail FROM User u JOIN OrganizationMember om ON om.userId = u.id JOIN Site s ON s.organizationId = om.organizationId WHERE s.id = ?1 LIMIT 1'
        ).bind(siteId).first();
        userEmail = userRow?.email ?? null;
        userBillingEmail = userRow?.billingEmail ?? null;
      } catch (_) {}

      await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify({
        ...existing,
        cdnScriptId,
        webappSiteId: siteId,
        plan: resolvedPlanId,
        upgradedThroughApp: true,
        isWebappMigrated: true,
        ...(userEmail ? { email: userEmail } : {}),
        ...(userBillingEmail ? { billingEmail: userBillingEmail } : {}),
      }));
    } catch (e) {
      // WEBFLOW_AUTHENTICATION update failed
    }
  }

  // 3. Inject CDN script into Webflow site via Webflow API (Webflow only, not Framer)
  if (isFramer) {
    return;
  }
  if (!wfSiteId) { return; }
  if (!cdnScriptId) { return; }
  if (!env.WEBFLOW_AUTHENTICATION) { return; }

  try {
    const raw = await env.WEBFLOW_AUTHENTICATION.get(wfSiteId);
    if (!raw) { return; }
    const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const accessToken = wfData.accessToken;
    if (!accessToken) { return; }

    const cdnBase = env.CDN_BASE_URL || 'https://manager.consentbit.com';
    const scriptSrc = `${cdnBase}/consentbit/${cdnScriptId}/script.js`;

    await injectWebflowScript(accessToken, wfSiteId, scriptSrc);
  } catch (e) {
    // exception during Webflow script inject
  }
}

// ---------------------------------------------------------------------------
// Refunds
//
// A refund is the customer getting their money back — the subscription must stop.
// Stripe does NOT do this for you: refunding a charge leaves the subscription
// happily active and renewing. So on a FULL refund we cancel the subscription
// immediately (Stripe + D1 + legacy KV) and raise a notification in the admin
// dashboard naming the affected site. A PARTIAL refund is left running — it is
// usually a goodwill credit, not an exit — but still raises a notification so an
// operator can decide.
// ---------------------------------------------------------------------------

/** GET a Stripe resource; returns null on any failure so refund handling never throws. */
async function stripeGet(env, path) {
  if (!env.STRIPE_SECRET_KEY) return null;
  try {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const data = await res.json();
    return data?.error ? null : data;
  } catch (e) {
    console.warn('[StripeWebhook] stripeGet failed', path, e?.message);
    return null;
  }
}

/** Stripe fields are sometimes an id string, sometimes an expanded object. */
function stripeId(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id || null;
}

/**
 * Subscription id behind an invoice. Older API versions put it on `invoice.subscription`;
 * from 2025-xx it moved under `invoice.parent.subscription_details.subscription`, so read both.
 */
function subscriptionIdFromInvoice(invoice) {
  return (
    stripeId(invoice?.subscription) ||
    stripeId(invoice?.parent?.subscription_details?.subscription) ||
    null
  );
}

function formatMoney(cents, currency) {
  if (cents == null) return 'an unknown amount';
  return `${(cents / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`;
}

/** Cancel a Stripe subscription right now. Already-canceled is treated as success. */
async function cancelStripeSubscriptionNow(env, stripeSubscriptionId) {
  if (!stripeSubscriptionId || !env.STRIPE_SECRET_KEY) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    const data = await res.json();
    if (data?.error) {
      // The refund may have been issued from the Stripe dashboard with "cancel
      // subscription" ticked, in which case it is already gone — not a failure.
      const msg = String(data.error.message || '');
      const alreadyGone = /no such subscription|canceled/i.test(msg);
      console.warn('[StripeWebhook] refund cancel — Stripe said:', msg);
      return { ok: alreadyGone, reason: msg };
    }
    return { ok: true, status: data?.status || 'canceled' };
  } catch (e) {
    console.error('[StripeWebhook] refund cancel failed', e?.message);
    return { ok: false, reason: e?.message || 'exception' };
  }
}

/**
 * Work out which of our records a refunded charge belongs to: the Stripe
 * subscription, our Subscription row, and the site/owner behind it.
 */
async function resolveRefundContext(env, db, charge) {
  const customerId = stripeId(charge?.customer);

  // charge → invoice → subscription is the reliable chain for recurring payments.
  let stripeSubscriptionId = null;
  const invoiceId = stripeId(charge?.invoice);
  let invoice = typeof charge?.invoice === 'object' ? charge.invoice : null;
  if (!invoice && invoiceId) invoice = await stripeGet(env, `invoices/${invoiceId}`);
  if (invoice) stripeSubscriptionId = subscriptionIdFromInvoice(invoice);

  // Our row: by subscription id, else the customer's most recent live row. A bulk
  // one-time payment has no invoice at all and simply finds nothing here.
  let row = stripeSubscriptionId ? await getSubscriptionByStripeId(db, stripeSubscriptionId).catch(() => null) : null;
  if (!row && customerId) {
    row = await db
      .prepare(
        `SELECT * FROM Subscription
           WHERE stripeCustomerId = ?1
           ORDER BY CASE WHEN status IN ('active', 'trialing') THEN 0 ELSE 1 END, updatedAt DESC
           LIMIT 1`
      )
      .bind(customerId)
      .first()
      .catch(() => null);
  }
  if (!stripeSubscriptionId) {
    stripeSubscriptionId = row?.stripeSubscriptionId ?? row?.stripesubscriptionid ?? null;
  }

  const organizationId = row?.organizationId ?? row?.organizationid ?? null;
  const siteId = row?.siteId ?? row?.siteid ?? null;

  let domain = null;
  let platform = null;
  if (siteId) {
    const site = await db
      .prepare('SELECT domain, platform FROM Site WHERE id = ?1 LIMIT 1')
      .bind(siteId)
      .first()
      .catch(() => null);
    domain = site?.domain || null;
    platform = site?.platform || null;
  }

  let userEmail = charge?.billing_details?.email || charge?.receipt_email || null;
  if (organizationId) {
    const user = await db
      .prepare(
        'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
      )
      .bind(organizationId)
      .first()
      .catch(() => null);
    if (user?.email) userEmail = user.email;
  }
  if (!userEmail && customerId) {
    const cust = await stripeGet(env, `customers/${customerId}`);
    userEmail = cust?.email || null;
  }

  return {
    row,
    customerId,
    stripeSubscriptionId,
    organizationId,
    siteId,
    domain,
    platform,
    userEmail,
    planId: row?.planId ?? row?.planid ?? null,
    interval: row?.interval ?? 'monthly',
  };
}

/**
 * Handle one refunded charge: cancel on a full refund, always record a
 * PaymentEvent and an admin notification.
 *
 * @param {object} charge  the Stripe Charge (must be the refreshed one — its
 *                         amount_refunded is what decides full vs partial)
 * @param {object} [refund] the Refund object, when the event carried one
 */
async function processRefund(env, db, ctx, { charge, refund, eventId, eventType }) {
  const chargeId = charge?.id || null;
  const refundId = refund?.id || charge?.refunds?.data?.[0]?.id || null;
  const currency = charge?.currency || refund?.currency || 'usd';
  const chargeAmount = charge?.amount ?? null;
  const refundedAmount = charge?.amount_refunded ?? refund?.amount ?? null;
  const isFull =
    chargeAmount != null && refundedAmount != null
      ? refundedAmount >= chargeAmount
      : charge?.refunded === true;

  const ctxRef = await resolveRefundContext(env, db, charge);
  const {
    row, customerId, stripeSubscriptionId, organizationId, siteId, domain, platform, userEmail,
  } = ctxRef;

  console.log('[StripeWebhook] refund —', eventType,
    '| chargeId:', chargeId, '| refundId:', refundId,
    '| refunded:', refundedAmount, 'of', chargeAmount,
    '| full:', isFull, '| subId:', stripeSubscriptionId, '| site:', domain || siteId);

  // --- Cancel, on a full refund only -------------------------------------
  //
  // Nothing to cancel when the refund has no subscription behind it — a refunded
  // bulk one-time payment, or a charge we could not match to a customer. Those
  // still raise a notification below; they just must not push empty rows into the
  // legacy DB / KV, which key on the subscription and domain.
  const cancelling = isFull && !!(stripeSubscriptionId || row?.id);
  let cancelResult = null;
  if (cancelling) {
    if (stripeSubscriptionId) {
      cancelResult = await cancelStripeSubscriptionNow(env, stripeSubscriptionId);
    }
    if (row?.id) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `UPDATE Subscription
              SET status = 'canceled', canceledAt = ?1, cancelAtPeriodEnd = 0, updatedAt = ?2
            WHERE id = ?3`
        )
        .bind(now, now, row.id)
        .run()
        .catch((e) => console.warn('[StripeWebhook] refund — D1 cancel failed:', e?.message));
    }

    // Legacy DB + ACTIVE_SITES KV: flips the site inactive so the banner stops
    // serving, same path a real cancellation takes.
    if (stripeSubscriptionId || domain) {
      ctx.waitUntil(
        syncSubscriptionDeletedToLegacy(env, {
          email: userEmail,
          domain,
          subscriptionId: stripeSubscriptionId,
          customerId,
          platform,
        }).catch((e) => console.warn('[StripeWebhook] refund — legacy sync failed:', e?.message))
      );
    }

    if (userEmail) {
      ctx.waitUntil(
        (async () => {
          await capturePostHogEvent(env, userEmail, 'subscription_refunded', {
            plan: ctxRef.planId,
            interval: ctxRef.interval,
            org_id: organizationId,
            site_id: siteId,
            amount_refunded: refundedAmount != null ? refundedAmount / 100 : null,
            currency: String(currency).toUpperCase(),
            ...(platform ? { platform } : {}),
          });
          await identifyPostHogPerson(env, userEmail, {
            subscription_status: 'canceled',
            lifecycle_stage: 'refunded',
            did_refund: true,
            refunded_at: new Date().toISOString(),
            ...(platform ? { platform } : {}),
          });
        })().catch(() => {})
      );
    }
  }

  // --- Audit trail --------------------------------------------------------
  await savePaymentEvent(db, {
    eventType,
    stripeEventId: eventId,
    stripeInvoiceId: stripeId(charge?.invoice),
    subscriptionId: row?.id ?? null,
    organizationId,
    amountCents: refundedAmount,
    failureReason: refund?.reason || charge?.refunds?.data?.[0]?.reason || null,
    rawPayload: {
      chargeId,
      refundId,
      amountRefunded: refundedAmount,
      chargeAmount,
      currency,
      full: isFull,
      stripeSubscriptionId,
      cancelled: cancelling,
      cancelResult,
    },
  }).catch((e) => console.warn('[StripeWebhook] refund — savePaymentEvent failed:', e?.message));

  // --- Admin dashboard notification --------------------------------------
  const site = domain || siteId || 'an unidentified site';
  const amountText = formatMoney(refundedAmount, currency);
  const to = userEmail ? ` to ${userEmail}` : '';
  await createAdminNotification(db, {
    type: isFull ? 'refund.full' : 'refund.partial',
    severity: isFull ? 'critical' : 'warning',
    title: isFull
      ? cancelling
        ? `Refund of ${amountText} — ${site} cancelled`
        : `Refund of ${amountText} — no subscription matched`
      : `Partial refund of ${amountText} — ${site}`,
    message: isFull
      ? cancelling
        ? `A full refund was issued${to}. The subscription has been cancelled and the site is no longer served.`
        : `A full refund was issued${to}, but no subscription could be matched to the charge — nothing was cancelled automatically. Check Stripe and cancel by hand if one is still running.`
      : `A partial refund of ${amountText}${chargeAmount != null ? ` (of ${formatMoney(chargeAmount, currency)})` : ''} was issued${to}. The subscription is still active — cancel it manually if that is not intended.`,
    siteId,
    domain,
    organizationId,
    userEmail,
    subscriptionId: row?.id ?? null,
    stripeSubscriptionId,
    stripeCustomerId: customerId,
    stripeChargeId: chargeId,
    stripeRefundId: refundId,
    amountCents: refundedAmount,
    currency,
    detail: {
      eventType,
      stripeEventId: eventId,
      chargeAmount,
      amountRefunded: refundedAmount,
      reason: refund?.reason || charge?.refunds?.data?.[0]?.reason || null,
      platform,
      plan: ctxRef.planId,
      interval: ctxRef.interval,
      subscriptionCancelled: cancelling,
      cancelResult,
      matchedSubscriptionRow: !!row,
    },
    // One row per refund however many times Stripe re-delivers it, and however
    // many event types (charge.refunded + refund.updated) describe the same money.
    dedupeKey: refundId ? `refund:${refundId}` : chargeId ? `charge-refund:${chargeId}:${refundedAmount}` : null,
  });
}

export async function handleStripeWebhook(request, env, ctx) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: 'Webhook secret not set' }, { status: 503 });
  }

  const rawBody = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!sig) {
    return Response.json({ error: 'No signature' }, { status: 400 });
  }

  const ok = await verifyStripeSignature(rawBody, sig, secret);
  if (!ok) {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);
  const eventId = event.id;
  const type = event.type;
  console.log('[StripeWebhook] event received — type:', type, '| eventId:', eventId);

  try {
    // payment_intent.succeeded: bulk one-time payment — create license keys and add to queue (cron creates subscriptions, 4 at a time)
    if (type === 'payment_intent.succeeded') {
      let pi = event.data.object;
      let meta = pi.metadata || {};

      // Fetch full PaymentIntent from API when metadata or customer missing (webhook payload often omits them for Checkout)
      if (pi.id && env.STRIPE_SECRET_KEY && (Object.keys(meta).length === 0 || !pi.customer)) {
        try {
          const res = await fetch(`https://api.stripe.com/v1/payment_intents/${pi.id}`, {
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          const fetched = await res.json();
          if (fetched.metadata && Object.keys(fetched.metadata).length > 0) meta = fetched.metadata;
          if (fetched.customer) pi = { ...pi, customer: fetched.customer };
        } catch (e) {
          // fetch PI failed
        }
      }

    const planType = meta.planType;
    const orgId = meta.organizationId;
    let customerId = pi.customer;
    const isBulk = planType === 'bulk' && !!orgId;

    // Use Case 3 / bulk guest checkout: no customer at PaymentIntent creation; find or create by email
    if (isBulk && !customerId && meta.email) {
      customerId = await findOrCreateStripeCustomerByEmail(env, meta.email);
    }

    if (isBulk) {
      const already = await markPaymentIntentProcessed(db, pi.id);
      if (!already) {
        return Response.json({ received: true });
      }
      const quantity = Math.max(1, parseInt(meta.quantity, 10) || 1);
      const interval = meta.interval === 'yearly' ? 'yearly' : 'monthly';
      const recurringPriceId = interval === 'yearly'
        ? (env.STRIPE_PRICE_YEARLY || env.STRIPE_PRICE_MONTHLY)
        : env.STRIPE_PRICE_MONTHLY;
      if (!recurringPriceId || !customerId) {
        // missing price or customer
      } else {
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const trialEnd = interval === 'yearly' ? nowSec + 365 * 24 * 3600 : nowSec + 31 * 24 * 3600;
          await enqueueBulkLicenseJobs(db, {
            organizationId: orgId,
            stripeCustomerId: customerId,
            quantity,
            recurringPriceId,
            interval,
            trialEnd,
          });
        } catch (err) {
          throw err;
        }
      }
      await savePaymentEvent(db, {
        eventType: 'payment_intent.succeeded',
        stripeEventId: eventId,
        organizationId: orgId,
        rawPayload: { paymentIntentId: pi.id, planType: 'bulk', quantity },
      });
    }
      return Response.json({ received: true });
    }

    if (type === 'checkout.session.completed') {
      // Idempotency check — Stripe retries webhooks, skip if already processed
      const alreadyProcessed = await db.prepare(
        `SELECT id FROM PaymentEvent WHERE stripeEventId = ?1 LIMIT 1`
      ).bind(eventId).first();
      if (alreadyProcessed) {
        return Response.json({ received: true });
      }

      const session = event.data.object;
      const subId = session.subscription;
      const sessionMeta = session.metadata || {};
      console.log('[WEBHOOK] checkout.session.completed — sessionId:', session.id, '| subId:', subId, '| sessionMeta:', JSON.stringify(sessionMeta));
      let orgId = session.client_reference_id || sessionMeta.organizationId;
      let siteId = sessionMeta.siteId && String(sessionMeta.siteId).trim() ? String(sessionMeta.siteId).trim() : null;
      let platformSiteId = sessionMeta.platformId?.trim() || sessionMeta.wfSiteId?.trim() || null;
      let platform = sessionMeta.platform?.trim() || null;
      let billingEmailMeta = sessionMeta.billingEmail?.trim().toLowerCase() || null;
      let siteNameMeta = sessionMeta.siteName && String(sessionMeta.siteName).trim() ? String(sessionMeta.siteName).trim() : null;
      let siteDomainMeta = sessionMeta.siteDomain && String(sessionMeta.siteDomain).trim() ? String(sessionMeta.siteDomain).trim() : null;
      let currentPeriodStart = null;
      let currentPeriodEnd = null;
      let interval = sessionMeta.interval || 'monthly';

      let planTypeMeta = sessionMeta.planType || 'single';
      let subMeta = {};
      let stripePriceFromSub = null;
      let subscriptionStatus = 'active';
      // Real Stripe status, unclamped. `subscriptionStatus` above is normalised to
      // 'active' for the DB write, so it can't be used to tell a paid subscriber from
      // an `incomplete` / `incomplete_expired` (failed payment) one.
      let rawSubStatus = null;

      // Metadata is on the Subscription, not Session — fetch subscription to get siteId/siteName/siteDomain
      if (subId && env.STRIPE_SECRET_KEY) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          const subData = await subRes.json();
          subMeta = subData.metadata || {};
          rawSubStatus = subData.status || null;
          if (subData.status === 'trialing' || subData.status === 'active') {
            subscriptionStatus = subData.status;
          }
          if (subMeta.planType) planTypeMeta = subMeta.planType;
          if (subMeta.interval) interval = subMeta.interval;
          if (subData.current_period_start) currentPeriodStart = toTimestamp(subData.current_period_start);
          if (subData.current_period_end) currentPeriodEnd = toTimestamp(subData.current_period_end);
          if (!orgId) orgId = subMeta.organizationId;
          if (!siteId && subMeta.siteId) siteId = String(subMeta.siteId).trim() || null;
          if (!siteNameMeta && subMeta.siteName) siteNameMeta = String(subMeta.siteName).trim() || null;
          if (!siteDomainMeta && subMeta.siteDomain) siteDomainMeta = String(subMeta.siteDomain).trim() || null;
          if (!platformSiteId && (subMeta.platformId || subMeta.wfSiteId)) platformSiteId = String(subMeta.platformId || subMeta.wfSiteId).trim() || null;
          if (!platform && subMeta.platform) platform = String(subMeta.platform).trim() || null;
          if (!billingEmailMeta && subMeta.billingEmail) billingEmailMeta = String(subMeta.billingEmail).trim().toLowerCase() || null;
          stripePriceFromSub = subData.items?.data?.[0]?.price?.id || null;
          if (!subMeta.planId && stripePriceFromSub) {
            const inferred = inferTierPlanIdFromStripePriceId(env, stripePriceFromSub);
            if (inferred) subMeta = { ...subMeta, planId: inferred };
          }
        } catch (e) {
          // Could not fetch subscription
        }
      }

      // Quantity plan: one subscription with quantity, N license keys, all renew together
      if (subId && orgId && planTypeMeta === 'quantity') {
        const qty = Math.max(10, Math.min(100, parseInt(String(sessionMeta.quantity || subMeta.quantity || '10'), 10) || 10));
        const licenseKeys = await generateLicenseKeys(qty, db);
        await savePaymentEvent(db, {
          eventType: 'checkout.session.completed',
          stripeEventId: eventId,
          organizationId: orgId,
          rawPayload: { subscriptionId: subId, planType: 'quantity', quantity: qty },
        });
        await saveSubscription(db, {
          organizationId: orgId,
          siteId: null,
          stripeSubscriptionId: subId,
          stripeCustomerId: session.customer,
          planType: 'quantity',
          interval,
          status: 'active',
          currentPeriodStart,
          currentPeriodEnd,
          licenseKeys,
          quantity: qty,
          amountCents: session.amount_total ?? null,
        });
        return Response.json({ received: true });
      }

      // Single plan: session has subscription id — save it with site license (siteId, licenseKey, expiry)
      if (subId && orgId) {
        // If wfSiteId passed, look up existing Site by platformSiteId first — avoids creating a duplicate
        if (!siteId && platformSiteId && db) {
          try {
            const existingByPlatform = await db.prepare('SELECT id FROM Site WHERE platformSiteId = ?1 LIMIT 1').bind(platformSiteId).first();
            if (existingByPlatform) {
              siteId = existingByPlatform.id;
            }
          } catch (e) {
            // platformSiteId lookup failed
          }
        }

        // If no existing siteId but we have siteName/siteDomain from checkout, create the Site now
        if (!siteId && siteDomainMeta && db) {
          try {
            const domainNorm = siteDomainMeta.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
            const name = siteNameMeta || domainNorm;
            const createdSite = await createSite(db, {
              organizationId: orgId,
              name,
              domain: siteDomainMeta,
              origin: '',
              bannerType: 'gdpr',
              regionMode: 'gdpr',
            });
            siteId = createdSite.id;
            // Step 5 — new unique JS snippet created via the checkout webhook path.
            if (createdSite._created) {
              try {
                const _sgEmail = (session.customer_email || session.customer_details?.email || '').trim().toLowerCase();
                if (_sgEmail) {
                  await capturePostHogEvent(env, _sgEmail, 'script_generated', {
                    site_id: createdSite.id,
                    domain: createdSite.domain,
                    platform: platform || 'webapp',
                    ...(createdSite.id ? { $groups: { site: String(createdSite.id) } } : {}),
                  });
                  await _ga4Capture(env, _sgEmail, 'script_generated', {
                    site_id: createdSite.id,
                    domain: createdSite.domain,
                    platform: platform || 'webapp',
                  });
                }
              } catch (phErr) { /* analytics only */ }
            }
          } catch (e) {
            // Failed to create site from checkout metadata
          }
        }

        // Update Site.platformSiteId if we have a wfSiteId and the site exists
        if (siteId && platformSiteId && db) {
          db.prepare('UPDATE Site SET platformSiteId = ?1, platform = COALESCE(platform, ?2), updatedAt = ?3 WHERE id = ?4 AND (platformSiteId IS NULL OR platformSiteId = "")')
            .bind(platformSiteId, platform || 'webflow', new Date().toISOString(), siteId)
            .run()
            .catch(() => {});
        }

        await savePaymentEvent(db, {
          eventType: 'checkout.session.completed',
          stripeEventId: eventId,
          organizationId: orgId,
          rawPayload: { subscriptionId: subId, siteId },
        });

        // Check if this org has ever had a subscription (determines whether to send welcome email)
        let isFirstPurchase = false;
        if (orgId) {
          try {
            const priorSub = await db.prepare('SELECT id FROM Subscription WHERE organizationId = ?1 LIMIT 1').bind(orgId).first();
            isFirstPurchase = !priorSub;
          } catch (e) { /* ignore — default false */ }
        }

        // Reuse existing license key on upgrade so the site key stays stable across plan changes.
        let licenseKey = null;
        if (siteId) {
          const existingSubForSite = await getSubscriptionBySiteId(db, siteId).catch(() => null);
          licenseKey = existingSubForSite?.licenseKey ?? existingSubForSite?.licensekey ?? null;
          if (!licenseKey) licenseKey = await generateUniqueLicenseKey(db);
        }
        let resolvedPlanId = subMeta.planId || null;
        if (!resolvedPlanId && stripePriceFromSub) {
          resolvedPlanId = inferTierPlanIdFromStripePriceId(env, stripePriceFromSub);
        }
        console.log('[WEBHOOK] resolved — orgId:', orgId, '| siteId:', siteId, '| platformSiteId:', platformSiteId, '| planId:', resolvedPlanId, '| status:', subscriptionStatus);
        await saveSubscription(db, {
          organizationId: orgId,
          siteId: siteId || null,
          stripeSubscriptionId: subId,
          stripeCustomerId: session.customer,
          stripePriceId: stripePriceFromSub,
          planType: planTypeMeta === 'tier' ? 'tier' : 'single',
          planId: resolvedPlanId,
          interval,
          status: subscriptionStatus,
          currentPeriodStart,
          currentPeriodEnd,
          licenseKey,
          amountCents: session.amount_total ?? null,
        });

        // PostHog: use email as canonical distinct_id to match client-side events
        if (orgId) {
          const _phEmail = (session.customer_email || session.customer_details?.email || '').trim().toLowerCase() || null;
          // Resolve PostHog platform: checkout metadata → Site.platform (DB) → default 'webapp'.
          // Webflow/Framer set platform explicitly (metadata and/or DB column); webapp leaves it
          // null, so a null result here means webapp. Wrapped in try/catch so this PostHog-only
          // lookup can never throw or affect the payment/webhook flow.
          let _phPlatform = platform || null;
          if (!_phPlatform && siteId && db) {
            try {
              const _phSiteRow = await db.prepare('SELECT platform FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
              _phPlatform = _phSiteRow?.platform || null;
            } catch (e) { /* ignore — PostHog attribution only */ }
          }
          _phPlatform = _phPlatform || 'webapp';
          if (_phEmail) {
            await capturePostHogEvent(env, _phEmail, 'subscription_activated', {
              status: subscriptionStatus,
              plan: resolvedPlanId,
              plan_tier: resolvedPlanId,
              interval,
              billing_cycle: /^(year|annual)/i.test(String(interval)) ? 'annual' : 'monthly',
              ...(typeof session.amount_total === 'number' ? { price: session.amount_total / 100 } : {}),
              currency: (session.currency || 'usd').toUpperCase(),
              site_id: siteId || null,
              org_id: orgId,
              is_first_purchase: isFirstPurchase,
              ...(siteId ? { $groups: { site: siteId } } : {}),
              $set: { email: _phEmail, plan: resolvedPlanId, subscription_status: subscriptionStatus, plan_tier: resolvedPlanId, ...(_phPlatform ? { platform: _phPlatform } : {}), did_start_trial: subscriptionStatus === 'trialing', ...(subscriptionStatus === 'trialing' ? { trial_started_at: new Date().toISOString() } : { did_convert_to_paid: true, converted_at: new Date().toISOString() }) },
            });
            // Step 10 — same event to GA4 via Measurement Protocol. `value` +
            // `currency` are GA4's monetization params, so revenue shows up in
            // reports without needing a separate `purchase` event.
            await _ga4Capture(env, _phEmail, 'subscription_activated', {
              plan_tier: resolvedPlanId,
              billing_cycle: /^(year|annual)/i.test(String(interval)) ? 'annual' : 'monthly',
              ...(typeof session.amount_total === 'number' ? { value: session.amount_total / 100 } : {}),
              currency: (session.currency || 'usd').toUpperCase(),
              status: subscriptionStatus,
              site_id: siteId || null,
              platform: _phPlatform || 'webapp',
            });
            // Update site group with new plan — tracks per-site status independently
            if (siteId) {
              await identifyPostHogSite(env, _phEmail, siteId, {
                subscription_status: subscriptionStatus,
                plan_tier: resolvedPlanId,
                interval,
                owner_email: _phEmail,
                ...(_phPlatform ? { platform: _phPlatform } : {}),
                ...(subscriptionStatus === 'trialing' ? { trial_started_at: new Date().toISOString() } : { paid_at: new Date().toISOString() }),
              });
            }
          }
        }

        // Store billingEmail on Site — prefer explicit billing email, fall back to account email
        const checkoutEmailRaw = (session.customer_email || session.customer_details?.email || subMeta.email || sessionMeta.email || '').trim().toLowerCase();
        const billingEmailToStore = billingEmailMeta || checkoutEmailRaw || null;
        if (siteId && billingEmailToStore) {
          db.prepare('UPDATE Site SET billingEmail = ?1, updatedAt = ?2 WHERE id = ?3')
            .bind(billingEmailToStore, new Date().toISOString(), siteId)
            .run()
            .catch(() => {});
        }

        // Store billingEmail on User if explicitly provided at checkout
        if (billingEmailMeta && orgId) {
          db.prepare(
            'UPDATE User SET billingEmail = ?1, updatedAt = ?2 WHERE id = (SELECT userId FROM OrganizationMember WHERE organizationId = ?3 LIMIT 1)'
          ).bind(billingEmailMeta, new Date().toISOString(), orgId).run().catch(() => {});
        }

        // Sync email: if checkout email differs from stored User email, update User + WEBFLOW_AUTHENTICATION KV
        const checkoutEmail = checkoutEmailRaw;
        if (checkoutEmail && orgId) {
          try {
            const userRow = await db.prepare(
              'SELECT u.id, u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
            ).bind(orgId).first();
            if (userRow && userRow.email !== checkoutEmail) {
              await db.prepare('UPDATE User SET email = ?1, updatedAt = ?2 WHERE id = ?3').bind(checkoutEmail, new Date().toISOString(), userRow.id).run();
              // Update WEBFLOW_AUTHENTICATION KV if wfSiteId known
              if (platformSiteId && env.WEBFLOW_AUTHENTICATION) {
                const kvRaw = await env.WEBFLOW_AUTHENTICATION.get(platformSiteId);
                if (kvRaw) {
                  const kvEntry = JSON.parse(kvRaw);
                  await env.WEBFLOW_AUTHENTICATION.put(platformSiteId, JSON.stringify({ ...kvEntry, email: checkoutEmail }));
                }
              }
            }
          } catch (e) {
            // email sync failed
          }
        }

        // Mark trial as used on the site so it can never be granted again
        if (subscriptionStatus === 'trialing' && siteId) {
          try { await markTrialUsed(db, siteId); } catch (e) {
            // markTrialUsed failed
          }
        }

        // Cancel the old subscription now that the new one is active (upgrade/downgrade flow)
        const oldStripeSubscriptionId = subMeta.oldStripeSubscriptionId
          ? String(subMeta.oldStripeSubscriptionId).trim()
          : null;
        if (oldStripeSubscriptionId && oldStripeSubscriptionId !== subId && env.STRIPE_SECRET_KEY) {
          try {
            const cancelRes = await fetch(
              `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(oldStripeSubscriptionId)}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
              },
            );
            const cancelData = await cancelRes.json();
          } catch (e) {
            // error cancelling old subscription
          }
        }

        // Send paid-plan confirmation email in the background
        const customerEmail = session.customer_email || session.customer_details?.email;
        const customerName  = session.customer_details?.name || '';
        const planName      = resolvedPlanId || subMeta.planId || 'Basic';
        if (customerEmail) {
          // Resolve billing email: use user's billingEmail if set, else fall back to checkout email
          let emailTo = customerEmail;
          let emailSource = 'customer-email';
          if (orgId) {
            try {
              const userForEmail = await db.prepare(
                'SELECT u.billingEmail FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
              ).bind(orgId).first();
              if (userForEmail?.billingEmail) { emailTo = userForEmail.billingEmail; emailSource = 'user.billingEmail'; }
            } catch (e) {
              // billingEmail lookup failed, use customerEmail
            }
          }
          console.log('[StripeWebhook] sending paid-plan email', { to: emailTo, source: emailSource, domain: siteDomainMeta, planName });

          // Fetch the latest invoice for this subscription to include in the email
          let invoiceData = null;
          if (subId && env.STRIPE_SECRET_KEY) {
            try {
              const invRes = await fetch(
                `https://api.stripe.com/v1/invoices?subscription=${subId}&limit=1`,
                { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
              );
              const invJson = await invRes.json();
              const inv = invJson?.data?.[0];
              if (inv && !inv.error) {
                invoiceData = {
                  invoiceNumber: inv.number || null,
                  invoiceUrl:    inv.hosted_invoice_url || null,
                  invoicePdf:    inv.invoice_pdf || null,
                  amountPaid:    inv.amount_paid != null ? (inv.amount_paid / 100).toFixed(2) : null,
                  currency:      (inv.currency || 'usd').toUpperCase(),
                  date:          inv.created ? new Date(inv.created * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null,
                  interval:      interval || 'monthly',
                };
              }
            } catch (e) {
              // Could not fetch invoice for email
            }
          }
          // Send welcome email first if this is their first-ever purchase
          if (isFirstPurchase) {
            sendWelcomeEmail(env, ctx, { to: emailTo, name: customerName });
          }

          // For Essential/Growth plans purchased through the Webflow/Framer app,
          // send the IAB/TCF setup email instead of the generic paid-plan email.
          // Resolve platform: prefer checkout metadata, else look it up from the Site row.
          let emailPlatform = platform || null;
          if (!emailPlatform && siteId && db) {
            try {
              const siteRow = await db.prepare('SELECT platform FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
              emailPlatform = siteRow?.platform || null;
            } catch (_) {}
          }
          const planLc     = String(resolvedPlanId || '').toLowerCase();
          const platformLc = String(emailPlatform || '').toLowerCase();
          const emailVariant =
            (planLc === 'essential' || planLc === 'growth') &&
            (platformLc === 'webflow' || platformLc === 'framer')
              ? 'tcf'
              : 'default';

          sendPaidPlanEmail(env, ctx, {
            to:       emailTo,
            name:     customerName,
            domain:   siteDomainMeta || '',
            planName,
            invoice:  invoiceData,
            variant:  emailVariant,
          });
        }

        // Add customer to ClickUp list on new payment
        // Resolve platform from Site table if not present in checkout metadata.
        // Dedup by Stripe subscription id: the same subscriber may also arrive via
        // customer.subscription.updated (see that handler below) — mark on success so
        // it is added exactly once.
        ctx.waitUntil((async () => {
          // Only real purchases go to ClickUp. checkout.session.completed also fires for
          // sessions whose payment never settled (delayed/async payment methods, cards that
          // fail the first invoice → subscription 'incomplete' → 'incomplete_expired').
          // Those subscribers must NOT create a task; when/if the payment does succeed,
          // customer.subscription.updated (active/trialing) picks them up instead.
          if (!isPaidForClickUp({ rawSubStatus, paymentStatus: session.payment_status })) {
            console.log('[ClickUp] skipped — payment not settled. subId:', subId,
              '| subStatus:', rawSubStatus, '| payment_status:', session.payment_status);
            return;
          }
          if (subId && await wasClickUpTaskCreated(env, subId)) return;
          let resolvedPlatform = platform || null;
          if (!resolvedPlatform && siteId && db) {
            try {
              const siteRow = await db.prepare('SELECT platform FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
              resolvedPlatform = siteRow?.platform || null;
            } catch (_) {}
          }
          const added = await addCustomerToClickUp(env, {
            email:           session.customer_email || session.customer_details?.email || null,
            name:            session.customer_details?.name || '',
            platform:        resolvedPlatform,
            plan:            resolvedPlanId || planName || null,
            interval,
            domain:          siteDomainMeta || null,
            amountCents:     session.amount_total ?? null,
            currency:        session.currency || 'usd',
            subscriptionId:  subId || null,
            customerId:      session.customer || null,
            isFirstPurchase,
          }).catch(() => false);
          if (added && subId) await markClickUpTaskCreated(env, subId);
        })());

        // Stamp plan into WEBFLOW_AUTHENTICATION KV so the Webflow Designer Extension can
        // read it directly. platformSiteId may be null for webapp upgrades (not in metadata),
        // so fall back to looking it up from the Site table.
        if (resolvedPlanId && env.WEBFLOW_AUTHENTICATION) {
          ctx.waitUntil((async () => {
            try {
              let wfId = platformSiteId || null;
              console.log('[WEBHOOK] KV stamp — starting. platformSiteId:', wfId, '| siteId:', siteId);
              if (!wfId && siteId) {
                const siteRow = await db.prepare('SELECT platformSiteId FROM Site WHERE id = ?1 LIMIT 1').bind(siteId).first();
                wfId = siteRow?.platformSiteId ?? null;
                console.log('[WEBHOOK] KV stamp — platformSiteId from DB lookup:', wfId);
              }
              if (wfId) {
                const raw = await env.WEBFLOW_AUTHENTICATION.get(wfId);
                const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
                await env.WEBFLOW_AUTHENTICATION.put(wfId, JSON.stringify({ ...existing, plan: resolvedPlanId }));
                console.log('[WEBHOOK] KV stamp — success. wfId:', wfId, '| plan:', resolvedPlanId);
              } else {
                console.warn('[WEBHOOK] KV stamp — skipped: no platformSiteId found for siteId:', siteId);
              }
            } catch (e) {
              console.error('[WEBHOOK] KV stamp — error:', e?.message);
            }
          })());
        }

        // Legacy Webflow upgrade: if site is isLegacy=1 + platform=webflow/framer,
        // sync plan to KV and inject CDN script into Webflow site via Webflow API
        if (siteId && resolvedPlanId && ['essential', 'growth'].includes(resolvedPlanId)) {
          ctx.waitUntil(handleLegacyWebflowUpgrade(env, db, siteId, subId, resolvedPlanId).catch(() => {}));
        }

        // Outbound sync → LEGACY_DB + KV (non-blocking)
        ctx.waitUntil(
          syncPurchaseToLegacy(env, {
            email: session.customer_email || session.customer_details?.email || null,
            domain: siteDomainMeta || null,
            subscriptionId: subId,
            customerId: session.customer,
            status: subscriptionStatus,
            platform: null,
            licenseKey: licenseKey || null,
            interval,
            cancelAtPeriodEnd: 0,
          }).catch(() => {})
        );
      }
      return Response.json({ received: true });
    }

    // A trial (or any directly-API-created) subscription's FIRST webhook is
    // customer.subscription.created (status 'trialing'), and Stripe may never fire a
    // subsequent .updated during the trial. The .updated/.deleted handler below never sees
    // these, so add them to ClickUp here. Add-only — DB sync stays with checkout.session.completed
    // and the .updated handler. Deduped by Stripe subscription id (shared key across all three
    // entry points) so a subscriber is added exactly once regardless of which event lands first.
    if (type === 'customer.subscription.created') {
      const sub = event.data.object;

      // --- Plan transition: first purchase / trial start --------------------
      // This event is the ONLY one a trial reliably fires (see the note above),
      // and the .updated/.deleted handler below is never reached for it — this
      // branch returns. Without recording here, the two conversions that matter
      // most, free → trial and free → paid, would never be logged at all.
      //
      // Same status guard as the ClickUp block: the custom-checkout flow creates
      // subscriptions with payment_behavior=default_incomplete, so every card
      // entry — including declines and abandoned 3DS — fires this event with
      // status 'incomplete'. Logging those would invent conversions that never
      // happened.
      if (sub.status === 'trialing' || sub.status === 'active') {
        ctx.waitUntil((async () => {
          try {
            const existing = await getSubscriptionByStripeId(db, sub.id).catch(() => null);
            const orgId = existing?.organizationId ?? existing?.organizationid
              ?? sub.metadata?.organizationId ?? null;
            const siteId = existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null;

            let tier = sub.metadata?.planId || existing?.planId || existing?.planid || null;
            const priceId = sub.items?.data?.[0]?.price?.id ?? null;
            if (!tier || !['basic', 'essential', 'growth'].includes(String(tier).toLowerCase())) {
              tier = inferTierPlanIdFromStripePriceId(env, priceId) || tier;
            }

            let email = null;
            let domain = null;
            if (orgId) {
              const u = await db.prepare(
                'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
              ).bind(orgId).first().catch(() => null);
              email = u?.email || null;
            }
            if (siteId) {
              const s = await db.prepare('SELECT domain FROM Site WHERE id = ?1 LIMIT 1')
                .bind(siteId).first().catch(() => null);
              domain = s?.domain || null;
            }

            const kind = sub.status === 'trialing' ? 'trial_started' : 'signup_paid';
            await recordPlanTransition(db, {
              kind,
              fromPlan: 'free',
              toPlan: tier,
              toInterval: sub.items?.data?.[0]?.plan?.interval === 'year' ? 'yearly' : 'monthly',
              toAmountCents: sub.items?.data?.[0]?.price?.unit_amount ?? sub.plan?.amount ?? null,
              currency: sub.currency || 'usd',
              organizationId: orgId,
              siteId,
              domain,
              userEmail: email,
              subscriptionId: existing?.id ?? null,
              stripeSubscriptionId: sub.id,
              occurredAt: new Date().toISOString(),
              detail: {
                eventType: type,
                stripeEventId: eventId,
                stripeStatus: sub.status,
                priceId,
                trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
              },
              dedupeKey: transitionDedupeKey(kind, sub.id, eventId),
            });
          } catch (e) {
            console.warn('[StripeWebhook] subscription.created transition log failed:', e?.message);
          }
        })());
      }

      ctx.waitUntil((async () => {
        try {
          // Only real purchases. The custom-checkout flow creates subscriptions with
          // payment_behavior=default_incomplete, so EVERY card entry — including declines
          // and abandoned 3DS — fires this event with status 'incomplete' before any money
          // moves. Adding those put failed transactions into ClickUp. Trials arrive here as
          // 'trialing' (their only reliable webhook); everything else is picked up by
          // customer.subscription.updated once it actually turns active.
          if (sub.status !== 'trialing' && sub.status !== 'active') {
            console.log('[ClickUp] skipped — subscription.created status not paid:', sub.status, '| subId:', sub.id);
            return;
          }
          if (await wasClickUpTaskCreated(env, sub.id)) return;

          const existing = await getSubscriptionByStripeId(db, sub.id).catch(() => null);
          const cuSiteId = existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null;
          const orgIdForEmail = existing?.organizationId ?? existing?.organizationid ?? sub.metadata?.organizationId ?? null;

          let cuEmail = null;
          let cuName = '';
          let cuPlatform = sub.metadata?.platform || null;
          let cuDomain = sub.metadata?.siteDomain || null;

          if (cuSiteId && db) {
            try {
              const siteRow = await db.prepare('SELECT platform, domain FROM Site WHERE id = ?1 LIMIT 1').bind(cuSiteId).first();
              cuPlatform = cuPlatform || siteRow?.platform || null;
              cuDomain = cuDomain || siteRow?.domain || null;
            } catch (_) {}
          }

          // Prefer the real Stripe customer email/name; fall back to the account email.
          if (sub.customer && env.STRIPE_SECRET_KEY) {
            try {
              const custRes = await fetch(`https://api.stripe.com/v1/customers/${typeof sub.customer === 'string' ? sub.customer : sub.customer?.id}`, {
                headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
              });
              const cust = await custRes.json();
              if (!cust.error) {
                cuEmail = cust.email || null;
                cuName = cust.name || '';
              }
            } catch (_) {}
          }
          if (!cuEmail && orgIdForEmail) {
            try {
              const u = await db.prepare(
                'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
              ).bind(orgIdForEmail).first();
              cuEmail = u?.email || null;
            } catch (_) {}
          }

          let cuPlan = sub.metadata?.planId || existing?.planId || existing?.planid || null;
          const cuPriceId = sub.items?.data?.[0]?.price?.id ?? null;
          if (!cuPlan || !['basic', 'essential', 'growth'].includes(String(cuPlan))) {
            const inferred = inferTierPlanIdFromStripePriceId(env, cuPriceId);
            if (inferred) cuPlan = inferred;
          }
          const cuInterval = sub.items?.data?.[0]?.plan?.interval === 'year' ? 'yearly' : 'monthly';

          const added = await addCustomerToClickUp(env, {
            email:           cuEmail,
            name:            cuName,
            platform:        cuPlatform,
            plan:            cuPlan,
            interval:        cuInterval,
            domain:          cuDomain,
            amountCents:     sub.items?.data?.[0]?.price?.unit_amount ?? sub.plan?.amount ?? null,
            currency:        sub.currency || 'usd',
            subscriptionId:  sub.id,
            customerId:      typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id || null),
            isFirstPurchase: false,
          }).catch(() => false);
          if (added) await markClickUpTaskCreated(env, sub.id);
        } catch (e) {
          console.warn('[StripeWebhook] subscription.created ClickUp add failed:', e?.message);
        }
      })());
      return Response.json({ received: true });
    }

    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      let existing = await getSubscriptionByStripeId(db, sub.id);

      // Fallback: migrated legacy users have stripeSubscriptionId = null in D1 so the lookup
      // above returns nothing. Try matching by stripeCustomerId instead so their D1 row gets
      // updated when Stripe fires cancellation / update webhooks.
      // IMPORTANT: restrict to rows with NO stripeSubscriptionId yet. Without this filter, a
      // `customer.subscription.deleted` event for an OLD (just-upgraded, already-deleted) sub
      // would grab the customer's newest row — the brand-new active upgrade row — and mark it
      // canceled, silently reverting the upgrade. Legacy rows are the only ones missing a sub id.
      if (!existing && sub.customer) {
        existing = await db.prepare(
          `SELECT * FROM Subscription WHERE stripeCustomerId = ?1 AND stripeSubscriptionId IS NULL ORDER BY updatedAt DESC LIMIT 1`
        ).bind(sub.customer).first() ?? null;

        // Stamp the real stripeSubscriptionId onto the row so future webhooks hit the fast path
        if (existing && sub.id) {
          db.prepare(
            `UPDATE Subscription SET stripeSubscriptionId = ?1, updatedAt = ?2 WHERE id = ?3`
          ).bind(sub.id, new Date().toISOString(), existing.id).run().catch(() => {});
        }
      }

      // Guard (belt-and-suspenders): never let an update/delete event for one subscription
      // mutate a D1 row that belongs to a DIFFERENT subscription. Only proceed when the matched
      // row has no sub id yet (legacy, just stamped above) or its sub id matches this event.
      {
        const rowSubId = existing?.stripeSubscriptionId ?? existing?.stripesubscriptionid ?? null;
        if (existing && rowSubId && rowSubId !== sub.id) {
          console.warn('[StripeWebhook] skipping sub update/delete — matched row belongs to a different subscription', {
            eventSubId: sub.id,
            rowSubId,
            rowId: existing.id,
          });
          await savePaymentEvent(db, {
            eventType: type,
            stripeEventId: eventId,
            subscriptionId: existing.id,
            organizationId: existing.organizationId ?? existing.organizationid ?? null,
            rawPayload: { status: sub.status, cancel_at_period_end: sub.cancel_at_period_end },
          });
          return Response.json({ received: true });
        }
      }

      const orgIdFromEvent = sub.metadata?.organizationId;
      const orgIdFinal = existing?.organizationId ?? existing?.organizationid ?? orgIdFromEvent ?? null;
      const status = sub.status === 'canceled' || sub.status === 'unpaid' ? sub.status : 'active';
      const canceledAt = sub.canceled_at ? toTimestamp(sub.canceled_at) : (status === 'canceled' ? new Date().toISOString() : null);

      if (!orgIdFinal && !existing) {
        console.warn('[StripeWebhook] subscription update/delete without organizationId', {
          stripeSubscriptionId: sub.id,
          hasExisting: false,
        });
        await savePaymentEvent(db, {
          eventType: type,
          stripeEventId: eventId,
          subscriptionId: null,
          organizationId: null,
          rawPayload: { status: sub.status, cancel_at_period_end: sub.cancel_at_period_end },
        });
        return Response.json({ received: true });
      }

      const existingPlanType = existing?.planType ?? existing?.plantype ?? 'single';
      let planIdFromMeta = sub.metadata?.planId ?? existing?.planId ?? existing?.planid ?? null;
      const priceIdFromSub = sub.items?.data?.[0]?.price?.id ?? null;
      if (!planIdFromMeta || !['basic', 'essential', 'growth'].includes(String(planIdFromMeta))) {
        const inferred = inferTierPlanIdFromStripePriceId(env, priceIdFromSub);
        if (inferred) planIdFromMeta = inferred;
      }
      const planTypeToSave =
        planIdFromMeta && ['basic', 'essential', 'growth'].includes(String(planIdFromMeta))
          ? 'tier'
          : existingPlanType;
      const intervalFromSub = sub.items?.data?.[0]?.plan?.interval === 'year' ? 'yearly' : 'monthly';
      await saveSubscription(db, {
        id: existing?.id,
        organizationId: orgIdFinal,
        siteId: existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: sub.customer,
        stripePriceId: sub.items?.data?.[0]?.price?.id,
        planType: planTypeToSave,
        planId: planIdFromMeta,
        interval: intervalFromSub,
        status,
        currentPeriodStart: toTimestamp(sub.current_period_start),
        currentPeriodEnd: toTimestamp(sub.current_period_end),
        cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0,
        canceledAt,
        licenseKey: existing?.licenseKey ?? existing?.licensekey ?? null,
        licenseKeys: existing?.licenseKeys ?? existing?.licensekeys ?? undefined,
        quantity: existing?.quantity ?? null,
        amountCents: sub.plan?.amount ?? null,
      });
      await savePaymentEvent(db, {
        eventType: type,
        stripeEventId: eventId,
        subscriptionId: existing?.id,
        organizationId: orgIdFinal,
        rawPayload: { status: sub.status, cancel_at_period_end: sub.cancel_at_period_end },
      });

      // --- Plan transition log ----------------------------------------------
      // This is the ONLY place both sides of a plan change are known: `existing`
      // still holds the row as it was before saveSubscription() overwrote it
      // above, and `sub` carries what Stripe now says. Nothing else in the schema
      // keeps the previous tier, so if this is not written here the change is
      // unrecoverable.
      {
        const prevStatus = event.data.previous_attributes?.status ?? null;
        const kind = classifyTransition({
          fromPlan: existing?.planId ?? existing?.planid ?? 'free',
          toPlan: planIdFromMeta || existing?.planId || existing?.planid || null,
          fromInterval: existing?.interval ?? null,
          toInterval: intervalFromSub,
          // previous_attributes only carries what CHANGED, so an absent status
          // means it did not change and the old one equals the new one.
          fromStatus: prevStatus ?? sub.status,
          toStatus: type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        });

        if (kind) {
          try {
            let ptEmail = null;
            let ptDomain = null;
            const ptSiteId = existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null;
            if (orgIdFinal) {
              const u = await db.prepare(
                'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
              ).bind(orgIdFinal).first();
              ptEmail = u?.email || null;
            }
            if (ptSiteId) {
              const s = await db.prepare('SELECT domain FROM Site WHERE id = ?1 LIMIT 1').bind(ptSiteId).first();
              ptDomain = s?.domain || null;
            }

            await recordPlanTransition(db, {
              kind,
              fromPlan: existing?.planId ?? existing?.planid ?? 'free',
              toPlan: planIdFromMeta || existing?.planId || existing?.planid || null,
              fromInterval: existing?.interval ?? null,
              toInterval: intervalFromSub,
              fromAmountCents: existing?.amountCents ?? existing?.amountcents ?? null,
              toAmountCents: sub.plan?.amount ?? sub.items?.data?.[0]?.price?.unit_amount ?? null,
              currency: sub.currency || 'usd',
              organizationId: orgIdFinal,
              siteId: ptSiteId,
              domain: ptDomain,
              userEmail: ptEmail,
              subscriptionId: existing?.id ?? null,
              stripeSubscriptionId: sub.id,
              occurredAt: new Date().toISOString(),
              detail: { eventType: type, stripeEventId: eventId, prevStatus, newStatus: sub.status },
              // Once-only milestones (first purchase, trial start/convert, cancel)
              // are keyed on the SUBSCRIPTION so they cannot be double-logged by
              // both this handler and the .created one above. Repeatable changes
              // (upgrade, downgrade, interval) stay keyed on the event.
              dedupeKey: transitionDedupeKey(kind, sub.id, eventId),
            });
          } catch (e) {
            console.warn('[StripeWebhook] plan transition log failed:', e?.message);
          }
        }
      }

      // --- Admin dashboard notification: subscription cancelled -------------
      // Raised here rather than in the refund path because a cancellation does
      // not have to involve a refund — the customer may simply have cancelled,
      // or a payment may have failed its way to `unpaid`. The refund handler
      // raises its own row, and the dedupe keys differ, so a refund-driven
      // cancellation legitimately produces one of each.
      if (type === 'customer.subscription.deleted' || sub.status === 'canceled' || sub.status === 'unpaid') {
        try {
          let cnEmail = null;
          let cnDomain = null;
          const cnSiteId = existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null;
          if (orgIdFinal) {
            const u = await db.prepare(
              'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
            ).bind(orgIdFinal).first();
            cnEmail = u?.email || null;
          }
          if (cnSiteId) {
            const s = await db.prepare('SELECT domain FROM Site WHERE id = ?1 LIMIT 1').bind(cnSiteId).first();
            cnDomain = s?.domain || null;
          }

          const cnAmount = sub.plan?.amount ?? sub.items?.data?.[0]?.price?.unit_amount ?? null;
          const cnCurrency = sub.currency || 'usd';
          const where = cnDomain || cnSiteId || 'an unidentified site';
          const unpaid = sub.status === 'unpaid';
          const atPeriodEnd = !!sub.cancel_at_period_end;

          await createAdminNotification(db, {
            type: unpaid ? 'subscription.unpaid' : 'subscription.cancelled',
            // Losing a paying site is worth a look, but it is an expected part of
            // the lifecycle — unlike a refund, which is money going back out.
            severity: 'warning',
            title: unpaid
              ? `Subscription unpaid — ${where}`
              : `Subscription cancelled — ${where}`,
            message: unpaid
              ? `Stripe marked this subscription unpaid after its retries were exhausted. The site is no longer served.`
              : `The ${planIdFromMeta || 'paid'} ${intervalFromSub || ''} subscription for ${where} ended${atPeriodEnd ? ' at the end of its billing period' : ''}. The site is no longer served.`,
            siteId: cnSiteId,
            domain: cnDomain,
            organizationId: orgIdFinal,
            userEmail: cnEmail,
            subscriptionId: existing?.id ?? null,
            stripeSubscriptionId: sub.id,
            stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id || null),
            amountCents: cnAmount,
            currency: cnCurrency,
            detail: {
              eventType: type,
              stripeEventId: eventId,
              stripeStatus: sub.status,
              cancelAtPeriodEnd: atPeriodEnd,
              canceledAt,
              plan: planIdFromMeta,
              interval: intervalFromSub,
              matchedSubscriptionRow: !!existing,
            },
            // One row per subscription per terminal status, however many times
            // Stripe re-delivers the event.
            dedupeKey: `subcancel:${sub.id}:${sub.status}`,
          });
        } catch (e) {
          console.warn('[StripeWebhook] cancellation notification failed:', e?.message);
        }
      }

      // PostHog: track trial → active conversion + cancellation
      {
        let _phEmail = null;
        let _phPlatform = null;
        try {
          const _phUser = await db.prepare(
            'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
          ).bind(orgIdFinal).first();
          _phEmail = _phUser?.email || null;
          const _phSite = (existing?.siteId ?? existing?.siteid) ? await db.prepare('SELECT platform FROM Site WHERE id = ?1 LIMIT 1').bind(existing.siteId ?? existing.siteid).first() : null;
          // Site.platform is authoritative for Webflow/Framer ('webflow'/'framer'); sub metadata
          // covers the case where siteId is missing on the local record. Null everywhere = webapp.
          _phPlatform = _phSite?.platform || sub.metadata?.platform || 'webapp';
        } catch (e) { /* ignore */ }

        // Use email as distinct_id — only fire PostHog if we have the email
        if (_phEmail) {
          if (type === 'customer.subscription.updated') {
            const prevStatus = event.data.previous_attributes?.status;
            if (prevStatus === 'trialing' && sub.status === 'active') {
              const _subPrice = sub.items?.data?.[0]?.price ?? null;
              await capturePostHogEvent(env, _phEmail, 'subscription_activated', {
                status: 'active',
                plan: planIdFromMeta,
                plan_tier: planIdFromMeta,
                interval: intervalFromSub,
                billing_cycle: /^(year|annual)/i.test(String(intervalFromSub)) ? 'annual' : 'monthly',
                ...(typeof _subPrice?.unit_amount === 'number' ? { price: _subPrice.unit_amount / 100 } : {}),
                currency: (_subPrice?.currency || 'usd').toUpperCase(),
                site_id: existing?.siteId ?? existing?.siteid ?? null,
                org_id: orgIdFinal,
                $set: { plan: planIdFromMeta, subscription_status: 'active', plan_tier: planIdFromMeta, did_convert_to_paid: true, converted_at: new Date().toISOString(), ...(_phPlatform ? { platform: _phPlatform } : {}) },
              });
              await _ga4Capture(env, _phEmail, 'subscription_activated', {
                plan_tier: planIdFromMeta,
                billing_cycle: /^(year|annual)/i.test(String(intervalFromSub)) ? 'annual' : 'monthly',
                ...(typeof _subPrice?.unit_amount === 'number' ? { value: _subPrice.unit_amount / 100 } : {}),
                currency: (_subPrice?.currency || 'usd').toUpperCase(),
                status: 'active',
                site_id: existing?.siteId ?? existing?.siteid ?? null,
                platform: _phPlatform || 'webapp',
              });
            }

            // Trial cancellation — fires at click time, not at trial end. The app cancels via
            // cancel_at_period_end, so the sub stays 'trialing' now and only deletes 14 days later.
            // Catch the intent here: cancel flag just flipped true while still in the trial.
            if (sub.status === 'trialing' && sub.cancel_at_period_end === true && (event.data.previous_attributes || {}).cancel_at_period_end === false) {
              await capturePostHogEvent(env, _phEmail, 'trial_cancelled', {
                plan: planIdFromMeta,
                interval: intervalFromSub,
                site_id: existing?.siteId ?? existing?.siteid ?? null,
                org_id: orgIdFinal,
                platform: _phPlatform,
                $set: { did_cancel_in_trial: true, trial_cancelled_at: new Date().toISOString() },
              });
            }

            const previousPlanId = existing?.planId ?? existing?.planid ?? null;
            if (planIdFromMeta && previousPlanId && planIdFromMeta !== previousPlanId) {
              const planOrder = { basic: 1, essential: 2, growth: 3 };
              const isUpgrade = (planOrder[planIdFromMeta] ?? 0) > (planOrder[previousPlanId] ?? 0);
              await capturePostHogEvent(env, _phEmail, isUpgrade ? 'plan_upgraded' : 'plan_downgraded', {
                from_plan: previousPlanId,
                to_plan: planIdFromMeta,
                interval: intervalFromSub,
                org_id: orgIdFinal,
                ...(_phPlatform ? { platform: _phPlatform } : {}),
                $set: { plan_tier: planIdFromMeta, previous_plan_tier: previousPlanId, subscription_status: sub.status, did_upgrade_plan: isUpgrade, ...(isUpgrade ? { upgraded_at: new Date().toISOString(), lifecycle_stage: 'upgraded' } : {}), ...(_phPlatform ? { platform: _phPlatform } : {}) },
              });
            }
          }

          if (type === 'customer.subscription.deleted') {
            await capturePostHogEvent(env, _phEmail, 'subscription_cancelled', {
              plan: planIdFromMeta,
              interval: intervalFromSub,
              org_id: orgIdFinal,
              ...(_phPlatform ? { platform: _phPlatform } : {}),
            });
            await identifyPostHogPerson(env, _phEmail, {
              subscription_status: 'canceled',
              lifecycle_stage: 'canceled',
              did_cancel: true,
              canceled_at: new Date().toISOString(),
              ...(_phPlatform ? { platform: _phPlatform } : {}),
            });
          }
        }
      }

      // Add subscriber to ClickUp exactly once. Trial / direct-checkout subscribers are
      // created via the Stripe API (no hosted Checkout Session), so they never fire
      // checkout.session.completed — this handler is their only reliable webhook. Deduped
      // by Stripe subscription id so hosted-checkout subscribers (already added in that
      // handler) and repeat subscription.updated events don't create duplicate tasks.
      // NOTE: guard on `sub.status` (the raw Stripe status), NOT the `status` local above —
      // that one collapses incomplete / incomplete_expired / past_due into 'active' for the
      // DB write, so using it here let failed transactions through into ClickUp.
      if (type === 'customer.subscription.updated' && (sub.status === 'active' || sub.status === 'trialing')) {
        ctx.waitUntil((async () => {
          try {
            if (await wasClickUpTaskCreated(env, sub.id)) return;

            const cuSiteId = existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null;
            let cuEmail = null;
            let cuName = '';
            let cuPlatform = sub.metadata?.platform || null;
            let cuDomain = sub.metadata?.siteDomain || null;

            if (cuSiteId && db) {
              try {
                const siteRow = await db.prepare('SELECT platform, domain FROM Site WHERE id = ?1 LIMIT 1').bind(cuSiteId).first();
                cuPlatform = cuPlatform || siteRow?.platform || null;
                cuDomain = cuDomain || siteRow?.domain || null;
              } catch (_) {}
            }

            // Prefer the real Stripe customer email/name; fall back to the account email.
            if (sub.customer && env.STRIPE_SECRET_KEY) {
              try {
                const custRes = await fetch(`https://api.stripe.com/v1/customers/${typeof sub.customer === 'string' ? sub.customer : sub.customer?.id}`, {
                  headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
                });
                const cust = await custRes.json();
                if (!cust.error) {
                  cuEmail = cust.email || null;
                  cuName = cust.name || '';
                }
              } catch (_) {}
            }
            if (!cuEmail && orgIdFinal) {
              try {
                const u = await db.prepare(
                  'SELECT u.email FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
                ).bind(orgIdFinal).first();
                cuEmail = u?.email || null;
              } catch (_) {}
            }

            const added = await addCustomerToClickUp(env, {
              email:           cuEmail,
              name:            cuName,
              platform:        cuPlatform,
              plan:            planIdFromMeta || null,
              interval:        intervalFromSub,
              domain:          cuDomain,
              amountCents:     sub.items?.data?.[0]?.price?.unit_amount ?? sub.plan?.amount ?? null,
              currency:        sub.currency || 'usd',
              subscriptionId:  sub.id,
              customerId:      typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id || null),
              isFirstPurchase: false,
            }).catch(() => false);
            if (added) await markClickUpTaskCreated(env, sub.id);
          } catch (e) {
            console.warn('[StripeWebhook] subscription.updated ClickUp add failed:', e?.message);
          }
        })());
      }

      // Outbound sync → LEGACY_DB + KV (non-blocking)
      {
        const siteId = existing?.siteId ?? existing?.siteid ?? null;
        const syncFn = type === 'customer.subscription.deleted'
          ? syncSubscriptionDeletedToLegacy
          : syncSubscriptionUpdateToLegacy;
        ctx.waitUntil(
          (async () => {
            try {
              let domain = null;
              if (siteId) {
                const { getSiteById } = await import('../services/db.js');
                const site = await getSiteById(db, siteId);
                domain = site?.domain || null;
              }
              await syncFn(env, {
                subscriptionId: sub.id,
                customerId: sub.customer,
                domain,
                status,
                cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0,
                interval: intervalFromSub,
              });
            } catch (e) {
              console.warn(`[StripeWebhook] legacy sync failed for ${type}:`, e?.message);
            }
          })()
        );
      }

      return Response.json({ received: true });
    }

    if (type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      console.log('[StripeWebhook] invoice.payment_failed — invoiceId:', invoice.id, '| subId:', invoice.subscription, '| attempt:', invoice.attempt_count, '| amountDue:', invoice.amount_due);
      const subId = invoice.subscription;
      const existing = subId ? await getSubscriptionByStripeId(db, subId) : null;
      await savePaymentEvent(db, {
        eventType: 'invoice.payment_failed',
        stripeEventId: eventId,
        stripeInvoiceId: invoice.id,
        subscriptionId: existing?.id,
        organizationId: existing?.organizationId,
        amountCents: invoice.amount_due,
        attemptCount: invoice.attempt_count,
        nextRetryAt: invoice.next_payment_attempt ? toTimestamp(invoice.next_payment_attempt) : null,
        failureReason: invoice.last_finalization_error?.message || null,
        rawPayload: { attempt_count: invoice.attempt_count },
      });

      // Send payment failure reminder email based on attempt count.
      //
      // Stripe retries an invoice up to 8 times (~every 42h) and re-delivers each
      // webhook until we 2xx, so attempt count alone is not a safe trigger. Only
      // reminders 1 and 2 fire here, each claimed once per invoice; the final
      // notice is sent by the cron FINAL_REMINDER_DELAY_DAYS after reminder 2
      // (see processFinalPaymentReminders in index.js), so attempts 3-8 send
      // nothing. Net: at most 3 emails per invoice.
      const orgId = existing?.organizationId ?? existing?.organizationid;
      if (orgId) {
        try {
          const attempt = invoice.attempt_count || 1;
          const reminderNumber = attempt >= 2 ? 2 : 1;
          const userRow = await db.prepare(
            'SELECT u.email, u.name FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
          ).bind(orgId).first();
          if (userRow?.email) {
            const claimed = await claimPaymentFailureEmail(db, {
              invoiceId: invoice.id,
              reminderNumber,
              recipientEmail: userRow.email,
              recipientName: userRow.name || '',
            });
            if (claimed) {
              const billingUrl = (env.WEBAPP_PUBLIC_URL || 'https://accounts.consentbit.com').replace(/\/$/, '');
              sendPaymentFailureEmail(env, ctx, {
                to: userRow.email,
                name: userRow.name || '',
                updatePaymentUrl: billingUrl,
                reminderNumber,
              });
            } else {
              console.log('[StripeWebhook] dunning reminder', reminderNumber, 'already sent for invoice', invoice.id, '— skipping');
            }
          }
        } catch (e) {
          console.warn('[StripeWebhook] payment failure email lookup failed:', e?.message);
        }
      }

      return Response.json({ received: true });
    }

    // Refunds. `charge.refunded` is the primary event; `refund.created` /
    // `refund.updated` are subscribed to as well because some Stripe API versions
    // deliver only those for refunds issued from the dashboard. All three go
    // through processRefund(), which dedupes on the refund id.
    if (type === 'charge.refunded' || type === 'refund.created' || type === 'refund.updated') {
      // Stripe re-delivers until we 2xx; one PaymentEvent row per delivered event.
      const alreadyLogged = await db.prepare(
        `SELECT id FROM PaymentEvent WHERE stripeEventId = ?1 LIMIT 1`
      ).bind(eventId).first();
      if (alreadyLogged) {
        console.log('[StripeWebhook] refund event already processed —', eventId);
        return Response.json({ received: true });
      }

      let charge = null;
      let refund = null;

      if (type === 'charge.refunded') {
        charge = event.data.object;
        refund = charge?.refunds?.data?.[0] || null;
      } else {
        refund = event.data.object;
        // Only a settled refund moves money. A pending or failed one must not
        // cancel anything — the customer still has the service they paid for.
        if (refund?.status && refund.status !== 'succeeded') {
          console.log('[StripeWebhook] refund ignored — status:', refund.status, '| refundId:', refund.id);
          return Response.json({ received: true });
        }
        const chargeId = stripeId(refund?.charge);
        if (chargeId) charge = await stripeGet(env, `charges/${chargeId}`);
      }

      // The webhook payload's amount_refunded can lag when several refunds land
      // together, and full-vs-partial hinges on it — always re-read the charge.
      if (charge?.id) {
        const fresh = await stripeGet(env, `charges/${charge.id}`);
        if (fresh) charge = fresh;
      }

      // Newer Stripe API versions no longer inline `charge.refunds`, so look the
      // refund up when the event didn't carry one. Its id is the dedupe key that
      // keeps charge.refunded and refund.updated from raising two alerts.
      if (!refund && charge?.id) {
        const list = await stripeGet(env, `refunds?charge=${encodeURIComponent(charge.id)}&limit=1`);
        refund = list?.data?.[0] || charge?.refunds?.data?.[0] || null;
      }

      if (!charge) {
        console.warn('[StripeWebhook] refund — could not resolve the charge; recording nothing.', type, eventId);
        return Response.json({ received: true });
      }

      await processRefund(env, db, ctx, { charge, refund, eventId, eventType: type });
      return Response.json({ received: true });
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error('[StripeWebhook]', type, err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
