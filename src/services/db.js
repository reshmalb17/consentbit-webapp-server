// src/services/db.js

// --- Schema ---

export async function ensureSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Site (
      id TEXT PRIMARY KEY,
      organizationId TEXT,
      name TEXT NOT NULL,
      domain TEXT UNIQUE NOT NULL,
      cdnScriptId TEXT UNIQUE NOT NULL,
      apiKey TEXT UNIQUE NOT NULL,
      banner_type TEXT DEFAULT 'gdpr',
      region_mode TEXT DEFAULT 'gdpr',
      ga_measurement_id TEXT,
      verified INTEGER DEFAULT 0,
      verified_at DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Add verified columns if they don't exist (for existing tables)
  try {
    await db.prepare(`
      ALTER TABLE Site ADD COLUMN verified INTEGER DEFAULT 0
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  
  try {
    await db.prepare(`
      ALTER TABLE Site ADD COLUMN verified_at DATETIME
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }

  // Create Script table if it doesn't exist
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Script (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      scriptUrl TEXT NOT NULL,
      scriptType TEXT,
      category TEXT NOT NULL,
      provider TEXT,
      description TEXT,
      detected INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
    )
  `).run();

  // Create unique index on siteId + scriptUrl for conflict resolution
  try {
    await db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_script_site_url ON Script(siteId, scriptUrl)
    `).run();
  } catch (e) {
    // Index might already exist, ignore
  }

  // Create ScanHistory table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ScanHistory (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      scanUrl TEXT,
      scriptsFound INTEGER DEFAULT 0,
      cookiesFound INTEGER DEFAULT 0,
      scanDuration INTEGER,
      scanStatus TEXT DEFAULT 'completed',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
    )
  `).run();

  // Create ScheduledScan table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ScheduledScan (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      scheduledAt DATETIME NOT NULL,
      frequency TEXT DEFAULT 'once',
      isActive INTEGER DEFAULT 1,
      lastRunAt DATETIME,
      nextRunAt DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
    )
  `).run();

  // Create Cookie table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Cookie (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      scanHistoryId TEXT,
      name TEXT NOT NULL,
      domain TEXT,
      path TEXT,
      category TEXT NOT NULL,
      provider TEXT,
      description TEXT,
      expires TEXT,
      httpOnly INTEGER DEFAULT 0,
      secure INTEGER DEFAULT 0,
      sameSite TEXT,
      firstSeenAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      lastSeenAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE,
      FOREIGN KEY (scanHistoryId) REFERENCES ScanHistory(id) ON DELETE SET NULL
    )
  `).run();

  // Create unique index on siteId + cookie name for conflict resolution
  try {
    await db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cookie_site_name ON Cookie(siteId, name, domain)
    `).run();
  } catch (e) {
    // Index might already exist, ignore
  }

  // Create BannerCustomization table
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS BannerCustomization (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL UNIQUE,
      position TEXT DEFAULT 'bottom-left',
      backgroundColor TEXT DEFAULT '#ffffff',
      textColor TEXT DEFAULT '#334155',
      headingColor TEXT DEFAULT '#0f172a',
      acceptButtonBg TEXT DEFAULT '#0284c7',
      acceptButtonText TEXT DEFAULT '#ffffff',
      rejectButtonBg TEXT DEFAULT '#ffffff',
      rejectButtonText TEXT DEFAULT '#334155',
      customiseButtonBg TEXT DEFAULT '#ffffff',
      customiseButtonText TEXT DEFAULT '#334155',
      saveButtonBg TEXT DEFAULT '#ffffff',
      saveButtonText TEXT DEFAULT '#334155',
      backButtonBg TEXT DEFAULT '#ffffff',
      backButtonText TEXT DEFAULT '#334155',
      doNotSellButtonBg TEXT DEFAULT '#ffffff',
      doNotSellButtonText TEXT DEFAULT '#334155',
      privacyPolicyUrl TEXT,
      bannerBorderRadius TEXT DEFAULT '0.375rem',
      buttonBorderRadius TEXT DEFAULT '0.375rem',
      stopScroll INTEGER DEFAULT 0,
      footerLink INTEGER DEFAULT 0,
      animationEnabled INTEGER DEFAULT 1,
      preferencePosition TEXT DEFAULT 'right',
      centerAnimationDirection TEXT DEFAULT 'bottom',
      language TEXT DEFAULT 'en',
      autoDetectLanguage INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
    )
  `).run();

  // Migration: Add animation columns if they don't exist
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN animationEnabled INTEGER DEFAULT 1
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN preferencePosition TEXT DEFAULT 'right'
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN centerAnimationDirection TEXT DEFAULT 'bottom'
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN language TEXT DEFAULT 'en'
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN autoDetectLanguage INTEGER DEFAULT 0
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN translations TEXT
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE BannerCustomization ADD COLUMN cookieExpirationDays INTEGER DEFAULT 30
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }

  // Consent table (for consent logs)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Consent (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      deviceId TEXT,
      ipAddress TEXT,
      userAgent TEXT,
      country TEXT,
      region TEXT,
      is_eu INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      regulation TEXT,
      bannerType TEXT,
      consentMethod TEXT,
      status TEXT,
      expiresAt DATETIME,
      consent_categories TEXT,
      tcf_version INTEGER,
      tcf_cmp_id INTEGER,
      tcf_cmp_version INTEGER,
      tcf_consent_screen INTEGER,
      tcf_consent_language TEXT,
      tcf_vendor_list_version INTEGER,
      tcf_use_non_standard_texts INTEGER DEFAULT 0,
      tcf_purpose_one_treatment INTEGER DEFAULT 0,
      tcf_publisher_cc TEXT,
      tcf_purposes_consent TEXT,
      tcf_purposes_li TEXT,
      tcf_special_purposes TEXT,
      tcf_features TEXT,
      tcf_special_features TEXT,
      tcf_vendors_consent TEXT,
      tcf_vendors_li TEXT,
      tcf_publisher_restrictions TEXT,
      tcf_core_string TEXT,
      tcf_publisher_string TEXT,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
    )
  `).run();
  try {
    await db.prepare(`ALTER TABLE Consent ADD COLUMN consent_categories TEXT`).run();
  } catch (e) {
    // Column already exists, ignore
  }

  // PromoCode: for Pro Plan single (monthly/yearly) discounts
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS PromoCode (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      productType TEXT NOT NULL DEFAULT 'pro_single',
      discountType TEXT NOT NULL DEFAULT 'percent',
      discountValue INTEGER NOT NULL,
      stripeCouponId TEXT,
      validFrom DATETIME,
      validUntil DATETIME,
      maxRedemptions INTEGER,
      redemptionCount INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  try {
    await db.prepare(`ALTER TABLE PromoCode ADD COLUMN stripeCouponId TEXT`).run();
  } catch (e) {}

  // Subscription: Stripe subscription linked to organization
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Subscription (
      id TEXT PRIMARY KEY,
      organizationId TEXT NOT NULL,
      stripeSubscriptionId TEXT UNIQUE,
      stripeCustomerId TEXT,
      stripePriceId TEXT,
      planType TEXT NOT NULL DEFAULT 'single',
      interval TEXT NOT NULL DEFAULT 'monthly',
      status TEXT NOT NULL DEFAULT 'active',
      currentPeriodStart DATETIME,
      currentPeriodEnd DATETIME,
      cancelAtPeriodEnd INTEGER DEFAULT 0,
      canceledAt DATETIME,
      promoCodeId TEXT,
      amountCents INTEGER,
      licenseKey TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN licenseKey TEXT`).run();
  } catch (e) {}
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN siteId TEXT`).run();
  } catch (e) {}
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN licenseKeys TEXT`).run();
  } catch (e) {}
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN quantity INTEGER`).run();
  } catch (e) {}
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN cancelledLicenseKeys TEXT`).run();
  } catch (e) {}
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN licenseKeySites TEXT`).run();
  } catch (e) {}

  // LicenseActivation: maps license key to site (for quantity plan keys activated via add-site flow)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS LicenseActivation (
      licenseKey TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      organizationId TEXT NOT NULL,
      subscriptionId TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
    )
  `).run();

  // PaymentEvent: declined payments, retries, cancellations for audit
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS PaymentEvent (
      id TEXT PRIMARY KEY,
      subscriptionId TEXT,
      organizationId TEXT,
      eventType TEXT NOT NULL,
      stripeEventId TEXT,
      stripeInvoiceId TEXT,
      amountCents INTEGER,
      attemptCount INTEGER,
      nextRetryAt DATETIME,
      failureReason TEXT,
      rawPayload TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // ProcessedPaymentIntent: idempotency for payment_intent.succeeded (avoid double-enqueue)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ProcessedPaymentIntent (
      paymentIntentId TEXT PRIMARY KEY,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // SubscriptionQueue: pending bulk licenses; cron creates one Stripe subscription per row, deletes on success
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS SubscriptionQueue (
      id TEXT PRIMARY KEY,
      organizationId TEXT NOT NULL,
      stripeCustomerId TEXT NOT NULL,
      licenseKey TEXT UNIQUE NOT NULL,
      recurringPriceId TEXT NOT NULL,
      interval TEXT NOT NULL DEFAULT 'monthly',
      trialEnd INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      stripeSubscriptionId TEXT,
      errorMessage TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // User: id, email, name, passwordHash (salted PBKDF2)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS User (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      passwordHash TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  try {
    await db.prepare('ALTER TABLE User ADD COLUMN name TEXT').run();
  } catch (e) {}
  try {
    await db.prepare('ALTER TABLE User ADD COLUMN passwordHash TEXT').run();
  } catch (e) {}

  // Session: for auth cookie
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Session (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME NOT NULL,
      FOREIGN KEY (userId) REFERENCES User(id)
    )
  `).run();

  // Organization + OrganizationMember
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Organization (
      id TEXT PRIMARY KEY,
      ownerUserId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ownerUserId) REFERENCES User(id)
    )
  `).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS OrganizationMember (
      organizationId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organizationId, userId),
      FOREIGN KEY (organizationId) REFERENCES Organization(id),
      FOREIGN KEY (userId) REFERENCES User(id)
    )
  `).run();
}

