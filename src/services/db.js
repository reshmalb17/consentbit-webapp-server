// src/services/db.js

// --- Schema ---

// Cache per Worker instance — ensureSchema only runs once per cold start.
const _schemaEnsured = new WeakMap();

export async function ensureSchema(db) {
  if (_schemaEnsured.get(db)) return;
  _schemaEnsured.set(db, true);
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

  try {
    await db.prepare(`
      ALTER TABLE Site ADD COLUMN embedScriptUrl TEXT
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    await db.prepare(`
      ALTER TABLE Site ADD COLUMN pendingScan INTEGER DEFAULT 0
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

  // Create unique index on siteId + name + domain.
  // Domain is always stored as '' (never NULL) so plain column index works with ON CONFLICT.
  try {
    await db.prepare(`DROP INDEX IF EXISTS idx_cookie_site_name`).run();
  } catch (e) { /* ignore */ }
  try {
    await db.prepare(`DROP INDEX IF EXISTS idx_cookie_site_name_domain`).run();
  } catch (e) { /* ignore */ }
  try {
    await db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cookie_site_name_domain
      ON Cookie(siteId, name, domain)
    `).run();
  } catch (e) {
    // Index might already exist, ignore
  }
  // Remove duplicate cookie rows — keep only the most recent per (siteId, name, domain)
  try {
    await db.prepare(`
      DELETE FROM Cookie
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY siteId, name, domain
            ORDER BY lastSeenAt DESC
          ) AS rn FROM Cookie
        ) WHERE rn = 1
      )
    `).run();
  } catch (e) { /* ignore — window functions may not be available on older D1 */ }

  // Cookie table migrations
  try {
    await db.prepare(`
      ALTER TABLE Cookie ADD COLUMN isExpected INTEGER DEFAULT 0
    `).run();
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    await db.prepare(`
      ALTER TABLE Cookie ADD COLUMN source TEXT
    `).run();
  } catch (e) {
    // Column already exists, ignore
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
      preferencePosition TEXT DEFAULT 'center',
      centerAnimationDirection TEXT DEFAULT 'fade',
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
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN planId TEXT`).run();
  } catch (e) {}

  // Plan: pricing tiers for Upgrade tab (Free, Basic, Essential, Growth)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Plan (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      monthlyAmountCents INTEGER NOT NULL,
      yearlyAmountCents INTEGER NOT NULL,
      yearlyTotalCents INTEGER NOT NULL,
      domainsIncluded INTEGER NOT NULL,
      scansIncluded INTEGER NOT NULL,
      pageviewsIncluded INTEGER NOT NULL,
      extraScansPriceCentsPerUnit INTEGER,
      extraPageviewsPriceCentsPerUnit INTEGER,
      trialDays INTEGER DEFAULT 0,
      hasIabTcf INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // PageviewUsage: monthly pageview counts per site
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS PageviewUsage (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      yearMonth TEXT NOT NULL,
      pageviewCount INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(siteId, yearMonth)
    )
  `).run();
  try {
    await db.prepare(`ALTER TABLE Subscription ADD COLUMN planId TEXT`).run();
  } catch (e) {}

  // Plan: pricing tiers for Upgrade tab (Free, Basic, Essential, Growth)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS Plan (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      monthlyAmountCents INTEGER NOT NULL,
      yearlyAmountCents INTEGER NOT NULL,
      yearlyTotalCents INTEGER NOT NULL,
      domainsIncluded INTEGER NOT NULL,
      scansIncluded INTEGER NOT NULL,
      pageviewsIncluded INTEGER NOT NULL,
      extraScansPriceCentsPerUnit INTEGER,
      extraPageviewsPriceCentsPerUnit INTEGER,
      trialDays INTEGER DEFAULT 0,
      hasIabTcf INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // PageviewUsage: monthly pageview counts per site
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS PageviewUsage (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      yearMonth TEXT NOT NULL,
      pageviewCount INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(siteId, yearMonth)
    )
  `).run();

  // ScanUsage: monthly scan counts per site (counter table — avoids COUNT(*) on ScanHistory)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS ScanUsage (
      id TEXT PRIMARY KEY,
      siteId TEXT NOT NULL,
      yearMonth TEXT NOT NULL,
      scanCount INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(siteId, yearMonth)
    )
  `).run();

  // One-time backfill: populate ScanUsage from existing ScanHistory records.
  // Runs only when ScanUsage is empty (first deploy after table creation).
  try {
    const existing = await db.prepare('SELECT COUNT(*) AS cnt FROM ScanUsage').first();
    if (Number(existing?.cnt ?? 0) === 0) {
      await db.prepare(`
        INSERT OR IGNORE INTO ScanUsage (id, siteId, yearMonth, scanCount, createdAt, updatedAt)
        SELECT
          siteId || ':' || strftime('%Y-%m', createdAt),
          siteId,
          strftime('%Y-%m', createdAt),
          COUNT(*),
          MIN(createdAt),
          MAX(createdAt)
        FROM ScanHistory
        GROUP BY siteId, strftime('%Y-%m', createdAt)
      `).run();
    }
  } catch (e) {
    console.warn('[ensureSchema] ScanUsage backfill failed', e?.message);
  }

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

  // Seed default Upgrade plans
  await ensureDefaultPlans(db);

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
  // Backwards-compatible migrations for auth columns
  try {
    await db.prepare('ALTER TABLE User ADD COLUMN name TEXT').run();
  } catch (e) {}
  try {
    await db.prepare('ALTER TABLE User ADD COLUMN passwordHash TEXT').run();
  } catch (e) {}
  // Some earlier schemas used snake_case password_hash with NOT NULL constraint.
  // Ensure the column exists and is kept in sync with passwordHash so inserts don't fail.
  try {
    await db.prepare('ALTER TABLE User ADD COLUMN password_hash TEXT').run();
  } catch (e) {}
  try {
    await db
      .prepare('UPDATE User SET password_hash = passwordHash WHERE password_hash IS NULL AND passwordHash IS NOT NULL')
      .run();
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

  // One-time email verification codes (passwordless login/signup)
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS EmailVerificationCode (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL, -- 'login' | 'signup'
      codeHash TEXT NOT NULL,
      name TEXT, -- only for signup
      attempts INTEGER DEFAULT 0,
      consumedAt DATETIME,
      expiresAt DATETIME NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_evc_email_purpose_created ON EmailVerificationCode(email, purpose, createdAt)`).run();
  } catch (e) {}
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_evc_expires ON EmailVerificationCode(expiresAt)`).run();
  } catch (e) {}

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

export async function createEmailVerificationCode(
  db,
  { email, purpose, codeHash, name, ttlMinutes = 10 } = {},
) {
  await ensureSchema(db);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO EmailVerificationCode (id, email, purpose, codeHash, name, attempts, consumedAt, expiresAt, createdAt)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?7)`,
    )
    .bind(id, email.trim().toLowerCase(), purpose, codeHash, name || null, expiresAt, now.toISOString())
    .run();
  return { id, expiresAt };
}

