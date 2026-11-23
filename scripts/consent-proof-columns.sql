-- Consent proof (gaps D + E, docs/minimum-legal-requirements.md) — run by hand BEFORE
-- deploying the test worker with LAW_FIXES="1". The test and production workers share
-- consent-webapp-eu; everything here is additive (new table, new nullable columns).
--
-- STEP 1 — see which proof columns Consent already has:
--   npx wrangler d1 execute consent-webapp-eu --remote --command "SELECT name FROM pragma_table_info('Consent') WHERE name IN ('law','law_resolved','consent_language','consent_model','notice_version','policy_version','lang_wanted')"
--
-- STEP 2 — run this file:
--   npx wrangler d1 execute consent-webapp-eu --remote --file scripts/consent-proof-columns.sql
--   SQLite has no "ADD COLUMN IF NOT EXISTS": delete the ALTER line of any column that
--   STEP 1 listed, or the file stops at it with "duplicate column name".
--
-- Without these columns consent.js still saves every consent, just without the law and
-- notice fields (it drops them; see insertConsentRow) — so nothing breaks, it just isn't proof.

-- Which law applied, and what the visitor was shown (written by handlers/consent.js).
ALTER TABLE Consent ADD COLUMN law TEXT;
ALTER TABLE Consent ADD COLUMN law_resolved INTEGER DEFAULT 0;
ALTER TABLE Consent ADD COLUMN consent_language TEXT;
ALTER TABLE Consent ADD COLUMN consent_model TEXT;
ALTER TABLE Consent ADD COLUMN notice_version TEXT;
ALTER TABLE Consent ADD COLUMN policy_version TEXT;
ALTER TABLE Consent ADD COLUMN lang_wanted TEXT;

-- The full text behind each notice_version / policy_version (utils/noticeVersion.js).
-- One row per distinct version per site; content is the exact JSON / URL that was served.
CREATE TABLE IF NOT EXISTS NoticeVersion (
  siteId     TEXT NOT NULL,
  id         TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- 'notice' | 'policy'
  bannerType TEXT,
  language   TEXT,
  content    TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  PRIMARY KEY (siteId, id)
);