// --- Promo helpers ---
export async function getPromoByCode(db, code, productType = 'pro_single') {
  if (!code || !code.trim()) {
    console.log('[getPromoByCode] empty code');
    return null;
  }
  const normalized = code.trim().toLowerCase();
  const row = await db
    .prepare(
      `SELECT * FROM PromoCode WHERE LOWER(TRIM(code)) = ?1 AND productType = ?2 AND active = 1`
    )
    .bind(normalized, productType)
    .first();
  console.log('[getPromoByCode]', { code: normalized, productType, found: !!row });
  return row || null;
}

export async function isPromoValid(db, promo, interval) {
  if (!promo) return false;
  const now = new Date().toISOString();
  if (promo.validFrom && now < promo.validFrom) {
    console.log('[isPromoValid] not yet valid', { validFrom: promo.validFrom, now });
    return false;
  }
  if (promo.validUntil && now > promo.validUntil) {
    console.log('[isPromoValid] expired', { validUntil: promo.validUntil, now });
    return false;
  }
  if (promo.maxRedemptions != null && (promo.redemptionCount || 0) >= promo.maxRedemptions) {
    console.log('[isPromoValid] max redemptions reached', { redemptionCount: promo.redemptionCount, maxRedemptions: promo.maxRedemptions });
    return false;
  }
  return true;
}