export async function getLatestValidEmailVerificationCode(db, { email, purpose } = {}) {
  await ensureSchema(db);
  const row = await db
    .prepare(
      `SELECT *
       FROM EmailVerificationCode
       WHERE email = ?1 AND purpose = ?2
         AND consumedAt IS NULL
         AND expiresAt > datetime('now')
       ORDER BY createdAt DESC
       LIMIT 1`,
    )
    .bind((email || '').trim().toLowerCase(), purpose)
    .first();
  return row || null;
}

export async function incrementEmailVerificationAttempts(db, id) {
  await ensureSchema(db);
  await db
    .prepare(`UPDATE EmailVerificationCode SET attempts = COALESCE(attempts, 0) + 1 WHERE id = ?1`)
    .bind(id)
    .run();
}

export async function consumeEmailVerificationCode(db, id) {
  await ensureSchema(db);
  await db
    .prepare(`UPDATE EmailVerificationCode SET consumedAt = datetime('now') WHERE id = ?1`)
    .bind(id)
    .run();
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

// --- Plan helpers ---
export async function ensureDefaultPlans(db) {
  const now = new Date().toISOString();
  const plans = [
    {
      id: 'free',
      name: 'Free plan',
      monthlyAmountCents: 0,
      yearlyAmountCents: 0,
      yearlyTotalCents: 0,
      domainsIncluded: 1,
      scansIncluded: 100,
      pageviewsIncluded: 7500,
      extraScansPriceCentsPerUnit: null,
      extraPageviewsPriceCentsPerUnit: null,
      trialDays: 0,
      hasIabTcf: 0,
    },
    {
      id: 'basic',
      name: 'Basic plan',
      monthlyAmountCents: 900,
      yearlyAmountCents: 800,
      yearlyTotalCents: 9600,
      domainsIncluded: 1,
      scansIncluded: 750,
      pageviewsIncluded: 100000,
      extraScansPriceCentsPerUnit: null,
      extraPageviewsPriceCentsPerUnit: null,
      trialDays: 14,
      hasIabTcf: 0,
    },
    {
      id: 'essential',
      name: 'Essential plan',
      monthlyAmountCents: 2000,
      yearlyAmountCents: 1600,
      yearlyTotalCents: 19200,
      domainsIncluded: 1,
      scansIncluded: 5000,
      pageviewsIncluded: 500000,
      extraScansPriceCentsPerUnit: 49, // $0.49 per 10k scans/pageviews step (stored as cents)
      extraPageviewsPriceCentsPerUnit: 49,
      trialDays: 14,
      hasIabTcf: 1,
    },
    {
      id: 'growth',
      name: 'Growth plan',
      monthlyAmountCents: 5600,
      yearlyAmountCents: 4200,
      yearlyTotalCents: 50400,
      domainsIncluded: 1,
      scansIncluded: 10000,
      pageviewsIncluded: 2000000,
      extraScansPriceCentsPerUnit: 49, // $0.49 per 100 scans step
      extraPageviewsPriceCentsPerUnit: 39, // $0.39 per 10k pageviews step
      trialDays: 14,
      hasIabTcf: 1,
    },
  ];

  for (const p of plans) {
    await db
      .prepare(
        `INSERT INTO Plan (id, name, monthlyAmountCents, yearlyAmountCents, yearlyTotalCents, domainsIncluded, scansIncluded, pageviewsIncluded, extraScansPriceCentsPerUnit, extraPageviewsPriceCentsPerUnit, trialDays, hasIabTcf, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           monthlyAmountCents = excluded.monthlyAmountCents,
           yearlyAmountCents = excluded.yearlyAmountCents,
           yearlyTotalCents = excluded.yearlyTotalCents,
           domainsIncluded = excluded.domainsIncluded,
           scansIncluded = excluded.scansIncluded,
           pageviewsIncluded = excluded.pageviewsIncluded,
           extraScansPriceCentsPerUnit = excluded.extraScansPriceCentsPerUnit,
           extraPageviewsPriceCentsPerUnit = excluded.extraPageviewsPriceCentsPerUnit,
           trialDays = excluded.trialDays,
           hasIabTcf = excluded.hasIabTcf,
           updatedAt = excluded.updatedAt`
      )
      .bind(
        p.id,
        p.name,
        p.monthlyAmountCents,
        p.yearlyAmountCents,
        p.yearlyTotalCents,
        p.domainsIncluded,
        p.scansIncluded,
        p.pageviewsIncluded,
        p.extraScansPriceCentsPerUnit,
        p.extraPageviewsPriceCentsPerUnit,
        p.trialDays,
        p.hasIabTcf,
        now
      )
      .run();
  }
}

// --- Pageview helpers ---
export async function incrementPageviewUsage(db, siteId, date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;
  const id = `pv_${siteId}_${yearMonth}`;
  const now = date.toISOString();

  await db
    .prepare(
      `INSERT OR IGNORE INTO PageviewUsage (id, siteId, yearMonth, pageviewCount, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, 0, ?4, ?4)`
    )
    .bind(id, siteId, yearMonth, now)
    .run();

  await db
    .prepare(
      `UPDATE PageviewUsage
       SET pageviewCount = pageviewCount + 1,
           updatedAt = ?2
       WHERE id = ?1`
    )
    .bind(id, now)
    .run();

  const row = await db
    .prepare(
      `SELECT pageviewCount FROM PageviewUsage WHERE id = ?1`
    )
    .bind(id)
    .first();

  return {
    siteId,
    yearMonth,
    pageviewCount: row?.pageviewCount ?? 0,
  };
}

/** Total pageview count for an organization for a given month (default current month). */
export async function getPageviewUsageForOrganization(db, organizationId, date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;
  const sitesRes = await db.prepare('SELECT id FROM Site WHERE organizationId = ?1').bind(organizationId).all();
  const siteIds = (sitesRes.results || []).map((r) => r.id).filter(Boolean);
  if (siteIds.length === 0) return { yearMonth, pageviewCount: 0, siteCount: 0 };
  const placeholders = siteIds.map(() => '?').join(',');
  const sumRes = await db
    .prepare(
      `SELECT COALESCE(SUM(pageviewCount), 0) AS total FROM PageviewUsage WHERE siteId IN (${placeholders}) AND yearMonth = ?`
    )
    .bind(...siteIds, yearMonth)
    .first();
  return {
    yearMonth,
    pageviewCount: Number(sumRes?.total ?? 0),
    siteCount: siteIds.length,
  };
}

/** Pageview count for a specific site for a given month (default current month). */
export async function getPageviewUsageForSite(db, siteId, date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;
  if (!siteId) return { yearMonth, pageviewCount: 0 };
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(pageviewCount), 0) AS total FROM PageviewUsage WHERE siteId = ?1 AND yearMonth = ?2`
    )
    .bind(siteId, yearMonth)
    .first();
  return {
    yearMonth,
    pageviewCount: Number(row?.total ?? 0),
  };
}

/** Get plan by id (free, basic, essential, growth). */
export async function getPlanById(db, planId) {
  if (!planId) return null;
  const row = await db.prepare('SELECT * FROM Plan WHERE id = ?1').bind(planId).first();
  return row || null;
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

  const planId = data.planId || null;
  await db
    .prepare(
      `INSERT INTO Subscription (id, organizationId, siteId, stripeSubscriptionId, stripeCustomerId, stripePriceId, planType, planId, interval, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, promoCodeId, amountCents, licenseKey, licenseKeys, quantity, cancelledLicenseKeys, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
       ON CONFLICT(id) DO UPDATE SET
         siteId = ?3, stripeSubscriptionId = ?4, stripeCustomerId = ?5, stripePriceId = ?6, planType = ?7, planId = ?8, status = ?10,
         currentPeriodStart = ?11, currentPeriodEnd = ?12, cancelAtPeriodEnd = ?13, licenseKey = ?16, licenseKeys = ?17, quantity = ?18, cancelledLicenseKeys = ?19, updatedAt = ?21`
    )
    .bind(
      id,
      data.organizationId,
      siteId,
      data.stripeSubscriptionId || null,
      data.stripeCustomerId || null,
      data.stripePriceId || null,
      data.planType || 'single',
      planId,
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
  if (!organizationId) return null;
  // Prefer active/trialing so a new purchase shows instead of an old canceled one
  const row = await db
    .prepare(
      `SELECT * FROM Subscription WHERE organizationId = ?1 AND (status = 'active' OR status = 'trialing') ORDER BY updatedAt DESC LIMIT 1`
    )
    .bind(organizationId)
    .first();
  if (row) return row;
  // Fallback: any subscription for org (e.g. canceled but still show history)
  const fallback = await db
    .prepare('SELECT * FROM Subscription WHERE organizationId = ?1 ORDER BY updatedAt DESC LIMIT 1')
    .bind(organizationId)
    .first();
  return fallback || null;
}

/**
 * Map Stripe recurring price id → tier (matches wrangler STRIPE_PRICE_* tier vars).
 * Used when Subscription.planId was not stored but stripePriceId is present.
 */
export function inferTierPlanIdFromStripePriceId(env, priceId) {
  if (!env || !priceId) return null;
  const id = String(priceId).trim();
  const eq = (k) => {
    const v = env[k];
    return v != null && String(v).trim() === id;
  };
  if (eq('STRIPE_PRICE_BASIC_MONTHLY') || eq('STRIPE_PRICE_BASIC_YEARLY')) return 'basic';
  if (eq('STRIPE_PRICE_ESSENTIAL_MONTHLY') || eq('STRIPE_PRICE_ESSENTIAL_YEARLY')) return 'essential';
  if (eq('STRIPE_PRICE_GROWTH_MONTHLY') || eq('STRIPE_PRICE_GROWTH_YEARLY')) return 'growth';
  return null;
}

/** Effective plan for an org: from active subscription or 'free'. Pass `env` so tier can be inferred from stripePriceId. */
export async function getEffectivePlanForOrganization(db, organizationId, env = null) {
  const sub = await getSubscriptionByOrganization(db, organizationId);
  let planId = sub ? (sub.planId ?? sub.planid ?? null) : null;
  if (planId) planId = String(planId).toLowerCase();
  if ((!planId || !['basic', 'essential', 'growth'].includes(planId)) && env && sub) {
    const pid = sub.stripePriceId ?? sub.stripepriceid ?? null;
    const inferred = inferTierPlanIdFromStripePriceId(env, pid);
    if (inferred) planId = inferred;
  }
  const effectivePlanId = planId && ['basic', 'essential', 'growth'].includes(planId) ? planId : 'free';
  const plan = await getPlanById(db, effectivePlanId);
  return { planId: effectivePlanId, plan, subscription: sub };
}

/** Scan count for an organization in a given month (default current). */
/** Increment scan counter for a site in the current month. Call after every successful scan. */
export async function incrementScanUsage(db, siteId, date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;
  const id = `${siteId}:${yearMonth}`;
  const now = new Date().toISOString();

  await db
    .prepare(`INSERT OR IGNORE INTO ScanUsage (id, siteId, yearMonth, scanCount, createdAt, updatedAt) VALUES (?1, ?2, ?3, 0, ?4, ?4)`)
    .bind(id, siteId, yearMonth, now)
    .run();

  await db
    .prepare(`UPDATE ScanUsage SET scanCount = scanCount + 1, updatedAt = ?2 WHERE id = ?1`)
    .bind(id, now)
    .run();

  const row = await db.prepare(`SELECT scanCount FROM ScanUsage WHERE id = ?1`).bind(id).first();
  return { yearMonth, scanCount: Number(row?.scanCount ?? 0) };
}

/** Total scan count for an organization for the current month — reads from ScanUsage counter table. */
export async function getScanUsageForOrganization(db, organizationId, date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;
  const sitesRes = await db.prepare('SELECT id FROM Site WHERE organizationId = ?1').bind(organizationId).all();
  const siteIds = (sitesRes.results || []).map((r) => r.id).filter(Boolean);
  if (siteIds.length === 0) return { yearMonth, scanCount: 0 };
  const placeholders = siteIds.map(() => '?').join(',');
  const sumRes = await db
    .prepare(`SELECT COALESCE(SUM(scanCount), 0) AS total FROM ScanUsage WHERE siteId IN (${placeholders}) AND yearMonth = ?`)
    .bind(...siteIds, yearMonth)
    .first();
  return { yearMonth, scanCount: Number(sumRes?.total ?? 0) };
}

/** Scan count for a specific site in the current month — reads from ScanUsage counter table. */
export async function getScanUsageForSite(db, siteId, date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yearMonth = `${year}-${month}`;
  if (!siteId) return { yearMonth, scanCount: 0 };
  const row = await db
    .prepare(`SELECT COALESCE(SUM(scanCount), 0) AS total FROM ScanUsage WHERE siteId = ?1 AND yearMonth = ?2`)
    .bind(siteId, yearMonth)
    .first();
  return { yearMonth, scanCount: Number(row?.total ?? 0) };
}

/** Number of sites for an organization. */
export async function getSitesCountByOrganization(db, organizationId) {
  const row = await db
    .prepare('SELECT COUNT(*) AS cnt FROM Site WHERE organizationId = ?1')
    .bind(organizationId)
    .first();
  return Number(row?.cnt ?? 0);
}

/** All subscriptions for an organization (for licenses tab). */
export async function getSubscriptionsByOrganization(db, organizationId) {
  const { results } = await db
    .prepare('SELECT * FROM Subscription WHERE organizationId = ?1 ORDER BY createdAt DESC')
    .bind(organizationId)
    .all();
  return results || [];
}

/** Active subscriptions that have a Stripe subscription ID (for metered usage reporting). */
export async function getActiveSubscriptionsForMeteredReporting(db) {
  const { results } = await db
    .prepare(
      `SELECT id, organizationId, stripeSubscriptionId
       FROM Subscription
       WHERE (status = 'active' OR status = 'trialing')
         AND stripeSubscriptionId IS NOT NULL AND stripeSubscriptionId != ''`
    )
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
      `SELECT * FROM Subscription WHERE siteId = ?1 AND status IN ('active', 'trialing') ORDER BY updatedAt DESC LIMIT 1`
    )
    .bind(siteId)
    .first();
  return row || null;
}

/** Batch version — fetches subscriptions for multiple sites in a single D1 query.
 *  Returns a map of siteId -> subscription row (most recent active/trialing per site). */
export async function getSubscriptionsBySiteIds(db, siteIds) {
  if (!siteIds || siteIds.length === 0) return {};
  const placeholders = siteIds.map((_, i) => `?${i + 1}`).join(', ');
  // Rely on status active/trialing only — avoid comparing ISO currentPeriodEnd to sqlite datetime('now')
  // (can mis-filter valid subscriptions and leave per-site planId stuck on "free" in dashboard-init).
  const { results } = await db
    .prepare(
      `SELECT * FROM Subscription WHERE siteId IN (${placeholders}) AND status IN ('active', 'trialing') ORDER BY updatedAt DESC`
    )
    .bind(...siteIds)
    .all();
  // First row per siteId wins (already sorted by updatedAt DESC)
  const map = {};
  for (const row of (results || [])) {
    const sid = String(row.siteId ?? row.siteid ?? '');
    if (sid && !map[sid]) map[sid] = row;
  }
  return map;
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

/**
 * Public Worker/CDN origin for embed `<script src>`. Prefer env so stored URLs do not depend
 * on whichever host hit the API (Next proxy vs worker vs localhost).
 */
export function canonicalEmbedOrigin(request, env) {
  const fromEnv = String(env?.CDN_BASE_URL || env?.API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  try {
    return new URL(request.url).origin;
  } catch (e) {
    return '';
  }
}

/**
 * Canonical install snippet URL, frozen at site creation (same string forever for that site).
 */
export function buildEmbedScriptUrl(origin, cdnScriptId) {
  const o = String(origin || '')
    .trim()
    .replace(/\/+$/, '');
  const id = String(cdnScriptId || '').trim();
  if (!o || !id) return null;
  return `${o}/consentbit/${id}/script.js`;
}

/**
 * Canonicalize a user-provided domain / websiteUrl into a stable unique key.
 * - strips protocol and path
 * - strips leading www.
 * - lowercases
 */
export function normalizeDomain(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let host = raw;
  try {
    // If user entered a bare domain, URL() throws; prepend scheme.
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    host = u.hostname || raw;
  } catch {
    host = raw;
  }
  host = host.replace(/^www\./i, '').toLowerCase();
  // drop any trailing dot
  host = host.replace(/\.+$/, '');
  return host;
}

// createSite: upsert by organizationId + domain
// IMPORTANT: cdnScriptId is permanent and never regenerated for existing sites
// This ensures the installation script code remains stable for each site
export async function createSite(
  db,
  { organizationId, name, domain, origin, bannerType, regionMode },
) {
  await ensureSchema(db);

  const canonicalDomain = normalizeDomain(domain);
  if (!canonicalDomain) {
    const e = new Error('domain is required');
    e.code = 'DOMAIN_REQUIRED';
    throw e;
  }

  // Domain is globally UNIQUE — check by domain first.
  const existing = await db
    .prepare('SELECT * FROM Site WHERE domain = ?1')
    .bind(canonicalDomain)
    .first();

  const now = new Date().toISOString();

  if (existing) {
    // If another org already owns this domain, surface a clear error.
    if (
      organizationId &&
      existing.organizationId &&
      String(existing.organizationId) !== String(organizationId)
    ) {
      const e = new Error('Domain already exists');
      e.code = 'DOMAIN_EXISTS';
      e.status = 409;
      throw e;
    }
    const backfillEmbed =
      existing.embedScriptUrl ||
      buildEmbedScriptUrl(origin, existing.cdnScriptId);
    // Update only banner settings - preserve permanent cdnScriptId and apiKey; freeze embed URL once set
    await db
      .prepare(
        `UPDATE Site
         SET name = ?1,
             banner_type = ?2,
             region_mode = ?3,
             updatedAt = ?4,
             embedScriptUrl = COALESCE(embedScriptUrl, ?5)
         WHERE id = ?6`,
      )
      .bind(name, bannerType, regionMode, now, backfillEmbed, existing.id)
      .run();

    return {
      ...existing,
      name,
      banner_type: bannerType,
      region_mode: regionMode,
      updatedAt: now,
      embedScriptUrl: existing.embedScriptUrl || backfillEmbed,
      // cdnScriptId and apiKey are preserved from existing record
    };
  }

  const id = crypto.randomUUID();
  const cdnScriptId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const embedScriptUrl = buildEmbedScriptUrl(origin, cdnScriptId);

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
         embedScriptUrl,
         createdAt,
         updatedAt
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      id,
      organizationId,
      name,
      canonicalDomain,
      cdnScriptId,
      apiKey,
      bannerType,
      regionMode,
      embedScriptUrl,
      now,
      now,
    )
    .run();

  return {
    id,
    organizationId,
    name,
    domain: canonicalDomain,
    cdnScriptId,
    apiKey,
    banner_type: bannerType,
    region_mode: regionMode,
    embedScriptUrl,
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

export async function createUser(db, { email, name, passwordHash = 'passwordless' }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Insert into both camelCase and snake_case password columns for compatibility
  try {
    await db
      .prepare(
        `INSERT INTO User (id, email, name, passwordHash, password_hash, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5)`
      )
      .bind(
        id,
        email.trim().toLowerCase(),
        (name || '').trim() || null,
        passwordHash,
        now
      )
      .run();
  } catch (e) {
    // Fallback for environments where password_hash column does not exist
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
  }

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
          verified_at = datetime('now')
      WHERE id = ?1
    `,
    )
    .bind(siteId)
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

export async function deleteSessionById(db, id) {
  if (!id) return { deleted: false };
  await db.prepare(`DELETE FROM Session WHERE id = ?1`).bind(id).run();
  return { deleted: true };
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

/**
 * New app convention: one Organization per user.
 * Creates the org on-demand (no explicit user prompt) and ensures membership exists.
 */
export async function getOrCreateOrganizationForUser(
  db,
  { userId, organizationName } = {},
) {
  await ensureSchema(db);
  if (!userId) return null;

  const existing = await db
    .prepare('SELECT * FROM Organization WHERE ownerUserId = ?1 ORDER BY createdAt ASC LIMIT 1')
    .bind(userId)
    .first();

  if (existing?.id) {
    // Make sure owner membership exists (idempotent).
    await addOrganizationMember(db, { organizationId: existing.id, userId, role: 'owner' });
    return existing;
  }

  const name = (organizationName || '').trim() || 'My Organization';
  const org = await createOrganization(db, { ownerUserId: userId, name });
  await addOrganizationMember(db, { organizationId: org.id, userId, role: 'owner' });
  return org;
}

export async function getOrganizationsForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT o.*
       FROM Organization o
       JOIN OrganizationMember m ON m.organizationId = o.id
       WHERE m.userId = ?1
       ORDER BY o.createdAt ASC`,
    )
    .bind(userId)
    .all();
  return results || [];
}

export async function getOrganizationMember(db, userId, organizationId) {
  if (!userId || !organizationId) return null;
  const row = await db
    .prepare('SELECT * FROM OrganizationMember WHERE userId = ?1 AND organizationId = ?2')
    .bind(userId, organizationId)
    .first();
  return row || null;
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
  const domain = cookie?.domain ? String(cookie.domain).trim() : '';
  const path = (v(cookie?.path) || '/');
  const category = (v(cookie?.category) || 'uncategorized'); // NOT NULL
  const provider = v(cookie?.provider);
  const description = v(cookie?.description);
  const expires = v(cookie?.expires);
  const httpOnly = cookie?.httpOnly ? 1 : 0;
  const secure = cookie?.secure ? 1 : 0;
  const sameSite = v(cookie?.sameSite);
  const isExpected = cookie?.isExpected ? 1 : 0;
  const source = v(cookie?.source);
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
    { i: 14, key: 'isExpected', val: isExpected },
    { i: 15, key: 'source', val: source },
    { i: 16, key: 'firstSeenAt', val: ts },
    { i: 17, key: 'lastSeenAt', val: ts },
  ];
  for (const { key, val } of bindValues) {
    if (val === undefined) {
      console.error('[db] upsertCookie undefined bind:', key, 'full cookie:', JSON.stringify(cookie));
    }
  }

  const cookieId = bindValues[0].val;
  try {
    await db
      .prepare(
        `INSERT INTO Cookie (id, siteId, scanHistoryId, name, domain, path, category, provider, description, expires, httpOnly, secure, sameSite, isExpected, source, firstSeenAt, lastSeenAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(siteId, name, domain) DO UPDATE SET
           lastSeenAt = excluded.lastSeenAt,
           scanHistoryId = excluded.scanHistoryId,
           source = excluded.source,
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
        isExpected,
        source,
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
 * Insert or update multiple cookies using D1 batch for maximum speed.
 */
export async function upsertCookies(db, { siteId, scanHistoryId, cookies }) {
  await ensureSchema(db);
  if (!cookies || cookies.length === 0) return [];

  const now = new Date().toISOString();
  const v = (x) => (x === undefined ? null : x);

  const statements = cookies.map((cookie) => {
    const name = v(cookie?.name) ?? '';
    const domain = cookie?.domain ? String(cookie.domain).trim() : '';
    const path = v(cookie?.path) || '/';
    const category = v(cookie?.category) || 'uncategorized';
    const provider = v(cookie?.provider);
    const description = v(cookie?.description);
    const expires = v(cookie?.expires);
    const httpOnly = cookie?.httpOnly ? 1 : 0;
    const secure = cookie?.secure ? 1 : 0;
    const sameSite = v(cookie?.sameSite);
    const isExpected = cookie?.isExpected ? 1 : 0;
    const source = v(cookie?.source);
    const cookieId = crypto.randomUUID();

    return db
      .prepare(
        `INSERT INTO Cookie (id, siteId, scanHistoryId, name, domain, path, category, provider, description, expires, httpOnly, secure, sameSite, isExpected, source, firstSeenAt, lastSeenAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(siteId, name, domain) DO UPDATE SET
           lastSeenAt = excluded.lastSeenAt,
           scanHistoryId = excluded.scanHistoryId,
           source = excluded.source,
           category = excluded.category,
           provider = excluded.provider,
           isExpected = excluded.isExpected,
           description = CASE
             WHEN excluded.description IS NOT NULL THEN excluded.description
             ELSE Cookie.description
           END`,
      )
      .bind(cookieId, siteId, scanHistoryId, name, domain, path, category, provider, description, expires, httpOnly, secure, sameSite, isExpected, source, now, now);
  });

  try {
    await db.batch(statements);
    return cookies.map(() => ({ success: true }));
  } catch (err) {
    console.error('[db] upsertCookies batch failed:', err);
    return cookies.map(() => ({ success: false, error: err.message }));
  }
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
        customization.preferencePosition || 'center',
        customization.centerAnimationDirection || 'fade',
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
