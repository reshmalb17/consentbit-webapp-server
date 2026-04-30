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
  savePaymentEvent,
  enqueueBulkLicenseJobs,
  markPaymentIntentProcessed,
  generateUniqueLicenseKey,
  generateLicenseKeys,
  createSite,
  inferTierPlanIdFromStripePriceId,
  markTrialUsed,
} from '../services/db.js';
import { sendPaidPlanEmail } from '../services/email.js';
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
  console.log(`[injectWebflowScript] START wfSiteId=${wfSiteId}`);
  console.log(`[injectWebflowScript] scriptSrc="${scriptSrc}"`);
  console.log(`[injectWebflowScript] accessToken present=${!!accessToken} length=${accessToken?.length}`);

  // Step 1: register the script (idempotent)
  const registerBody = {
    sourceCode: `(function(){var s=document.createElement('script');s.src=${JSON.stringify(scriptSrc)};s.async=true;s.setAttribute('data-display-name','ConsentBitScript2025');(document.head||document.getElementsByTagName('head')[0]).appendChild(s);})();`,
    version: '1.0.2',
    displayName: 'ConsentBitScript2025',
    location: 'header',
    canCopy: false,
  };
  console.log(`[injectWebflowScript] POST registered_scripts/inline body=`, JSON.stringify(registerBody));

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
  console.log(`[injectWebflowScript] register response status=${registerRes.status} body=${JSON.stringify(registerData)}`);

  if (registerRes.status === 401 || registerRes.status === 403) {
    console.warn(`[injectWebflowScript] auth error ${registerRes.status} — accessToken may be expired or missing custom_code:write scope`);
    return false;
  }

  let scriptId = registerData.id || registerData.scriptId;

  // Script already registered — derive the id from displayName (Webflow lowercases it)
  if (!scriptId && registerData.code === 'duplicate_registered_script') {
    scriptId = registerBody.displayName.toLowerCase().replace(/\s+/g, '');
    console.log(`[injectWebflowScript] duplicate script — reusing existing scriptId="${scriptId}"`);
  }

  if (!scriptId) {
    console.warn(`[injectWebflowScript] no scriptId in register response — full response: ${JSON.stringify(registerData)}`);
    return false;
  }
  console.log(`[injectWebflowScript] scriptId="${scriptId}" — applying to site header...`);

  // Step 2: fetch existing applied scripts, remove old ConsentBit ones, add new
  console.log(`[injectWebflowScript] fetching existing custom_code scripts...`);
  let existingScripts = [];
  try {
    const listRes = await fetch(`https://api.webflow.com/v2/sites/${wfSiteId}/custom_code`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'accept-version': '1.0.0' },
    });
    const listData = await listRes.json();
    console.log(`[injectWebflowScript] existing custom_code status=${listRes.status} body=${JSON.stringify(listData)}`);
    existingScripts = listData.scripts || [];
  } catch (e) {
    console.warn(`[injectWebflowScript] could not fetch existing scripts: ${e.message}`);
  }

  // Remove old ConsentBit scripts (ConsentBitBanner* from cb-server, consentbitscript2025 from previous runs)
  const filtered = existingScripts.filter(s => {
    const id = (s.id || '').toLowerCase();
    return !id.startsWith('consentbitbanner') && id !== 'consentbitscript2025';
  });
  console.log(`[injectWebflowScript] existing=${existingScripts.length} after removing old ConsentBit=${filtered.length}`);

  const applyBody = { scripts: [...filtered, { id: scriptId, location: 'header', version: registerBody.version }] };
  console.log(`[injectWebflowScript] PUT /custom_code body=`, JSON.stringify(applyBody));

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
  console.log(`[injectWebflowScript] apply response status=${applyRes.status} body=${JSON.stringify(applyData)}`);

  if (!applyRes.ok) {
    console.warn(`[injectWebflowScript] apply failed status=${applyRes.status}: ${applyData.msg || applyData.error || JSON.stringify(applyData)}`);
    return false;
  }

  console.log(`[injectWebflowScript] script applied — publishing site...`);

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
  const publishData = await publishRes.json();
  console.log(`[injectWebflowScript] publish response status=${publishRes.status} body=${JSON.stringify(publishData)}`);

  if (!publishRes.ok) {
    console.warn(`[injectWebflowScript] publish failed: ${publishData.msg || publishData.message || JSON.stringify(publishData)}`);
  } else {
    console.log(`[injectWebflowScript] site published successfully`);
  }

  console.log(`[injectWebflowScript] SUCCESS — script applied to wfSiteId=${wfSiteId}`);
  return true;
}