export async function incrementPromoRedemption(db, promoId) {
  await db
    .prepare(
      `UPDATE PromoCode SET redemptionCount = COALESCE(redemptionCount, 0) + 1, updatedAt = ?1 WHERE id = ?2`
    )
    .bind(new Date().toISOString(), promoId)
    .run();
}

// --- Subscription helpers ---
export async function saveSubscription(db, data) {
  let id = data.id;
  if (!id && data.stripeSubscriptionId) {
    const existing = await getSubscriptionByStripeId(db, data.stripeSubscriptionId);
    if (existing) id = existing.id;
  }
  if (!id) id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const siteId = data.siteId ?? null;
  const licenseKeysJson = Array.isArray(data.licenseKeys) ? JSON.stringify(data.licenseKeys) : (data.licenseKeys || null);
  const quantityVal = data.quantity ?? null;
  const cancelledLicenseKeysJson = Array.isArray(data.cancelledLicenseKeys) ? JSON.stringify(data.cancelledLicenseKeys) : (data.cancelledLicenseKeys || null);

  await db
    .prepare(
      `INSERT INTO Subscription (id, organizationId, siteId, stripeSubscriptionId, stripeCustomerId, stripePriceId, planType, interval, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, promoCodeId, amountCents, licenseKey, licenseKeys, quantity, cancelledLicenseKeys, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
       ON CONFLICT(id) DO UPDATE SET
         siteId = ?3, stripeSubscriptionId = ?4, stripeCustomerId = ?5, stripePriceId = ?6, planType = ?7, status = ?9,
         currentPeriodStart = ?10, currentPeriodEnd = ?11, cancelAtPeriodEnd = ?12, licenseKey = ?15, licenseKeys = ?16, quantity = ?17, cancelledLicenseKeys = ?18, updatedAt = ?20`
    )
    .bind(
      id,
      data.organizationId,
      siteId,
      data.stripeSubscriptionId || null,
      data.stripeCustomerId || null,
      data.stripePriceId || null,
      data.planType || 'single',
      data.interval || 'monthly',
      data.status || 'active',
      data.currentPeriodStart || null,
      data.currentPeriodEnd || null,
      data.cancelAtPeriodEnd ? 1 : 0,
      data.promoCodeId || null,
      data.amountCents ?? null,
      data.licenseKey || null,
      licenseKeysJson,
      quantityVal,
      cancelledLicenseKeysJson,
      data.createdAt || now,
      now
    )
    .run();
  return id;
}

export async function getSubscriptionByStripeId(db, stripeSubscriptionId) {
  const row = await db
    .prepare('SELECT * FROM Subscription WHERE stripeSubscriptionId = ?1')
    .bind(stripeSubscriptionId)
    .first();
  return row || null;
}

/** Get subscription by our internal id. */
export async function getSubscriptionById(db, id) {
  if (!id) return null;
  const row = await db
    .prepare('SELECT * FROM Subscription WHERE id = ?1')
    .bind(id)
    .first();
  return row || null;
}

export async function getSubscriptionByOrganization(db, organizationId) {
  const row = await db
    .prepare('SELECT * FROM Subscription WHERE organizationId = ?1 ORDER BY updatedAt DESC LIMIT 1')
    .bind(organizationId)
    .first();
  return row || null;
}

/** All subscriptions for an organization (for licenses tab). */
export async function getSubscriptionsByOrganization(db, organizationId) {
  const { results } = await db
    .prepare('SELECT * FROM Subscription WHERE organizationId = ?1 ORDER BY createdAt DESC')
    .bind(organizationId)
    .all();
  return results || [];
}

/** Activate a license key by linking it to a site. For single/bulk also updates Subscription.siteId. */
export async function activateLicense(db, { licenseKey, siteId, organizationId, subscriptionId }) {
  if (!licenseKey || !siteId || !organizationId) return null;
  try {
    await db
      .prepare(
        `INSERT INTO LicenseActivation (licenseKey, siteId, organizationId, subscriptionId) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(licenseKey) DO UPDATE SET siteId = ?2, organizationId = ?3, subscriptionId = ?4`
      )
      .bind(licenseKey, siteId, organizationId, subscriptionId || null)
      .run();
    // For single/bulk: Subscription has licenseKey column - update siteId
    await db
      .prepare('UPDATE Subscription SET siteId = ?1, updatedAt = ?2 WHERE licenseKey = ?3 AND organizationId = ?4')
      .bind(siteId, new Date().toISOString(), licenseKey, organizationId)
      .run();
    return licenseKey;
  } catch (e) {
    console.error('[activateLicense]', e);
    return null;
  }
}

/** Get activation for a license key. */
export async function getLicenseActivation(db, licenseKey) {
  if (!licenseKey) return null;
  const row = await db
    .prepare('SELECT * FROM LicenseActivation WHERE licenseKey = ?1')
    .bind(licenseKey)
    .first();
  return row || null;
}

/** Get all activations for an organization (licenseKey -> siteId map). */
export async function getLicenseActivationsByOrganization(db, organizationId) {
  const { results } = await db
    .prepare('SELECT licenseKey, siteId FROM LicenseActivation WHERE organizationId = ?1')
    .bind(organizationId)
    .all();
  const map = {};
  for (const r of results || []) {
    const key = r.licenseKey ?? r.licensekey;
    const sid = r.siteId ?? r.siteid;
    if (key) map[key] = sid;
  }
  return map;
}

/** Active subscription for a specific site (single plan = one subscription per site). */
export async function getSubscriptionBySiteId(db, siteId) {
  if (!siteId) return null;
  const row = await db
    .prepare(
      `SELECT * FROM Subscription WHERE siteId = ?1 AND status IN ('active', 'trialing') AND (currentPeriodEnd IS NULL OR currentPeriodEnd > datetime('now')) ORDER BY updatedAt DESC LIMIT 1`
    )
    .bind(siteId)
    .first();
  return row || null;
}

