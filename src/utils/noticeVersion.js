// utils/noticeVersion.js — proof of WHAT a visitor was shown (gap D,
// docs/minimum-legal-requirements.md). TEST-ONLY: only called when LAW_FIXES="1".
//
// cdnM.js fingerprints the banner text + privacy-policy link it serves and sends the
// fingerprints to the banner, which returns them on the consent POST (Consent.notice_version /
// Consent.policy_version). Each distinct version's full text is stored once here, so a
// fingerprint can always be turned back into the words the visitor saw.
//
// NoticeVersion is created by hand (scripts/consent-proof-columns.sql), like every
// other table added since the SchemaVersion stamp. If it is missing, recording is
// skipped and the banner is served exactly as before.

/** First 16 hex chars of SHA-256 — fits Consent.notice_version (≤ 64, consentLimits.js). */
export async function shortHash(text) {
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Per-isolate memory of versions already stored, so a busy site costs one INSERT per
// version per isolate rather than one per script request.
const _stored = new Set();
let _tableMissing = false;

/**
 * Store each version once. Never throws — a failure here must not cost the banner.
 * @param {D1Database} db
 * @param {string} siteId
 * @param {{id:string, kind:'notice'|'policy', bannerType:?string, language:?string, content:string}[]} versions
 */
export async function recordNoticeVersions(db, siteId, versions) {
  if (!db || !siteId || _tableMissing) return;
  for (const v of versions) {
    const key = `${siteId}:${v.id}`;
    if (!v.id || _stored.has(key)) continue;
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO NoticeVersion (siteId, id, kind, bannerType, language, content, createdAt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(siteId, v.id, v.kind, v.bannerType ?? null, v.language ?? null, v.content, new Date().toISOString())
        .run();
      _stored.add(key);
    } catch (e) {
      if (/no such table/i.test(e?.message || '')) {
        _tableMissing = true;
        console.warn('[NoticeVersion] table missing — run scripts/consent-proof-columns.sql; skipping');
        return;
      }
      console.warn('[NoticeVersion] store failed:', e?.message);
    }
  }
}
