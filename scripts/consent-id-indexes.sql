-- Consent ID (gap C, docs/minimum-legal-requirements.md) — run ONCE, by hand, BEFORE
-- deploying the test worker with LAW_FIXES="1".
--
--   npx wrangler d1 execute consent-webapp-eu --remote --file scripts/consent-id-indexes.sql
--
-- NOTE: the test worker and production share this database (consent-webapp-eu). Indexes
-- are additive: no rows change, no queries change, nothing is deleted.
--
-- 1. Duplicate-save check in handlers/consent.js (siteId + recent createdAt) and the
--    consent-retention purge. Without it every consent POST from a test site scans Consent.
CREATE INDEX IF NOT EXISTS idx_consent_site_created ON Consent (siteId, createdAt);

-- 2. "Find visitor" in the dashboard: /api/consent-logs?deviceId=… (siteId + deviceId).
CREATE INDEX IF NOT EXISTS idx_consent_site_device ON Consent (siteId, deviceId);