// --- License key generation ---

/** Temporary placeholder keys for bulk checkout (e.g. L1, L2, L3). Used in payment intent metadata until real keys are created on payment success. */
export function generateTempLicenseKeys(quantity) {
  return Array.from({ length: quantity }, (_, i) => `L${i + 1}`);
}

export function generateLicenseKey() {
  const segment = () => Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `CB-${segment()}-${segment()}-${segment()}`;
}

const LICENSE_KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeUniqueLicenseKeySegment() {
  return Array.from({ length: 4 })
    .map(() => LICENSE_KEY_CHARS[Math.floor(Math.random() * LICENSE_KEY_CHARS.length)])
    .join('');
}

function makeUniqueLicenseKeyValue() {
  return (
    'KEY-' +
    Array.from({ length: 4 })
      .map(() => makeUniqueLicenseKeySegment())
      .join('-')
  );
}

/** Generate a license key that does not exist in Subscription or SubscriptionQueue. */
export async function generateUniqueLicenseKey(db) {
  if (!db) {
    const key = makeUniqueLicenseKeyValue();
    console.warn(`[generateUniqueLicenseKey] DB not available - returning key without uniqueness check: ${key.substring(0, 10)}...`);
    return key;
  }

  for (let i = 0; i < 50; i++) {
    try {
      const key = makeUniqueLicenseKeyValue();

      const inSubscription = await db.prepare('SELECT 1 FROM Subscription WHERE licenseKey = ?1 LIMIT 1').bind(key).first();
      if (inSubscription) continue;

      const inLicenseKeys = await db.prepare('SELECT 1 FROM Subscription WHERE licenseKeys IS NOT NULL AND licenseKeys LIKE ?1 LIMIT 1').bind(`%"${key}"%`).first();
      if (inLicenseKeys) continue;

      const inQueue = await db.prepare('SELECT 1 FROM SubscriptionQueue WHERE licenseKey = ?1 LIMIT 1').bind(key).first();
      if (inQueue) continue;

      if (i > 0) {
        console.log(`[generateUniqueLicenseKey] Generated unique key after ${i + 1} attempt(s): ${key.substring(0, 10)}...`);
      }
      return key;
    } catch (e) {
      console.error(`[generateUniqueLicenseKey] Database error (attempt ${i + 1}):`, e.message);
      if (e.message && e.message.includes('no such table')) {
        const key = makeUniqueLicenseKeyValue();
        console.warn(`[generateUniqueLicenseKey] Table not found - returning key without check: ${key.substring(0, 10)}...`);
        return key;
      }
      if (i === 49) throw new Error(`Failed to generate unique license key after 50 attempts. Last error: ${e.message}`);
    }
  }

  throw new Error('Failed to generate unique license key after 50 attempts (all keys were duplicates)');
}

/** Generate multiple unique license keys. */
export async function generateLicenseKeys(quantity, db) {
  const keys = [];
  for (let i = 0; i < quantity; i++) {
    const key = await generateUniqueLicenseKey(db);
    keys.push(key);
  }
  return keys;
}

// --- ProcessedPaymentIntent (idempotency for payment_intent.succeeded) ---
export async function markPaymentIntentProcessed(db, paymentIntentId) {
  try {
    await db.prepare('INSERT INTO ProcessedPaymentIntent (paymentIntentId) VALUES (?1)').bind(paymentIntentId).run();
    return true;
  } catch (e) {
    if (e.message && (e.message.includes('UNIQUE') || e.message.includes('SQLITE_CONSTRAINT'))) return false;
    throw e;
  }
}

// --- SubscriptionQueue helpers ---
export async function enqueueBulkLicenseJobs(db, { organizationId, stripeCustomerId, quantity, recurringPriceId, interval, trialEnd }) {
  const now = new Date().toISOString();
  const keys = await generateLicenseKeys(quantity, db);
  for (let i = 0; i < quantity; i++) {
    const id = `q_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`;
    await db
      .prepare(
        `INSERT INTO SubscriptionQueue (id, organizationId, stripeCustomerId, licenseKey, recurringPriceId, interval, trialEnd, status, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)`
      )
      .bind(id, organizationId, stripeCustomerId, keys[i], recurringPriceId, interval, trialEnd, now)
      .run();
  }
}

export async function getPendingSubscriptionQueue(db, limit = 20) {
  const { results } = await db
    .prepare('SELECT * FROM SubscriptionQueue WHERE status = ?1 ORDER BY createdAt ASC LIMIT ?2')
    .bind('pending', limit)
    .all();
  return results || [];
}

export async function deleteSubscriptionQueueRow(db, id) {
  await db.prepare('DELETE FROM SubscriptionQueue WHERE id = ?1').bind(id).run();
}

export async function markSubscriptionQueueFailed(db, id, errorMessage) {
  const now = new Date().toISOString();
  await db
    .prepare('UPDATE SubscriptionQueue SET status = ?1, errorMessage = ?2, updatedAt = ?3 WHERE id = ?4')
    .bind('failed', errorMessage || null, now, id)
    .run();
}

