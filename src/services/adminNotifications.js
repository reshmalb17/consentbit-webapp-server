// src/services/adminNotifications.js
//
// Operator-facing notifications surfaced in the standalone Admin Dashboard.
//
// Unlike AdminDashboardAuditLog (which records what an OPERATOR did), this table
// records things that happened TO the business and need a human to look at them.
//
// Types raised today, all filterable by prefix:
//   refund.full / refund.partial      Stripe refund; a full one cancels the sub
//   subscription.cancelled            a paying site stopped being served
//   subscription.unpaid               Stripe gave up retrying payment
//   limit.scans / limit.pageviews     a site hit its monthly plan allowance
//
//   Table AdminNotification:
//     id · type · severity · title · message · siteId · domain · organizationId ·
//     userEmail · subscriptionId · stripeSubscriptionId · stripeCustomerId ·
//     stripeChargeId · stripeRefundId · amountCents · currency · detail (JSON) ·
//     dedupeKey (UNIQUE) · readAt · readBy · createdAt
//
// dedupeKey is what makes this safe to call from a Stripe webhook: Stripe re-delivers
// every event until we 2xx, and a refund can arrive as both `charge.refunded` and
// `refund.updated`. Keying on the Stripe refund id means the same refund produces
// exactly one row no matter how many times it is delivered.
//
// Writes are best-effort — a notification must never take down the payment path it
// is describing.

let ensured = false;

export async function ensureNotificationTable(db) {
  if (ensured || !db) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS AdminNotification (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning',
        title TEXT NOT NULL,
        message TEXT,
        siteId TEXT,
        domain TEXT,
        organizationId TEXT,
        userEmail TEXT,
        subscriptionId TEXT,
        stripeSubscriptionId TEXT,
        stripeCustomerId TEXT,
        stripeChargeId TEXT,
        stripeRefundId TEXT,
        amountCents INTEGER,
        currency TEXT,
        detail TEXT,
        dedupeKey TEXT UNIQUE,
        readAt DATETIME,
        readBy TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_admin_notif_createdAt ON AdminNotification (createdAt DESC)`)
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_admin_notif_readAt ON AdminNotification (readAt)`)
    .run();
  ensured = true;
}

/**
 * Record one notification. Returns the row id, or null when it was a duplicate
 * (same dedupeKey) or the write failed.
 *
 * @param {D1Database} db
 * @param {object} n
 * @param {string} n.type       e.g. 'refund.full', 'refund.partial'
 * @param {string} n.title      one-line summary shown in the list
 * @param {string} [n.severity] 'critical' | 'warning' | 'info'
 * @param {string} [n.message]  longer explanation
 * @param {string} [n.dedupeKey]
 */