async function handleLegacyWebflowUpgrade(env, db, siteId, newSubId, resolvedPlanId) {
  console.log(`[legacyUpgrade] starting — siteId=${siteId} newSubId=${newSubId} plan=${resolvedPlanId}`);

  const siteRow = await db.prepare(
    'SELECT domain, platform, isLegacy, platformSiteId, cdnScriptId FROM Site WHERE id = ?1'
  ).bind(siteId).first();

  if (!siteRow) { console.warn(`[legacyUpgrade] no Site row found for siteId=${siteId}`); return; }
  if (!siteRow.isLegacy) { console.log(`[legacyUpgrade] site is not legacy — skipping`); return; }
  if (!['webflow', 'framer'].includes(siteRow.platform)) { console.log(`[legacyUpgrade] platform="${siteRow.platform}" not webflow/framer — skipping`); return; }

  const domain = siteRow.domain;
  const wfSiteId = siteRow.platformSiteId;
  const cdnScriptId = siteRow.cdnScriptId;
  const isFramer = siteRow.platform === 'framer';
  const kv = isFramer ? env.ACTIVE_SITES_CONSENTBIT_FRAMER : env.ACTIVE_SITES_CONSENTBIT;

  console.log(`[legacyUpgrade] domain="${domain}" platform="${siteRow.platform}" wfSiteId="${wfSiteId}" cdnScriptId="${cdnScriptId}"`);

  // 1. Update plan in KV
  if (kv && domain) {
    const existing = await kv.get(domain, { type: 'json' });
    if (existing) {
      await kv.put(domain, JSON.stringify({ ...existing, plan: resolvedPlanId }));
      console.log(`[legacyUpgrade] KV plan updated to "${resolvedPlanId}" for domain="${domain}"`);

      // Cancel old legacy Stripe subscription
      const oldLegacySubId = existing.subscriptionId;
      if (oldLegacySubId && oldLegacySubId !== newSubId && env.STRIPE_SECRET_KEY) {
        console.log(`[legacyUpgrade] cancelling old legacy sub ${oldLegacySubId}...`);
        try {
          const cancelRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(oldLegacySubId)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
          });
          const cancelData = await cancelRes.json();
          if (cancelData.error) {
            if (cancelData.error.code === 'resource_missing') {
              console.log(`[legacyUpgrade] old legacy sub ${oldLegacySubId} already cancelled — skipping`);
            } else {
              console.warn(`[legacyUpgrade] cancel old sub failed: ${cancelData.error.message}`);
            }
          } else {
            console.log(`[legacyUpgrade] old legacy sub ${oldLegacySubId} cancelled`);
          }
        } catch (e) {
          console.warn('[legacyUpgrade] exception cancelling old legacy sub', e.message);
        }
      } else if (oldLegacySubId === newSubId) {
        console.log(`[legacyUpgrade] old sub same as new sub — skip cancel`);
      } else {
        console.log(`[legacyUpgrade] no old legacy sub to cancel`);
      }
    } else {
      console.warn(`[legacyUpgrade] no KV entry found for domain="${domain}" — plan not updated in KV`);
    }
  } else {
    console.warn(`[legacyUpgrade] KV or domain missing — skipping KV plan update`);
  }

  // 2. Write cdnScriptId, siteId, plan to WEBFLOW_AUTHENTICATION KV (keyed by platformSiteId)
  if (!isFramer && wfSiteId && env.WEBFLOW_AUTHENTICATION) {
    try {
      const raw = await env.WEBFLOW_AUTHENTICATION.get(wfSiteId);
      const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      await env.WEBFLOW_AUTHENTICATION.put(wfSiteId, JSON.stringify({
        ...existing,
        cdnScriptId,
        webappSiteId: siteId,
        plan: resolvedPlanId,
      }));
      console.log(`[legacyUpgrade] WEBFLOW_AUTHENTICATION updated — cdnScriptId=${cdnScriptId} siteId=${siteId} plan=${resolvedPlanId}`);
    } catch (e) {
      console.warn('[legacyUpgrade] WEBFLOW_AUTHENTICATION update failed', e.message);
    }
  }

  // 3. Inject CDN script into Webflow site via Webflow API (Webflow only, not Framer)
  if (isFramer) {
    console.log(`[legacyUpgrade] Framer site — skipping Webflow script inject`);
    return;
  }
  if (!wfSiteId) { console.warn(`[legacyUpgrade] no platformSiteId on Site — cannot inject script`); return; }
  if (!cdnScriptId) { console.warn(`[legacyUpgrade] no cdnScriptId on Site — cannot inject script`); return; }
  if (!env.WEBFLOW_AUTHENTICATION) { console.warn(`[legacyUpgrade] WEBFLOW_AUTHENTICATION KV not bound`); return; }

  console.log(`[legacyUpgrade] looking up accessToken in WEBFLOW_AUTHENTICATION for wfSiteId=${wfSiteId}...`);
  try {
    const raw = await env.WEBFLOW_AUTHENTICATION.get(wfSiteId);
    if (!raw) { console.warn(`[legacyUpgrade] no WEBFLOW_AUTHENTICATION entry for wfSiteId=${wfSiteId}`); return; }
    const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const accessToken = wfData.accessToken;
    if (!accessToken) { console.warn('[legacyUpgrade] accessToken missing in WEBFLOW_AUTHENTICATION entry'); return; }
    console.log(`[legacyUpgrade] accessToken found — injecting script...`);

    const cdnBase = env.CDN_BASE_URL || 'https://consent-webapp-manager.web-8fb.workers.dev';
    const scriptSrc = `${cdnBase}/consentbit/${cdnScriptId}/script.js`;

    const ok = await injectWebflowScript(accessToken, wfSiteId, scriptSrc);
    console.log(`[legacyUpgrade] script inject ${ok ? 'SUCCESS' : 'FAILED'} for wfSiteId=${wfSiteId}`);
  } catch (e) {
    console.warn('[legacyUpgrade] exception during Webflow script inject', e.message);
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
      // Idempotency check — Stripe retries webhooks, skip if already processed
      const alreadyProcessed = await db.prepare(
        `SELECT id FROM PaymentEvent WHERE stripeEventId = ?1 LIMIT 1`
      ).bind(eventId).first();
      if (alreadyProcessed) {
        console.log(`[StripeWebhook] checkout.session.completed: already processed eventId=${eventId}, skipping`);
        return Response.json({ received: true });
      }

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
          stripePriceFromSub = subData.items?.data?.[0]?.price?.id || null;
          if (!subMeta.planId && stripePriceFromSub) {
            const inferred = inferTierPlanIdFromStripePriceId(env, stripePriceFromSub);
            if (inferred) subMeta = { ...subMeta, planId: inferred };
          }
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
        let resolvedPlanId = subMeta.planId || null;
        if (!resolvedPlanId && stripePriceFromSub) {
          resolvedPlanId = inferTierPlanIdFromStripePriceId(env, stripePriceFromSub);
        }
        console.log('[StripeWebhook] checkout.session.completed: saving subscription', {
          siteId,
          planId: resolvedPlanId,
          licenseKey: licenseKey ? `${licenseKey.substring(0, 12)}...` : null,
        });
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

        // Mark trial as used on the site so it can never be granted again
        if (subscriptionStatus === 'trialing' && siteId) {
          try { await markTrialUsed(db, siteId); } catch (e) {
            console.warn('[StripeWebhook] markTrialUsed failed', e.message);
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
            if (cancelData.error) {
              console.warn('[StripeWebhook] checkout.session.completed: failed to cancel old subscription', oldStripeSubscriptionId, cancelData.error.message);
            } else {
              console.log('[StripeWebhook] checkout.session.completed: cancelled old subscription', oldStripeSubscriptionId);
            }
          } catch (e) {
            console.warn('[StripeWebhook] checkout.session.completed: error cancelling old subscription', e.message);
          }
        }

        // Send paid-plan confirmation email in the background
        const customerEmail = session.customer_email || session.customer_details?.email;
        const customerName  = session.customer_details?.name || '';
        const planName      = resolvedPlanId || subMeta.planId || 'Basic';
        if (customerEmail) {
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
              console.warn('[StripeWebhook] Could not fetch invoice for email', e.message);
            }
          }
          sendPaidPlanEmail(env, ctx, {
            to:       customerEmail,
            name:     customerName,
            domain:   siteDomainMeta || '',
            planName,
            invoice:  invoiceData,
          });
        }

        // Legacy Webflow upgrade: if site is isLegacy=1 + platform=webflow/framer,
        // sync plan to KV and inject CDN script into Webflow site via Webflow API
        if (siteId && resolvedPlanId && ['essential', 'growth'].includes(resolvedPlanId)) {
          ctx.waitUntil(handleLegacyWebflowUpgrade(env, db, siteId, subId, resolvedPlanId).catch(
            (e) => console.warn('[StripeWebhook] legacy upgrade failed', e.message)
          ));
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
          }).catch((e) => console.warn('[StripeWebhook] syncPurchaseToLegacy failed:', e?.message))
        );
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