// --- PaymentEvent helpers ---
export async function savePaymentEvent(db, data) {
  const id = data.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await db
    .prepare(
      `INSERT INTO PaymentEvent (id, subscriptionId, organizationId, eventType, stripeEventId, stripeInvoiceId, amountCents, attemptCount, nextRetryAt, failureReason, rawPayload, createdAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    )
    .bind(
      id,
      data.subscriptionId || null,
      data.organizationId || null,
      data.eventType,
      data.stripeEventId || null,
      data.stripeInvoiceId || null,
      data.amountCents ?? null,
      data.attemptCount ?? null,
      data.nextRetryAt || null,
      data.failureReason || null,
      data.rawPayload ? JSON.stringify(data.rawPayload) : null,
      data.createdAt || new Date().toISOString()
    )
    .run();
  return id;
}

// --- Site helpers ---

export async function getSiteByCdnId(db, cdnScriptId) {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM Site WHERE cdnScriptId = ?1')
    .bind(cdnScriptId)
    .first();
  return row || null;
}

export async function getSiteById(db, siteId) {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT * FROM Site WHERE id = ?1')
    .bind(siteId)
    .first();
  return row || null;
}

export async function listSites(db, { organizationId } = {}) {
  await ensureSchema(db);

  if (organizationId) {
    const { results } = await db
      .prepare(
        'SELECT * FROM Site WHERE organizationId = ?1 ORDER BY createdAt DESC',
      )
      .bind(organizationId)
      .all();
    return results || [];
  }

  const { results } = await db
    .prepare('SELECT * FROM Site ORDER BY createdAt DESC')
    .all();
  return results || [];
}

// createSite: upsert by organizationId + domain
// IMPORTANT: cdnScriptId is permanent and never regenerated for existing sites
// This ensures the installation script code remains stable for each site
export async function createSite(
  db,
  { organizationId, name, domain, origin, bannerType, regionMode },
) {
  await ensureSchema(db);

  const existing = await db
    .prepare(
      'SELECT * FROM Site WHERE organizationId = ?1 AND domain = ?2',
    )
    .bind(organizationId, domain)
    .first();

  const now = new Date().toISOString();

  if (existing) {
    // Update only banner settings - preserve permanent cdnScriptId and apiKey
    await db
      .prepare(
        `UPDATE Site
         SET name = ?1,
             banner_type = ?2,
             region_mode = ?3,
             updatedAt = ?4
         WHERE id = ?5`,
      )
      .bind(name, bannerType, regionMode, now, existing.id)
      .run();

    return {
      ...existing,
      name,
      banner_type: bannerType,
      region_mode: regionMode,
      updatedAt: now,
      // cdnScriptId and apiKey are preserved from existing record
    };
  }

  const id = crypto.randomUUID();
  const cdnScriptId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO Site (
         id,
         organizationId,
         name,
         domain,
         cdnScriptId,
         apiKey,
         banner_type,
         region_mode,
         createdAt,
         updatedAt
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      id,
      organizationId,
      name,
      domain,
      cdnScriptId,
      apiKey,
      bannerType,
      regionMode,
      now,
      now,
    )
    .run();

  return {
    id,
    organizationId,
    name,
    domain,
    cdnScriptId,
    apiKey,
    banner_type: bannerType,
    region_mode: regionMode,
    createdAt: now,
    updatedAt: now,
  };
}

// --- Scripts ---

export async function saveReportedScripts(db, { siteId, scripts }) {
  await ensureSchema(db);

  for (const s of scripts) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO Script (
           id, siteId, scriptUrl, scriptType, category, provider, description
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        siteId,
        s.scriptUrl || '',
        s.scriptType || 'external',
        s.category || 'functional',
        s.provider || null,
        s.name || null,
      )
      .run();
  }

  return { count: scripts.length };
}

export async function recordConsent(
  db,
  { siteId, consent, ipAddress, userAgent },
) {
  await ensureSchema(db);

  const id = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000,
  ).toISOString();

  await db
    .prepare(
      `INSERT INTO Consent (
         id, siteId, ipAddress, userAgent,
         necessary, analytics, marketing, functional, social,
         consentMethod, expiresAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      siteId,
      ipAddress || null,
      userAgent || null,
      consent.necessary ? 1 : 0,
      consent.analytics ? 1 : 0,
      consent.marketing ? 1 : 0,
      consent.functional ? 1 : 0,
      consent.social ? 1 : 0,
      consent.method || 'custom',
      expiresAt,
    )
    .run();

  return { id, expiresAt };
}

// --- Password hashing (PBKDF2-HMAC-SHA256, safe for Workers) ---
const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return arr.buffer;
}

export async function hashPassword(plainPassword) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(plainPassword),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    HASH_BYTES * 8
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassword(plainPassword, storedSaltHash) {
  const [saltHex, hashHex] = storedSaltHash.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = fromHex(saltHex);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(plainPassword),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    key,
    HASH_BYTES * 8
  );
  return toHex(bits) === hashHex;
}

// --- Users ---

export async function getUserByEmail(db, email) {
  const user = await db
    .prepare('SELECT * FROM User WHERE email = ?1')
    .bind(email)
    .first();
  return user || null;
}

export async function createUser(db, { email, name, passwordHash }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO User (id, email, name, passwordHash, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
    )
    .bind(
      id,
      email.trim().toLowerCase(),
      (name || '').trim() || null,
      passwordHash,
      now
    )
    .run();
  return { id, email: email.trim().toLowerCase(), name: (name || '').trim() || null };
}

export async function getUserById(db, id) {
  const user = await db
    .prepare('SELECT * FROM User WHERE id = ?1')
    .bind(id)
    .first();
  return user || null;
}
// --- Site verification ---

export async function markSiteVerified(db, siteId, scriptUrl) {
  if (!siteId) return; // nothing to do

  await db
    .prepare(
      `
      UPDATE Site
      SET verified = 1,
          verified_at = datetime('now'),
          cdnScriptId = ?2
      WHERE id = ?1
    `,
    )
    .bind(siteId, scriptUrl)
    .run();
}

// --- Sessions ---

