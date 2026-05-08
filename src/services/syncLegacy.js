// src/services/syncLegacy.js
// Outbound sync: pushes changes from CONSENT_WEBAPP → LEGACY_DB (consentbit-licenses) + KV stores.
// All functions are fire-safe: wrapped callers should use ctx.waitUntil() or plain await inside try/catch.
// LEGACY_DB schema reference: users, subscriptions, subscription_items, sites, licenses tables.

function normalizeDomain(raw) {
  return (raw || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Webflow site ID resolution via data-wf-site attribute
// ---------------------------------------------------------------------------

/**
 * Fetches the public HTML of a domain and extracts the Webflow site ID
 * from the `data-wf-site` attribute on the <html> element.
 * Returns null if the site is not a Webflow site or the fetch fails.
 */
async function resolveWfSiteId(domain) {
  if (!domain) return null;
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/data-wf-site="([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the public HTML of a domain and extracts the Framer site ID
 * from the data-fid attribute on the Framer events script tag.
 * Returns null if the site is not a Framer site or the fetch fails.
 */
async function resolveFramerSiteId(domain) {
  if (!domain) return null;
  const url = domain.startsWith('http') ? domain : `https://${domain}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<script[^>]*src="https:\/\/events\.framer\.com\/script\?v=2"[^>]*data-fid="([^"]+)"/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

function kvForPlatform(env, platform) {
  const p = (platform || '').toLowerCase();
  if (p === 'framer') return env.ACTIVE_SITES_CONSENTBIT_FRAMER || null;
  return env.ACTIVE_SITES_CONSENTBIT || null; // webflow + default
}

async function writeKvSiteEntry(env, platform, domain, data) {
  const kv = kvForPlatform(env, platform);
  if (!kv || !domain) return;
  // Try both key formats — entries may be stored with or without https:// prefix
  const keyWithProtocol = `https://${domain}`;
  const keyBare = domain;
  try {
    // Prefer bare key if it exists, fall back to protocol-prefixed
    let existing = null;
    let key = keyBare;
    const rawBare = await kv.get(keyBare);
    if (rawBare) {
      try { existing = JSON.parse(rawBare); } catch { existing = {}; }
      key = keyBare;
    } else {
      const rawProtocol = await kv.get(keyWithProtocol);
      if (rawProtocol) {
        try { existing = JSON.parse(rawProtocol); } catch { existing = {}; }
        key = keyWithProtocol;
      } else {
        existing = {};
        key = keyBare;
      }
    }
    await kv.put(key, JSON.stringify({ ...existing, ...data }));
  } catch (err) {
    console.warn(`[syncLegacy] KV write failed for domain="${domain}":`, err?.message);
  }
}

async function deleteKvSiteEntry(env, platform, domain) {
  const kv = kvForPlatform(env, platform);
  if (!kv || !domain) return;
  try {
    await kv.delete(`https://${domain}`);
  } catch (err) {
    console.warn(`[syncLegacy] KV delete failed for "${domain}":`, err?.message);
  }
}

// ---------------------------------------------------------------------------
// LEGACY_DB helpers — consentbit-licenses schema
// ---------------------------------------------------------------------------

async function ensureLegacyUser(legacyDb, email) {
  if (!legacyDb || !email) return;
  const now = nowUnix();
  await legacyDb
    .prepare(`INSERT OR IGNORE INTO users (email, created_at, updated_at) VALUES (?1, ?2, ?2)`)
    .bind(email, now)
    .run();
}

async function upsertLegacySubscription(legacyDb, { email, customerId, subscriptionId, status, cancelAtPeriodEnd, interval }) {
  if (!legacyDb || !subscriptionId) return;
  const now = nowUnix();
  await legacyDb
    .prepare(
      `INSERT INTO subscriptions (user_email, customer_id, subscription_id, status, cancel_at_period_end, billing_period, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(subscription_id) DO UPDATE SET
         status = excluded.status,
         cancel_at_period_end = excluded.cancel_at_period_end,
         billing_period = excluded.billing_period,
         updated_at = excluded.updated_at`
    )
    .bind(email || null, customerId || null, subscriptionId, status || 'active', cancelAtPeriodEnd ? 1 : 0, interval || 'monthly', now)
    .run();
}

async function upsertLegacySite(legacyDb, { customerId, subscriptionId, domain, status, platform }) {
  if (!legacyDb || !domain) return;
  const now = nowUnix();
  await legacyDb
    .prepare(
      `INSERT INTO sites (customer_id, subscription_id, site_domain, status, platform, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(subscription_id) DO UPDATE SET
         site_domain = excluded.site_domain,
         status = excluded.status,
         platform = excluded.platform,
         updated_at = excluded.updated_at`
    )
    .bind(customerId || null, subscriptionId || null, domain, status || 'active', platform || 'pending', now)
    .run();
}

async function upsertLegacyLicense(legacyDb, { licenseKey, customerId, subscriptionId, domain, usedDomain, platform, status }) {
  if (!legacyDb || !licenseKey) return;
  const now = nowUnix();
  await legacyDb
    .prepare(
      `INSERT INTO licenses (license_key, customer_id, subscription_id, site_domain, used_site_domain, platform, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(license_key) DO UPDATE SET
         site_domain = COALESCE(excluded.site_domain, site_domain),
         used_site_domain = COALESCE(excluded.used_site_domain, used_site_domain),
         platform = excluded.platform,
         status = excluded.status,
         updated_at = excluded.updated_at`
    )
    .bind(licenseKey, customerId || null, subscriptionId || null, domain || null, usedDomain || null, platform || 'pending', status || 'active', now)
    .run();
}

// ---------------------------------------------------------------------------
// Public sync functions
// ---------------------------------------------------------------------------

/**
 * Sync a new purchase/site creation into LEGACY_DB + KV.
 * Called after checkout.session.completed or site creation in webapp.
 */
export async function syncPurchaseToLegacy(env, {
  email, domain, subscriptionId, customerId,
  status = 'active', platform, licenseKey, interval = 'monthly', cancelAtPeriodEnd = 0,
} = {}) {
  const legacyDb = env.LEGACY_DB || null;
  const canonicalDomain = normalizeDomain(domain);

  // Resolve platform-specific site ID from the site's public HTML
  const isFramer = (platform || '').toLowerCase() === 'framer';
  const [wfSiteId, framerSiteId] = await Promise.all([
    isFramer ? null : resolveWfSiteId(canonicalDomain).catch(() => null),
    isFramer ? resolveFramerSiteId(canonicalDomain).catch(() => null) : null,
  ]);
  await Promise.allSettled([
    // LEGACY_DB
    (async () => {
      if (!legacyDb) return;
      await ensureLegacyUser(legacyDb, email);
      await upsertLegacySubscription(legacyDb, { email, customerId, subscriptionId, status, cancelAtPeriodEnd, interval });
      await upsertLegacySite(legacyDb, { customerId, subscriptionId, domain: canonicalDomain, status, platform });
      if (licenseKey) {
        await upsertLegacyLicense(legacyDb, { licenseKey, customerId, subscriptionId, domain: canonicalDomain, platform, status: 'active' });
      }
    })(),
    // KV — include platform site ID if resolved
    writeKvSiteEntry(env, platform, canonicalDomain, {
      email,
      subscriptionId,
      customerId,
      status: 'complete',
      active: true,
      lastUpdated: new Date().toISOString(),
      cancelAtPeriodEnd: cancelAtPeriodEnd ? true : false,
      ...(wfSiteId ? { wfSiteId } : {}),
      ...(framerSiteId ? { framerSiteId } : {}),
    }),
  ]);
}

/**
 * Sync a subscription update (status change, cancellation flag) into LEGACY_DB + KV.
 */
export async function syncSubscriptionUpdateToLegacy(env, {
  email, domain, subscriptionId, customerId,
  status, cancelAtPeriodEnd, platform, interval,
} = {}) {
  const legacyDb = env.LEGACY_DB || null;
  const canonicalDomain = normalizeDomain(domain);

  await Promise.allSettled([
    (async () => {
      if (!legacyDb) return;
      await upsertLegacySubscription(legacyDb, { email, customerId, subscriptionId, status, cancelAtPeriodEnd, interval });
      if (canonicalDomain) {
        await upsertLegacySite(legacyDb, { customerId, subscriptionId, domain: canonicalDomain, status, platform });
      }
    })(),
    (async () => {
      if (!canonicalDomain) return;
      const active = status !== 'deleted' && status !== 'expired' && status !== 'canceled';
      await writeKvSiteEntry(env, platform, canonicalDomain, {
        email,
        subscriptionId,
        customerId,
        status: active ? 'complete' : status,
        active,
        cancelAtPeriodEnd: cancelAtPeriodEnd ? true : false,
        lastUpdated: new Date().toISOString(),
      });
    })(),
  ]);
}

/**
 * Sync subscription deletion/expiry into LEGACY_DB + KV.
 */
export async function syncSubscriptionDeletedToLegacy(env, {
  email, domain, subscriptionId, customerId, platform,
} = {}) {
  const legacyDb = env.LEGACY_DB || null;
  const canonicalDomain = normalizeDomain(domain);

  await Promise.allSettled([
    (async () => {
      if (!legacyDb) return;
      await upsertLegacySubscription(legacyDb, { email, customerId, subscriptionId, status: 'deleted', cancelAtPeriodEnd: 0, interval: 'monthly' });
      if (canonicalDomain) {
        await upsertLegacySite(legacyDb, { customerId, subscriptionId, domain: canonicalDomain, status: 'expired', platform });
      }
      // Mark all licenses inactive
      if (subscriptionId) {
        const now = nowUnix();
        await legacyDb
          .prepare(`UPDATE licenses SET status = 'inactive', updated_at = ?1 WHERE subscription_id = ?2`)
          .bind(now, subscriptionId)
          .run();
      }
    })(),
    (async () => {
      if (!canonicalDomain) return;
      await writeKvSiteEntry(env, platform, canonicalDomain, {
        email,
        subscriptionId,
        customerId,
        status: 'expired',
        active: false,
        lastUpdated: new Date().toISOString(),
      });
    })(),
  ]);
}

/**
 * Sync a license activation into LEGACY_DB + KV.
 */
export async function syncLicenseActivateToLegacy(env, {
  email, licenseKey, domain, subscriptionId, customerId, platform,
} = {}) {
  const legacyDb = env.LEGACY_DB || null;
  const canonicalDomain = normalizeDomain(domain);

  await Promise.allSettled([
    (async () => {
      if (!legacyDb || !licenseKey) return;
      await upsertLegacyLicense(legacyDb, {
        licenseKey, customerId, subscriptionId,
        domain: canonicalDomain, usedDomain: canonicalDomain,
        platform, status: 'active',
      });
      await upsertLegacySite(legacyDb, { customerId, subscriptionId, domain: canonicalDomain, status: 'active', platform });
    })(),
    writeKvSiteEntry(env, platform, canonicalDomain, {
      email,
      subscriptionId,
      customerId,
      status: 'complete',
      active: true,
      lastUpdated: new Date().toISOString(),
    }),
  ]);
}

/**
 * Sync a license transfer into LEGACY_DB + KV.
 * Removes old domain KV entry, writes new one.
 */
export async function syncLicenseTransferToLegacy(env, {
  email, licenseKey, oldDomain, newDomain, subscriptionId, customerId, platform,
} = {}) {
  const legacyDb = env.LEGACY_DB || null;
  const oldCanonical = normalizeDomain(oldDomain);
  const newCanonical = normalizeDomain(newDomain);

  await Promise.allSettled([
    (async () => {
      if (!legacyDb || !licenseKey) return;
      await upsertLegacyLicense(legacyDb, {
        licenseKey, customerId, subscriptionId,
        domain: newCanonical, usedDomain: newCanonical,
        platform, status: 'active',
      });
      // Update sites table: mark old inactive, upsert new
      if (oldCanonical) {
        const now = nowUnix();
        await legacyDb
          .prepare(`UPDATE sites SET status = 'inactive', updated_at = ?1 WHERE subscription_id = ?2 AND site_domain = ?3`)
          .bind(now, subscriptionId, oldCanonical)
          .run();
      }
      await upsertLegacySite(legacyDb, { customerId, subscriptionId, domain: newCanonical, status: 'active', platform });
    })(),
    // Remove old KV entry, write new one
    deleteKvSiteEntry(env, platform, oldCanonical),
    writeKvSiteEntry(env, platform, newCanonical, {
      email,
      subscriptionId,
      customerId,
      status: 'complete',
      active: true,
      lastUpdated: new Date().toISOString(),
    }),
  ]);
}
