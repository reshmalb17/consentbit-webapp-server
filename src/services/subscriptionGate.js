// src/services/subscriptionGate.js
//
// Single source of truth for "may this site's consent-log data be handed back?"
//
// Consent logs / CSV / PDF exports are a PAID deliverable. A site whose subscription
// is missing, cancelled, deleted, unpaid or past due must NOT receive them — the
// dashboard shows the upgrade prompt instead of the report.
//
// A CANCELLING subscription still gets its reports: `cancelAtPeriodEnd` means the
// customer has paid through the end of the period and has not lost access yet. Only
// a subscription that has actually ended (status `canceled`/`deleted`) is cut off.
//
// This is still stricter than the banner-serving grace period in
// getSubscriptionsBySiteIds(): there, an already-`canceled` subscription keeps
// serving the banner until currentPeriodEnd so live sites don't break. Reporting
// stops as soon as the status leaves active/trialing.
//
// Resolution order mirrors handlers/paymentSubscription.js so the gate and the
// app's own "isSubscribed" answer never disagree:
//   1. Subscription row bound to the site (active/trialing only).
//   2. Fallback: the organization's subscription.
//   3. Legacy cross-check against ACTIVE_SITES_CONSENTBIT (Webflow/Framer users who
//      predate the D1 Subscription table). `active:true` grants, `active:false` revokes.

import { getSubscriptionBySiteId, getSubscriptionByOrganization } from './db.js';

const TAG = '[consent-gate]';

/** The only subscription statuses that may read consent-log data. */
export const ENTITLED_STATUSES = new Set(['active', 'trialing']);

export function isEntitledStatus(status) {
  return ENTITLED_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

/** Site row by internal Site.id OR platformSiteId — legacy handlers pass either form. */
async function resolveSiteRow(db, siteId) {
  return db
    .prepare(
      `SELECT id, organizationId, domain, platformSiteId FROM Site
       WHERE id = ?1 OR platformSiteId = ?1 LIMIT 1`,
    )
    .bind(String(siteId))
    .first()
    .catch((e) => {
      console.warn(`${TAG} site lookup failed`, e?.message);
      return null;
    });
}

/**
 * Legacy ACTIVE_SITES_CONSENTBIT lookup, keyed by every domain we know for the site.
 * Returns true (explicitly active), false (explicitly inactive), or null (no entry).
 */
async function legacyKvActive(env, site) {
  const kv = env.ACTIVE_SITES_CONSENTBIT;
  if (!kv) return null;

  const domains = [];
  const platformSiteId = site.platformSiteId ?? site.platformsiteid ?? null;
  if (platformSiteId && env.WEBFLOW_AUTHENTICATION) {
    try {
      const raw = await env.WEBFLOW_AUTHENTICATION.get(platformSiteId);
      if (raw) {
        const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
        for (const d of [entry.customDomain, entry.stagingUrl, entry.domain]) if (d) domains.push(d);
        if (Array.isArray(entry.domains)) {
          for (const d of entry.domains) if (d?.url) domains.push(d.url);
        }
      }
    } catch (e) {
      console.warn(`${TAG} WEBFLOW_AUTHENTICATION read failed`, e?.message);
    }
  }
  if (site.domain) domains.push(site.domain);
  if (domains.length === 0) return null;

  const tried = new Set();
  let sawInactive = false;
  for (const raw of domains) {
    const clean = String(raw).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (!clean) continue;
    for (const key of [clean, `https://${clean}`, `www.${clean}`, `https://www.${clean}`]) {
      if (tried.has(key)) continue;
      tried.add(key);
      let entry = null;
      try {
        entry = await kv.get(key, { type: 'json' });
      } catch { /* keep scanning */ }
      if (!entry) continue;
      // cancelAtPeriodEnd is NOT a denial — the period is still paid for.
      if (entry.active === true) return true;
      if (entry.active === false) sawInactive = true;
    }
  }
  return sawInactive ? false : null;
}

/**
 * Resolve whether `siteId` (internal Site.id or platformSiteId) may receive consent
 * reports. Returns { entitled, status, siteRowId, reason }.
 */
export async function getConsentReportEntitlement(env, siteId) {
  const db = env.CONSENT_WEBAPP;
  if (!db || !siteId) return { entitled: false, status: 'none', siteRowId: null, reason: 'NO_SITE_ID' };

  const site = await resolveSiteRow(db, siteId);
  if (!site) return { entitled: false, status: 'none', siteRowId: null, reason: 'SITE_NOT_FOUND' };

  // 1. Site-bound subscription — getSubscriptionBySiteId already filters to active/trialing.
  let sub = await getSubscriptionBySiteId(db, site.id).catch(() => null);
  // 2. Organization fallback — may return a stale/canceled row, so the status is checked below.
  if (!sub) {
    const orgId = site.organizationId ?? site.organizationid ?? null;
    if (orgId) sub = await getSubscriptionByOrganization(db, orgId).catch(() => null);
  }

  // A subscription set to cancel at period end is still active/trialing until it
  // actually ends, so cancelAtPeriodEnd is deliberately NOT consulted here.
  const status = String(sub?.status ?? '').trim().toLowerCase() || 'none';
  let entitled = isEntitledStatus(status);
  let reason = entitled
    ? 'D1_ACTIVE'
    : status === 'none'
      ? 'NO_SUBSCRIPTION'
      : `STATUS_${status.toUpperCase()}`;

  // 3. Legacy KV cross-check (same precedence as handlers/paymentSubscription.js).
  // KV may only GRANT when D1 had nothing to say — a D1 row that is already cancelled
  // is authoritative and must not be overridden by a stale KV record.
  const kvActive = await legacyKvActive(env, site);
  if (!entitled && kvActive === true && status !== 'canceled') {
    entitled = true;
    reason = 'LEGACY_KV_ACTIVE';
  } else if (entitled && kvActive === false) {
    entitled = false;
    reason = 'LEGACY_KV_INACTIVE';
  }

  return { entitled, status, siteRowId: site.id, reason };
}

/**
 * Router/handler gate. Returns { ok: true } or { ok: false, status, code, error }.
 * 403 (not 401) — the caller is authenticated, they just aren't entitled.
 */
export async function requireActiveSubscriptionForConsentReport(env, siteId) {
  const result = await getConsentReportEntitlement(env, siteId);
  if (result.entitled) return { ok: true };
  console.log(`${TAG} denied — siteId=${siteId} status=${result.status} reason=${result.reason}`);
  return {
    ok: false,
    status: 403,
    code: 'SUBSCRIPTION_INACTIVE',
    subscriptionStatus: result.status,
    error: 'Consent log reports require an active subscription. Reactivate your plan to view or export consent records.',
  };
}