export async function createSession(db, { userId }) {
  const id = crypto.randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  await db
    .prepare(
      `INSERT INTO Session (id, userId, createdAt, expiresAt)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(id, userId, createdAt, expiresAt)
    .run();

  return { id, userId, createdAt, expiresAt };
}

export async function getSessionById(db, id) {
  if (!id) return null;
  const session = await db
    .prepare('SELECT * FROM Session WHERE id = ?1 AND expiresAt > datetime(\'now\')')
    .bind(id)
    .first();
  return session || null;
}

// --- Organizations ---

export async function createOrganization(db, { ownerUserId, name }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO Organization (id, ownerUserId, name, createdAt)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(id, ownerUserId, name, createdAt)
    .run();

  return { id, ownerUserId, name, createdAt };
}

export async function addOrganizationMember(
  db,
  { organizationId, userId, role },
) {
  const joinedAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT OR IGNORE INTO OrganizationMember
       (organizationId, userId, role, joinedAt)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(organizationId, userId, role, joinedAt)
    .run();
}

export async function getOrganizationsForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT o.*
       FROM Organization o
       JOIN OrganizationMember m ON m.organizationId = o.id
       WHERE m.userId = ?1`,
    )
    .bind(userId)
    .all();
  return results || [];
}

// --- Scan-related database operations ---

/**
 * Create a scan history record
 * id is optional; if not provided, a UUID is generated.
 */
