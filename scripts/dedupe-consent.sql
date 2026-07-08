-- Remove duplicate Consent rows created by the client posting the same consent
-- twice within the same second (overlapping/double-bound handlers). Keeps the
-- earliest row (lowest rowid) of each duplicate group; distinct real events are
-- preserved because status / bannerType / consent_categories / second-level
-- createdAt are all part of the group key.
--
-- Grouping key mirrors the plugin display de-dupe:
--   siteId, deviceId, status, bannerType, consent_categories, createdAt (to the second)
--
-- USAGE (run the preview first, eyeball the count, THEN the delete):
--   wrangler d1 execute consent-webapp --remote --command "<preview query>"
--   wrangler d1 execute consent-webapp --remote --file scripts/dedupe-consent.sql
--
-- The Consent table is a normal (rowid) table — id TEXT PRIMARY KEY, not WITHOUT ROWID —
-- so rowid is available as a stable tie-breaker.

-- ── PREVIEW: how many rows the delete below would remove ──────────────────────
-- SELECT COUNT(*) AS duplicates_to_delete
-- FROM Consent
-- WHERE rowid NOT IN (
--   SELECT MIN(rowid) FROM Consent
--   GROUP BY siteId,
--            COALESCE(deviceId, ''),
--            status,
--            COALESCE(bannerType, ''),
--            COALESCE(consent_categories, ''),
--            substr(createdAt, 1, 19)
-- );

-- ── DELETE: collapse each duplicate group to its earliest row ─────────────────
DELETE FROM Consent
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM Consent
  GROUP BY siteId,
           COALESCE(deviceId, ''),
           status,
           COALESCE(bannerType, ''),
           COALESCE(consent_categories, ''),
           substr(createdAt, 1, 19)
);
