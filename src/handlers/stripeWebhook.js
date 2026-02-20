// POST /api/webhooks/stripe - raw body required for signature verification
//
// Subscribe to: checkout.session.completed, payment_intent.succeeded, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed
//
//   payment_intent.succeeded  - bulk one-time payment: create license keys, add to queue (cron creates 4 subscriptions at a time)
//   checkout.session.completed - single: save subscription from session (per-site license); bulk: audit only (licenses enqueued from payment_intent.succeeded)
//   customer.subscription.updated / .deleted / invoice.payment_failed - sync Subscription table

import { ensureSchema, saveSubscription, getSubscriptionByStripeId, savePaymentEvent, enqueueBulkLicenseJobs, markPaymentIntentProcessed, generateUniqueLicenseKey, generateLicenseKeys, createSite } from '../services/db.js';

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

export async function handleStripeWebhook(request, env) {
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
  console.log('[StripeWebhook] received', type, eventId);

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
          if (fetched.customer) console.log('[StripeWebhook] payment_intent.succeeded: got customer from API');
        } catch (e) {
          console.warn('[StripeWebhook] payment_intent.succeeded: fetch PI failed', e.message);
        }
      }

    const planType = meta.planType;
    const orgId = meta.organizationId;
    let customerId = pi.customer;
    const isBulk = planType === 'bulk' && !!orgId;

    // Use Case 3 / bulk guest checkout: no customer at PaymentIntent creation; find or create by email
    if (isBulk && !customerId && meta.email) {
      customerId = await findOrCreateStripeCustomerByEmail(env, meta.email);
      if (customerId) {
        console.log('[StripeWebhook] payment_intent.succeeded: found/created customer by email for bulk', customerId);
      }
    }

    console.log('[StripeWebhook] payment_intent.succeeded', { piId: pi.id, planType, orgId, hasCustomer: !!customerId, isBulk });

    if (isBulk) {
      const already = await markPaymentIntentProcessed(db, pi.id);
      if (!already) {
        console.log('[StripeWebhook] payment_intent.succeeded already processed', pi.id);
        return Response.json({ received: true });
      }
      const quantity = Math.max(1, parseInt(meta.quantity, 10) || 1);
      const interval = meta.interval === 'yearly' ? 'yearly' : 'monthly';
      const recurringPriceId = interval === 'yearly'
        ? (env.STRIPE_PRICE_YEARLY || env.STRIPE_PRICE_MONTHLY)
        : env.STRIPE_PRICE_MONTHLY;
      if (!recurringPriceId) {
        console.error('[StripeWebhook] payment_intent.succeeded: STRIPE_PRICE_MONTHLY/YEARLY not set');
      } else if (!customerId) {
        console.warn('[StripeWebhook] payment_intent.succeeded: bulk but no customer (pass email in checkout or ensure Stripe attached customer)');
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
          console.log('[StripeWebhook] payment_intent.succeeded: enqueued', quantity, 'license jobs for org', orgId);
        } catch (err) {
          console.error('[StripeWebhook] payment_intent.succeeded: enqueue failed', err);
          throw err;
        }
      }
      await savePaymentEvent(db, {
        eventType: 'payment_intent.succeeded',
        stripeEventId: eventId,
        organizationId: orgId,
        rawPayload: { paymentIntentId: pi.id, planType: 'bulk', quantity },
      });
    } else {
      console.log('[StripeWebhook] payment_intent.succeeded: skipped (not bulk or missing orgId)');
    }
      return Response.json({ received: true });
    }

    if (type === 'checkout.session.completed') {
      const session = event.data.object;
      const subId = session.subscription;
      const sessionMeta = session.metadata || {};
      let orgId = session.client_reference_id || sessionMeta.organizationId;
      let siteId = sessionMeta.siteId && String(sessionMeta.siteId).trim() ? String(sessionMeta.siteId).trim() : null;
      let siteNameMeta = sessionMeta.siteName && String(sessionMeta.siteName).trim() ? String(sessionMeta.siteName).trim() : null;
      let siteDomainMeta = sessionMeta.siteDomain && String(sessionMeta.siteDomain).trim() ? String(sessionMeta.siteDomain).trim() : null;
      let currentPeriodStart = null;
      let currentPeriodEnd = null;
      let interval = sessionMeta.interval || 'monthly';

      let planTypeMeta = sessionMeta.planType || 'single';
      let subMeta = {};

      // Metadata is on the Subscription, not Session — fetch subscription to get siteId/siteName/siteDomain
      if (subId && env.STRIPE_SECRET_KEY) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          const subData = await subRes.json();
          subMeta = subData.metadata || {};
          if (subMeta.planType) planTypeMeta = subMeta.planType;
          if (subMeta.interval) interval = subMeta.interval;
          if (subData.current_period_start) currentPeriodStart = toTimestamp(subData.current_period_start);
          if (subData.current_period_end) currentPeriodEnd = toTimestamp(subData.current_period_end);
          if (!orgId) orgId = subMeta.organizationId;
          if (!siteId && subMeta.siteId) siteId = String(subMeta.siteId).trim() || null;
          if (!siteNameMeta && subMeta.siteName) siteNameMeta = String(subMeta.siteName).trim() || null;
          if (!siteDomainMeta && subMeta.siteDomain) siteDomainMeta = String(subMeta.siteDomain).trim() || null;
          console.log('[StripeWebhook] checkout.session.completed: sub metadata', { planType: planTypeMeta, siteId, siteNameMeta, siteDomainMeta, orgId });
        } catch (e) {
          console.warn('[StripeWebhook] Could not fetch subscription', e.message);
        }
      }

      // Quantity plan: one subscription with quantity, N license keys, all renew together
      if (subId && orgId && planTypeMeta === 'quantity') {
        const qty = Math.max(10, Math.min(100, parseInt(String(sessionMeta.quantity || subMeta.quantity || '10'), 10) || 10));
        const licenseKeys = await generateLicenseKeys(qty, db);
        console.log('[StripeWebhook] checkout.session.completed: quantity plan', { qty, licenseKeysCount: licenseKeys.length });
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
            console.log('[StripeWebhook] checkout.session.completed: created site', siteId, name);
          } catch (e) {
            console.error('[StripeWebhook] Failed to create site from checkout metadata', e);
          }
        }

        await savePaymentEvent(db, {
          eventType: 'checkout.session.completed',
          stripeEventId: eventId,
          organizationId: orgId,
          rawPayload: { subscriptionId: subId, siteId },
        });

        const licenseKey = siteId ? await generateUniqueLicenseKey(db) : null;
        console.log('[StripeWebhook] checkout.session.completed: saving subscription', { siteId, licenseKey: licenseKey ? `${licenseKey.substring(0, 12)}...` : null });
        await saveSubscription(db, {
          organizationId: orgId,
          siteId: siteId || null,
          stripeSubscriptionId: subId,
          stripeCustomerId: session.customer,
          planType: 'single',
          interval,
          status: 'active',
          currentPeriodStart,
          currentPeriodEnd,
          licenseKey,
          amountCents: session.amount_total ?? null,
        });
      }
      return Response.json({ received: true });
    }

    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const existing = await getSubscriptionByStripeId(db, sub.id);
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
      const intervalFromSub = sub.items?.data?.[0]?.plan?.interval === 'year' ? 'yearly' : 'monthly';
      await saveSubscription(db, {
        id: existing?.id,
        organizationId: orgIdFinal,
        siteId: existing?.siteId ?? existing?.siteid ?? sub.metadata?.siteId ?? null,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: sub.customer,
        stripePriceId: sub.items?.data?.[0]?.price?.id,
        planType: existingPlanType,
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
      return Response.json({ received: true });
    }

    if (type === 'invoice.payment_failed') {
      const invoice = event.data.object;
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
      return Response.json({ received: true });
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error('[StripeWebhook]', type, err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