export async function createScanHistory(db, { id, siteId, scanUrl, scriptsFound, cookiesFound, scanDuration }) {
  await ensureSchema(db);

  const scanHistoryId = id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const duration = scanDuration === undefined ? null : scanDuration;

  await db
    .prepare(
      `INSERT INTO ScanHistory (id, siteId, scanUrl, scriptsFound, cookiesFound, scanDuration, scanStatus, createdAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      scanHistoryId,
      siteId,
      scanUrl,
      scriptsFound ?? 0,
      cookiesFound ?? 0,
      duration,
      'completed',
      now,
    )
    .run();

  return { scanHistoryId, createdAt: now };
}

/**
 * Insert or update a cookie
 */
export async function upsertCookie(db, { siteId, scanHistoryId, cookie, now }) {
  await ensureSchema(db);

  // Coerce undefined to null for D1 (D1 rejects undefined)
  const v = (x) => (x === undefined ? null : x);
  const name = v(cookie?.name) ?? '';
  const domain = v(cookie?.domain);
  const path = (v(cookie?.path) || '/');
  const category = (v(cookie?.category) || 'uncategorized'); // NOT NULL
  const provider = v(cookie?.provider);
  const description = v(cookie?.description);
  const expires = v(cookie?.expires);
  const httpOnly = cookie?.httpOnly ? 1 : 0;
  const secure = cookie?.secure ? 1 : 0;
  const sameSite = v(cookie?.sameSite);
  const ts = v(now) || new Date().toISOString();

  const bindValues = [
    { i: 1, key: 'cookieId', val: crypto.randomUUID() },
    { i: 2, key: 'siteId', val: siteId },
    { i: 3, key: 'scanHistoryId', val: scanHistoryId },
    { i: 4, key: 'name', val: name },
    { i: 5, key: 'domain', val: domain },
    { i: 6, key: 'path', val: path },
    { i: 7, key: 'category', val: category },
    { i: 8, key: 'provider', val: provider },
    { i: 9, key: 'description', val: description },
    { i: 10, key: 'expires', val: expires },
    { i: 11, key: 'httpOnly', val: httpOnly },
    { i: 12, key: 'secure', val: secure },
    { i: 13, key: 'sameSite', val: sameSite },
    { i: 14, key: 'firstSeenAt', val: ts },
    { i: 15, key: 'lastSeenAt', val: ts },
  ];
  for (const { key, val } of bindValues) {
    if (val === undefined) {
      console.error('[db] upsertCookie undefined bind:', key, 'full cookie:', JSON.stringify(cookie));
    }
  }
  console.log('[db] upsertCookie bind values:', bindValues.map(({ key, val }) => `${key}=${val === undefined ? 'UNDEFINED' : typeof val === 'string' ? val.slice(0, 40) : val}`).join(', '));

  const cookieId = bindValues[0].val;
  try {
    await db
      .prepare(
        `INSERT INTO Cookie (id, siteId, scanHistoryId, name, domain, path, category, provider, description, expires, httpOnly, secure, sameSite, firstSeenAt, lastSeenAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(siteId, name, domain) DO UPDATE SET
           lastSeenAt = excluded.lastSeenAt,
           scanHistoryId = excluded.scanHistoryId,
           category = excluded.category,
           provider = excluded.provider,
           description = CASE 
             WHEN excluded.description IS NOT NULL THEN excluded.description
             ELSE Cookie.description
           END`,
      )
      .bind(
        cookieId,
        siteId,
        scanHistoryId,
        name,
        domain,
        path,
        category,
        provider,
        description,
        expires,
        httpOnly,
        secure,
        sameSite,
        ts,
        ts,
      )
      .run();
    return { success: true, cookieId };
  } catch (insertErr) {
    console.error('[db] Failed to insert cookie:', insertErr);
    return { success: false, error: insertErr.message };
  }
}

/**
 * Insert or update multiple cookies in batch
 */
export async function upsertCookies(db, { siteId, scanHistoryId, cookies }) {
  await ensureSchema(db);
  
  const now = new Date().toISOString();
  const results = [];
  
  for (const cookie of cookies) {
    const result = await upsertCookie(db, { siteId, scanHistoryId, cookie, now });
    results.push(result);
  }
  
  return results;
}

/**
 * Insert or update a script
 */
export async function upsertScript(db, { siteId, scriptUrl, category, scriptType = 'external' }) {
  await ensureSchema(db);
  
  const scriptId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  try {
    await db
      .prepare(
        `INSERT INTO Script (id, siteId, scriptUrl, category, scriptType, createdAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(siteId, scriptUrl) DO UPDATE SET
           category = excluded.category`,
      )
      .bind(scriptId, siteId, scriptUrl, category, scriptType, now)
      .run();
    return { success: true, scriptId };
  } catch (insertErr) {
    console.error('[db] Failed to insert script:', insertErr);
    return { success: false, error: insertErr.message };
  }
}

/**
 * Insert or update multiple scripts in batch
 */
export async function upsertScripts(db, { siteId, scripts }) {
  await ensureSchema(db);
  
  const results = [];
  
  for (const script of scripts) {
    const result = await upsertScript(db, {
      siteId,
      scriptUrl: script.url || script,
      category: script.category || 'uncategorized',
      scriptType: script.type || 'external',
    });
    results.push(result);
  }
  
  return results;
}

// src/services/scanDb.ts

export async function ensureScanSchema(db) {
  await db
    .prepare(`
      CREATE TABLE IF NOT EXISTS Script (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        scriptUrl TEXT NOT NULL,
        scriptType TEXT,
        category TEXT NOT NULL,
        provider TEXT,
        description TEXT,
        detected INTEGER DEFAULT 0,
        blocked INTEGER DEFAULT 1,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
      )
    `)
    .run();

  await db
    .prepare(`
      CREATE TABLE IF NOT EXISTS ScanHistory (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        scanUrl TEXT,
        scriptsFound INTEGER DEFAULT 0,
        cookiesFound INTEGER DEFAULT 0,
        scanDuration INTEGER,
        scanStatus TEXT DEFAULT 'completed',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE
      )
    `)
    .run();

  // Unique index on siteId + scriptUrl
  try {
    await db
      .prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_script_site_url ON Script(siteId, scriptUrl)
      `)
      .run();
  } catch (e) {
    // Ignore if index already exists
  }
}

export async function insertScripts(
  db,
  siteId,
  scripts
) {
  const now = new Date().toISOString();
  let inserted = 0;

  const insertStmt = db.prepare(`
    INSERT INTO Script (id, siteId, scriptUrl, category, scriptType, createdAt)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(siteId, scriptUrl) DO UPDATE SET
      category = excluded.category,
      createdAt = excluded.createdAt
  `);

  for (const src of scripts) {
    const category = categorize(src);
    const id = crypto.randomUUID();

    try {
      await insertStmt
        .bind(id, siteId, src, category, 'external', now)
        .run();
      inserted++;
    } catch (err) {
      console.error('[ScanScripts] Failed to insert script:', err);
      // Continue with next script
    }
  }

  return inserted;
}

export async function recordScanHistory(
  db,
  siteId,
  scanUrl,
  scriptsFound,
  cookiesFound = 0,
  scanDuration
) {
  const now = new Date().toISOString();
  const scanHistoryId = crypto.randomUUID();

  await db
    .prepare(`
      INSERT INTO ScanHistory (id, siteId, scanUrl, scriptsFound, cookiesFound, scanDuration, scanStatus, createdAt)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `)
    .bind(
      scanHistoryId,
      siteId,
      scanUrl,
      scriptsFound,
      cookiesFound,
      scanDuration,
      'completed',
      now
    )
    .run();

  return scanHistoryId;
}

function categorize(src) {
  try {
    const u = new URL(src);
    const host = u.hostname;

    if (
      host.includes('google-analytics.com') ||
      src.includes('gtag/js') ||
      host.includes('googletagmanager.com')
    ) {
      return 'analytics';
    }
    if (
      host.includes('facebook.com') ||
      host.includes('fbcdn.net') ||
      host.includes('doubleclick.net') ||
      host.includes('ads.')
    ) {
      return 'marketing';
    }
    if (
      host.includes('hotjar.com') ||
      host.includes('intercom.io') ||
      host.includes('fullstory.com')
    ) {
      return 'behavioral';
    }
    return 'uncategorized';
  } catch (e) {
    return 'uncategorized';
  }
}

// --- Banner Customization helpers ---

export async function getBannerCustomization(db, siteId) {
  try {
    const result = await db
      .prepare('SELECT * FROM BannerCustomization WHERE siteId = ?1')
      .bind(siteId)
      .first();
    return result || null;
  } catch (error) {
    console.error('[db] Error getting banner customization:', error);
    return null;
  }
}

// --- Scheduled Scan helpers ---

export async function getScheduledScans(db, siteId) {
  try {
    const { results } = await db
      .prepare(
        'SELECT * FROM ScheduledScan WHERE siteId = ?1 AND isActive = 1 ORDER BY scheduledAt ASC'
      )
      .bind(siteId)
      .all();
    return results || [];
  } catch (error) {
    console.error('[db] Error getting scheduled scans:', error);
    return [];
  }
}

export async function createScheduledScan(db, { siteId, scheduledAt, frequency = 'once' }) {
  try {
    const id = `scheduled-${siteId}-${Date.now()}`;
    const now = new Date().toISOString();
    
    // Calculate nextRunAt based on frequency
    let nextRunAt = scheduledAt;
    if (frequency === 'daily') {
      const next = new Date(scheduledAt);
      next.setDate(next.getDate() + 1);
      nextRunAt = next.toISOString();
    } else if (frequency === 'weekly') {
      const next = new Date(scheduledAt);
      next.setDate(next.getDate() + 7);
      nextRunAt = next.toISOString();
    } else if (frequency === 'monthly') {
      const next = new Date(scheduledAt);
      next.setMonth(next.getMonth() + 1);
      nextRunAt = next.toISOString();
    }

    await db
      .prepare(
        `INSERT INTO ScheduledScan (id, siteId, scheduledAt, frequency, isActive, nextRunAt, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)`
      )
      .bind(id, siteId, scheduledAt, frequency, nextRunAt, now, now)
      .run();

    return { success: true, id };
  } catch (error) {
    console.error('[db] Error creating scheduled scan:', error);
    return { success: false, error: error.message };
  }
}

export async function deleteScheduledScan(db, id) {
  try {
    await db
      .prepare('UPDATE ScheduledScan SET isActive = 0, updatedAt = ?1 WHERE id = ?2')
      .bind(new Date().toISOString(), id)
      .run();
    return { success: true };
  } catch (error) {
    console.error('[db] Error deleting scheduled scan:', error);
    return { success: false, error: error.message };
  }
}

export async function getDueScheduledScans(db) {
  try {
    const now = new Date().toISOString();
    const { results } = await db
      .prepare(
        'SELECT * FROM ScheduledScan WHERE isActive = 1 AND nextRunAt <= ?1'
      )
      .bind(now)
      .all();
    return results || [];
  } catch (error) {
    console.error('[db] Error getting due scheduled scans:', error);
    return [];
  }
}

export async function updateScheduledScanAfterRun(db, id, lastRunAt, nextRunAt) {
  try {
    await db
      .prepare('UPDATE ScheduledScan SET lastRunAt = ?1, nextRunAt = ?2, updatedAt = ?3 WHERE id = ?4')
      .bind(lastRunAt, nextRunAt, new Date().toISOString(), id)
      .run();
    return { success: true };
  } catch (error) {
    console.error('[db] Error updating scheduled scan after run:', error);
    return { success: false, error: error.message };
  }
}

export async function deactivateScheduledScan(db, id, lastRunAt) {
  try {
    await db
      .prepare('UPDATE ScheduledScan SET isActive = 0, lastRunAt = ?1, updatedAt = ?2 WHERE id = ?3')
      .bind(lastRunAt, new Date().toISOString(), id)
      .run();
    return { success: true };
  } catch (error) {
    console.error('[db] Error deactivating scheduled scan:', error);
    return { success: false, error: error.message };
  }
}

export function calculateNextRunAt(scheduledAt, frequency, currentNextRunAt = null) {
  const baseDate = currentNextRunAt ? new Date(currentNextRunAt) : new Date(scheduledAt);
  
  if (frequency === 'daily') {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + 1);
    return next.toISOString();
  } else if (frequency === 'weekly') {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + 7);
    return next.toISOString();
  } else if (frequency === 'monthly') {
    const next = new Date(baseDate);
    next.setMonth(next.getMonth() + 1);
    return next.toISOString();
  }
  
  return scheduledAt; // 'once' - return original scheduledAt
}

