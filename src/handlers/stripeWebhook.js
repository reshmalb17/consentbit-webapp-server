// POST /api/webhooks/stripe - raw body required for signature verification
//
// Subscribe to: checkout.session.completed, payment_intent.succeeded, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed
//
//   payment_intent.succeeded  - bulk one-time payment: create license keys, add to queue (cron creates 4 subscriptions at a time)
//   checkout.session.completed - single: save subscription from session (per-site license); bulk: audit only (licenses enqueued from payment_intent.succeeded)
//   customer.subscription.updated / .deleted / invoice.payment_failed - sync Subscription table

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
} from '../services/db.js';
import { sendWelcomeEmail, sendPaidPlanEmail, sendPaymentFailureEmail } from '../services/email.js';
import {
  syncPurchaseToLegacy,
  syncSubscriptionUpdateToLegacy,
  syncSubscriptionDeletedToLegacy,
} from '../services/syncLegacy.js';

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

      // Metadata is on the Subscription, not Session — fetch subscription to get siteId/siteName/siteDomain
      if (subId && env.STRIPE_SECRET_KEY) {
        try {
          const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          const subData = await subRes.json();
          subMeta = subData.metadata || {};
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

          sendPaidPlanEmail(env, ctx, {
            to:       emailTo,
            name:     customerName,
            domain:   siteDomainMeta || '',
            planName,
            invoice:  invoiceData,
          });
        }

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

    if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      let existing = await getSubscriptionByStripeId(db, sub.id);

      // Fallback: migrated legacy users have stripeSubscriptionId = null in D1 so the lookup
      // above returns nothing. Try matching by stripeCustomerId instead so their D1 row gets
      // updated when Stripe fires cancellation / update webhooks.
      if (!existing && sub.customer) {
        existing = await db.prepare(
          `SELECT * FROM Subscription WHERE stripeCustomerId = ?1 ORDER BY updatedAt DESC LIMIT 1`
        ).bind(sub.customer).first() ?? null;

        // Stamp the real stripeSubscriptionId onto the row so future webhooks hit the fast path
        if (existing && sub.id) {
          db.prepare(
            `UPDATE Subscription SET stripeSubscriptionId = ?1, updatedAt = ?2 WHERE id = ?3`
          ).bind(sub.id, new Date().toISOString(), existing.id).run().catch(() => {});
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

      // Send payment failure reminder email based on attempt count
      const orgId = existing?.organizationId ?? existing?.organizationid;
      if (orgId) {
        try {
          const userRow = await db.prepare(
            'SELECT u.email, u.name FROM User u JOIN OrganizationMember om ON om.userId = u.id WHERE om.organizationId = ?1 LIMIT 1'
          ).bind(orgId).first();
          if (userRow?.email) {
            const attempt = invoice.attempt_count || 1;
            const reminderNumber = attempt >= 3 ? 3 : attempt;
            const billingUrl = (env.WEBAPP_PUBLIC_URL || 'https://app.consentbit.com').replace(/\/$/, '') + '/billing';
            sendPaymentFailureEmail(env, ctx, {
              to: userRow.email,
              name: userRow.name || '',
              updatePaymentUrl: billingUrl,
              reminderNumber,
            });
          }
        } catch (e) {
          console.warn('[StripeWebhook] payment failure email lookup failed:', e?.message);
        }
      }

      return Response.json({ received: true });
    }

    return Response.json({ received: true });
  } catch (err) {
    console.error('[StripeWebhook]', type, err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
