-- NoticeVersion table only (the rest of consent-proof-columns.sql is already applied:
-- its Consent ALTERs fail with "duplicate column" on the live DB).
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