export async function saveBannerCustomization(db, siteId, customization) {
  try {
    const now = new Date().toISOString();
    const id = `banner-custom-${siteId}`;
    
    const translationsJson = customization.translations != null
      ? (typeof customization.translations === 'string' ? customization.translations : JSON.stringify(customization.translations))
      : null;

    await db
      .prepare(`
        INSERT INTO BannerCustomization (
          id, siteId, position, backgroundColor, textColor, headingColor,
          acceptButtonBg, acceptButtonText, rejectButtonBg, rejectButtonText,
          customiseButtonBg, customiseButtonText, saveButtonBg, saveButtonText,
          backButtonBg, backButtonText, doNotSellButtonBg, doNotSellButtonText,
          privacyPolicyUrl, bannerBorderRadius, buttonBorderRadius,
          stopScroll, footerLink, animationEnabled, preferencePosition, centerAnimationDirection,
          language, autoDetectLanguage, translations, cookieExpirationDays,
          createdAt, updatedAt
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32
        )
        ON CONFLICT(siteId) DO UPDATE SET
          position = ?3,
          backgroundColor = ?4,
          textColor = ?5,
          headingColor = ?6,
          acceptButtonBg = ?7,
          acceptButtonText = ?8,
          rejectButtonBg = ?9,
          rejectButtonText = ?10,
          customiseButtonBg = ?11,
          customiseButtonText = ?12,
          saveButtonBg = ?13,
          saveButtonText = ?14,
          backButtonBg = ?15,
          backButtonText = ?16,
          doNotSellButtonBg = ?17,
          doNotSellButtonText = ?18,
          privacyPolicyUrl = ?19,
          bannerBorderRadius = ?20,
          buttonBorderRadius = ?21,
          stopScroll = ?22,
          footerLink = ?23,
          animationEnabled = ?24,
          preferencePosition = ?25,
          centerAnimationDirection = ?26,
          language = ?27,
          autoDetectLanguage = ?28,
          translations = ?29,
          cookieExpirationDays = ?30,
          updatedAt = ?32
      `)
      .bind(
        id,
        siteId,
        customization.position || 'bottom-left',
        customization.backgroundColor || '#ffffff',
        customization.textColor || '#334155',
        customization.headingColor || '#0f172a',
        customization.acceptButtonBg || '#0284c7',
        customization.acceptButtonText || '#ffffff',
        customization.rejectButtonBg || '#ffffff',
        customization.rejectButtonText || '#334155',
        customization.customiseButtonBg || '#ffffff',
        customization.customiseButtonText || '#334155',
        customization.saveButtonBg || '#ffffff',
        customization.saveButtonText || '#334155',
        customization.backButtonBg || '#ffffff',
        customization.backButtonText || '#334155',
        customization.doNotSellButtonBg || '#ffffff',
        customization.doNotSellButtonText || '#334155',
        customization.privacyPolicyUrl || null,
        customization.bannerBorderRadius || '0.375rem',
        customization.buttonBorderRadius || '0.375rem',
        customization.stopScroll ? 1 : 0,
        customization.footerLink ? 1 : 0,
        customization.animationEnabled !== undefined ? (customization.animationEnabled ? 1 : 0) : 1,
        customization.preferencePosition || 'right',
        customization.centerAnimationDirection || 'bottom',
        customization.language || 'en',
        customization.autoDetectLanguage ? 1 : 0,
        translationsJson,
        customization.cookieExpirationDays != null ? Math.max(1, Math.min(365, Number(customization.cookieExpirationDays) || 30)) : 30,
        now,
        now
      )
      .run();

    return { success: true };
  } catch (error) {
    console.error('[db] Error saving banner customization:', error);
    throw error;
  }
}
