-- consentbit-retention-data — where expired consent records go instead of being deleted.
-- Run ONCE, by hand, before switching CONSENT_RETENTION_MODE to "on":
--
--   npx wrangler d1 execute consentbit-retention-data --remote --file scripts/retention-db-schema.sql
--
-- Separate database from consent-webapp-eu: nothing in the dashboard, CSV, PDF or API
-- reads it, so to the customer these records are gone. Only the visitor export/erasure
-- endpoint (handlers/consentVisitor.js) touches it, so an erasure request still reaches them.

-- One row per site that has had records moved. siteJson = the Site row at the time of the
-- last move (apiKey removed).
CREATE TABLE IF NOT EXISTS RetainedSite (
  siteId TEXT PRIMARY KEY,
  domain TEXT,
  organizationId TEXT,
  siteJson TEXT,
  firstRetainedAt TEXT NOT NULL,
  lastRetainedAt TEXT NOT NULL,
  retainedCount INTEGER NOT NULL DEFAULT 0
);

-- One row per moved Consent row. consentRow = the full original row as JSON, so the
-- Consent table can gain columns without this schema changing.
CREATE TABLE IF NOT EXISTS RetainedConsent (
  id TEXT PRIMARY KEY,
  siteId TEXT NOT NULL,
  deviceId TEXT,
  regulation TEXT,
  createdAt TEXT,
  retainedAt TEXT NOT NULL,
  consentRow TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retained_site_created ON RetainedConsent (siteId, createdAt);
CREATE INDEX IF NOT EXISTS idx_retained_site_device ON RetainedConsent (siteId, deviceId);

-- Legacy consent records (services/legacyRetention.js) moved out of the pre-D1 stores:
--   source 'kv-webflow'  WEBFLOW_AUTHENTICATION  Cookie-Preferences:{domain}:{visitorId}
--   source 'kv-framer'   CONSENT_STORE_FRAMER    consent:{platformSiteId} (array)
--   source 'r2-v2'       R2 cookies-data         consent-v2/{site}/{visitorId}.json
-- storeKey = the KV/R2 key it came from; entryJson = the original entry.
CREATE TABLE IF NOT EXISTS RetainedLegacyConsent (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  storeKey TEXT NOT NULL,
  siteKey TEXT,
  visitorId TEXT,
  regulation TEXT,
  createdAt TEXT,
  retainedAt TEXT NOT NULL,
  entryJson TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retained_legacy_site ON RetainedLegacyConsent (siteKey, visitorId);

-- Per-source cursor so a pass over a store resumes across cron ticks (and days).
CREATE TABLE IF NOT EXISTS LegacyRetentionState (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  lastPassDoneDate TEXT,
  updatedAt TEXT
);

-- One line per tick per source that moved (or, dry-run, would move) something.
CREATE TABLE IF NOT EXISTS LegacyRetentionLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  runAt TEXT NOT NULL,
  mode TEXT NOT NULL,
  affectedCount INTEGER NOT NULL
);