export async function createAdminNotification(db, n) {
  if (!db || !n?.type || !n?.title) return null;
  try {
    await ensureNotificationTable(db);
    const id = `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO AdminNotification
           (id, type, severity, title, message, siteId, domain, organizationId, userEmail,
            subscriptionId, stripeSubscriptionId, stripeCustomerId, stripeChargeId, stripeRefundId,
            amountCents, currency, detail, dedupeKey, createdAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
      )
      .bind(
        id,
        n.type,
        n.severity || 'warning',
        n.title,
        n.message || null,
        n.siteId || null,
        n.domain || null,
        n.organizationId || null,
        n.userEmail || null,
        n.subscriptionId || null,
        n.stripeSubscriptionId || null,
        n.stripeCustomerId || null,
        n.stripeChargeId || null,
        n.stripeRefundId || null,
        n.amountCents ?? null,
        n.currency ? String(n.currency).toUpperCase() : null,
        n.detail ? JSON.stringify(n.detail).slice(0, 4000) : null,
        n.dedupeKey || null,
        new Date().toISOString()
      )
      .run();
    // INSERT OR IGNORE reports 0 changes when the dedupeKey already existed.
    const changed = res?.meta?.changes ?? res?.changes ?? 1;
    return changed ? id : null;
  } catch (err) {
    console.error('[adminNotifications] write failed', err?.message || err);
    return null;
  }
}

/**
 * Read notifications, newest first.
 * Filters: type (prefix, so 'refund' matches 'refund.full' and 'refund.partial'),
 * status ('unread' | 'read' | 'all'), search (title/message/domain/email), date range.
 */
export async function listAdminNotifications(db, { type, status, search, from, to, limit } = {}) {
  await ensureNotificationTable(db);

  const where = [];
  const binds = [];
  if (type && type !== 'all') {
    where.push('type LIKE ?');
    binds.push(`${type}%`);
  }
  if (status === 'unread') where.push('readAt IS NULL');
  else if (status === 'read') where.push('readAt IS NOT NULL');
  if (search) {
    where.push(
      '(title LIKE ? OR message LIKE ? OR domain LIKE ? OR userEmail LIKE ? OR stripeSubscriptionId LIKE ? OR stripeChargeId LIKE ?)'
    );
    const like = `%${search}%`;
    binds.push(like, like, like, like, like, like);
  }
  if (from) {
    where.push('createdAt >= ?');
    binds.push(from.length <= 10 ? `${from}T00:00:00.000Z` : from);
  }
  if (to) {
    where.push('createdAt <= ?');
    binds.push(to.length <= 10 ? `${to}T23:59:59.999Z` : to);
  }

  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const sql =
    `SELECT * FROM AdminNotification` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY createdAt DESC, rowid DESC LIMIT ${cap}`;

  const { results = [] } = await db.prepare(sql).bind(...binds).all();
  return results.map((r) => ({ ...r, detail: r.detail ? safeParse(r.detail) : null }));
}

/** Counts for the sidebar badge and the page header. */
export async function getNotificationStats(db) {
  await ensureNotificationTable(db);
  const row = await db
    .prepare(
      `SELECT
         COUNT(*)                                                          AS total,
         SUM(CASE WHEN readAt IS NULL THEN 1 ELSE 0 END)                   AS unread,
         SUM(CASE WHEN type LIKE 'refund%' THEN 1 ELSE 0 END)              AS refunds,
         SUM(CASE WHEN type LIKE 'refund%' AND readAt IS NULL THEN 1 ELSE 0 END) AS refundsUnread,
         SUM(CASE WHEN type LIKE 'refund%' THEN COALESCE(amountCents, 0) ELSE 0 END) AS refundedCents,
         SUM(CASE WHEN type LIKE 'subscription%' THEN 1 ELSE 0 END)        AS cancellations,
         SUM(CASE WHEN type LIKE 'subscription%' AND readAt IS NULL THEN 1 ELSE 0 END) AS cancellationsUnread,
         -- What those cancelled subscriptions were billing per period. Recurring
         -- revenue lost, as opposed to refundedCents which is money paid back.
         SUM(CASE WHEN type LIKE 'subscription%' THEN COALESCE(amountCents, 0) ELSE 0 END) AS cancelledCents,
         SUM(CASE WHEN type LIKE 'limit%' THEN 1 ELSE 0 END)               AS limits,
         SUM(CASE WHEN type LIKE 'limit%' AND readAt IS NULL THEN 1 ELSE 0 END) AS limitsUnread
       FROM AdminNotification`
    )
    .first();
  return {
    total: row?.total ?? 0,
    unread: row?.unread ?? 0,
    refunds: row?.refunds ?? 0,
    refundsUnread: row?.refundsUnread ?? 0,
    refundedCents: row?.refundedCents ?? 0,
    cancellations: row?.cancellations ?? 0,
    cancellationsUnread: row?.cancellationsUnread ?? 0,
    cancelledCents: row?.cancelledCents ?? 0,
    limits: row?.limits ?? 0,
    limitsUnread: row?.limitsUnread ?? 0,
  };
}

/**
 * Mark notifications read (or unread again). Pass ids, or all:true for everything
 * currently unread. Returns how many rows changed.
 */
export async function markNotificationsRead(db, { ids, all, read = true, by } = {}) {
  await ensureNotificationTable(db);
  const now = new Date().toISOString();

  if (all) {
    const res = read
      ? await db
          .prepare(`UPDATE AdminNotification SET readAt = ?1, readBy = ?2 WHERE readAt IS NULL`)
          .bind(now, by || null)
          .run()
      : await db
          .prepare(`UPDATE AdminNotification SET readAt = NULL, readBy = NULL WHERE readAt IS NOT NULL`)
          .run();
    return res?.meta?.changes ?? 0;
  }

  const list = (Array.isArray(ids) ? ids : []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return 0;
  const placeholders = list.map((_, i) => `?${i + 1}`).join(', ');
  const res = read
    ? await db
        .prepare(
          `UPDATE AdminNotification SET readAt = ?${list.length + 1}, readBy = ?${list.length + 2}
             WHERE id IN (${placeholders})`
        )
        .bind(...list, now, by || null)
        .run()
    : await db
        .prepare(`UPDATE AdminNotification SET readAt = NULL, readBy = NULL WHERE id IN (${placeholders})`)
        .bind(...list)
        .run();
  return res?.meta?.changes ?? 0;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return s;
  }
}
