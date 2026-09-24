// src/handlers/syncEvent.js
// Inbound sync endpoint: receives typed events from dashboard-server and
// (1) upserts them into CONSENT_WEBAPP D1, then
// (2) pushes the change back out to LEGACY_DB + KV via syncLegacy.
//
// POST /api/sync/event
// Authorization: Bearer <SYNC_SECRET>
// Body: { type, ...payload }
//
// Event types:
//   purchase           — new checkout completed in dashboard-server
//   subscription_update — subscription status/period changed
//   subscription_deleted — subscription permanently deleted/expired
//   license_activate   — license key activated on a site
//   license_transfer   — license key transferred to a new domain

import { ensureSchema } from '../services/db.js';
import { upsertLegacyEntry } from '../services/db.js';
import {
  syncPurchaseToLegacy,
  syncSubscriptionUpdateToLegacy,
  syncSubscriptionDeletedToLegacy,
  syncLicenseActivateToLegacy,
  syncLicenseTransferToLegacy,
} from '../services/syncLegacy.js';
import { getSubscriptionByStripeId, getSiteByDomain, saveSubscription } from '../services/db.js';

function normalizeDomain(raw) {
  return (raw || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
}

export async function handleSyncEvent(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  // Auth — shared secret set in both workers' env
  const syncSecret = env.SYNC_SECRET;
  const authHeader = request.headers.get('Authorization') || '';
  if (!syncSecret || authHeader !== `Bearer ${syncSecret}`) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, ...payload } = body;
  if (!type) {
    return Response.json({ success: false, error: 'Missing event type' }, { status: 400 });
  }

  await ensureSchema(db);

  try {
    switch (type) {
      case 'purchase':
        await handlePurchase(db, env, payload);
        break;
      case 'subscription_update':
        await handleSubscriptionUpdate(db, env, payload);
        break;
      case 'subscription_deleted':
        await handleSubscriptionDeleted(db, env, payload);
        break;
      case 'license_activate':
        await handleLicenseActivate(db, env, payload);
        break;
      case 'license_transfer':
        await handleLicenseTransfer(db, env, payload);
        break;
      default:
        return Response.json({ success: false, error: `Unknown event type: ${type}` }, { status: 400 });
    }
    return Response.json({ success: true, type });
  } catch (err) {
    console.error(`[syncEvent] Error handling "${type}":`, err?.message);
    return Response.json({ success: false, error: err?.message || 'Internal error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handlePurchase(db, env, payload) {
  const {
    email, domain, subscriptionId, customerId,
    status, platform, licenseKey, interval, cancelAtPeriodEnd = false,
  } = payload;

  // `status = 'active'` and `interval = 'monthly'` used to be default parameters here.
  // A payload that simply OMITTED the field therefore arrived as a paying, monthly
  // customer — and combined with `status || existing.status` in handleSubscriptionUpdate
  // below, a legacy row could only ever move TOWARDS active, never away. The measured
  // result: legacy subscriptions cancelled at ~5% against ~37% for everyone else. Those
  // cancellations happened; the sync could not express them.
  //
  // Defaulting is kept — this is a purchase event, so 'active' is the right reading of a
  // missing status — but it is now recorded so a sender that stopped sending the field
  // shows up in the logs instead of silently minting active subscriptions.
  if (!status || !interval) {
    console.warn('[syncEvent] purchase payload missing field(s); defaulting', {
      domain, subscriptionId,
      missingStatus: !status, missingInterval: !interval,
    });
  }
  const statusFinal = status || 'active';
  const intervalFinal = interval || 'monthly';

  // Upsert into CONSENT_WEBAPP via the migration helper (handles user/org/site/sub)
  await upsertLegacyEntry(db, {
    email: (email || '').toLowerCase(),
    domain: normalizeDomain(domain),
    subscriptionId,
    customerId,
    status: statusFinal,
    legacySource: platform || 'dashboard',
    interval: intervalFinal,
    cancelAtPeriodEnd: cancelAtPeriodEnd ? 1 : 0,
    licenseKey: licenseKey || null,
    active: true,
  }, new Date().toISOString());

  // Push to LEGACY_DB + KV (idempotent — other systems get a consistent view)
  await syncPurchaseToLegacy(env, { email, domain, subscriptionId, customerId, status: statusFinal, platform, licenseKey, interval: intervalFinal, cancelAtPeriodEnd });
}

async function handleSubscriptionUpdate(db, env, payload) {
  const {
    subscriptionId, customerId, email, domain,
    status, cancelAtPeriodEnd, platform, interval,
    currentPeriodStart, currentPeriodEnd,
  } = payload;

  // An absent status keeps whatever the row already had — which, because the row could
  // only ever have been set TO 'active', meant a legacy subscription had no way to be
  // demoted by this path at all. Kept (an update that omits the field should not invent a
  // state) but recorded, so a sender that stopped including it is visible rather than
  // silently freezing every legacy row as paying.
  if (!status) {
    console.warn('[syncEvent] subscription_update with no status — keeping existing', {
      subscriptionId, domain,
    });
  }

  // Update CONSENT_WEBAPP Subscription row
  const existing = await getSubscriptionByStripeId(db, subscriptionId);
  if (existing) {
    await saveSubscription(db, {
      id: existing.id,
      organizationId: existing.organizationId ?? existing.organizationid,
      siteId: existing.siteId ?? existing.siteid,
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId || existing.stripeCustomerId,
      planType: existing.planType ?? existing.plantype ?? 'single',
      interval: interval || existing.interval || 'monthly',
      status: status || existing.status,
      currentPeriodStart: currentPeriodStart || existing.currentPeriodStart,
      currentPeriodEnd: currentPeriodEnd || existing.currentPeriodEnd,
      cancelAtPeriodEnd: cancelAtPeriodEnd ? 1 : 0,
    });
  }

  // Tag the site as legacy if we have a domain
  const canonicalDomain = normalizeDomain(domain);
  if (canonicalDomain) {
    try {
      await db
        .prepare(`UPDATE Site SET isLegacy = 1, legacySource = COALESCE(legacySource, ?1), updatedAt = datetime('now') WHERE domain = ?2`)
        .bind(platform || 'dashboard', canonicalDomain)
        .run();
    } catch (_) {}
  }

  await syncSubscriptionUpdateToLegacy(env, { email, domain, subscriptionId, customerId, status, cancelAtPeriodEnd, platform, interval });
}

async function handleSubscriptionDeleted(db, env, payload) {
  const { subscriptionId, customerId, email, domain, platform } = payload;

  const existing = await getSubscriptionByStripeId(db, subscriptionId);
  if (existing) {
    await saveSubscription(db, {
      id: existing.id,
      organizationId: existing.organizationId ?? existing.organizationid,
      siteId: existing.siteId ?? existing.siteid,
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: customerId || existing.stripeCustomerId,
      planType: existing.planType ?? existing.plantype ?? 'single',
      interval: existing.interval || 'monthly',
      status: 'deleted',
      cancelAtPeriodEnd: 0,
    });
  }

  // Mark site inactive
  const canonicalDomain = normalizeDomain(domain);
  if (canonicalDomain) {
    try {
      await db
        .prepare(`UPDATE Site SET isLegacy = 1, legacySource = COALESCE(legacySource, ?1), updatedAt = datetime('now') WHERE domain = ?2`)
        .bind(platform || 'dashboard', canonicalDomain)
        .run();
    } catch (_) {}
  }

  await syncSubscriptionDeletedToLegacy(env, { email, domain, subscriptionId, customerId, platform });
}

async function handleLicenseActivate(db, env, payload) {
  const { email, licenseKey, domain, subscriptionId, customerId, platform } = payload;
  const canonicalDomain = normalizeDomain(domain);

  if (subscriptionId && canonicalDomain) {
    const existing = await getSubscriptionByStripeId(db, subscriptionId);
    if (existing) {
      // Link site to this subscription if not already linked
      const site = canonicalDomain ? await getSiteByDomain(db, canonicalDomain) : null;
      if (site && !existing.siteId) {
        await saveSubscription(db, {
          ...existing,
          stripeSubscriptionId: subscriptionId,
          siteId: site.id,
        });
      }
    }
  }

  // Tag site as legacy
  if (canonicalDomain) {
    try {
      await db
        .prepare(`UPDATE Site SET isLegacy = 1, legacySource = COALESCE(legacySource, ?1), updatedAt = datetime('now') WHERE domain = ?2`)
        .bind(platform || 'dashboard', canonicalDomain)
        .run();
    } catch (_) {}
  }

  await syncLicenseActivateToLegacy(env, { email, licenseKey, domain: canonicalDomain, subscriptionId, customerId, platform });
}

async function handleLicenseTransfer(db, env, payload) {
  const { email, licenseKey, oldDomain, newDomain, subscriptionId, customerId, platform } = payload;
  const newCanonical = normalizeDomain(newDomain);
  const oldCanonical = normalizeDomain(oldDomain);

  // Update site domain in CONSENT_WEBAPP if the old site exists
  if (oldCanonical && newCanonical) {
    try {
      await db
        .prepare(`UPDATE Site SET domain = ?1, isLegacy = 1, legacySource = COALESCE(legacySource, ?2), updatedAt = datetime('now') WHERE domain = ?3`)
        .bind(newCanonical, platform || 'dashboard', oldCanonical)
        .run();
    } catch (_) {}
  }

  await syncLicenseTransferToLegacy(env, { email, licenseKey, oldDomain: oldCanonical, newDomain: newCanonical, subscriptionId, customerId, platform });
}
