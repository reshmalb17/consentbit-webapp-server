// src/handlers/adminDashboard/audit.js
//
// Append-only activity log for the Admin Dashboard. Every operation an operator
// performs — signing in, managing accounts, editing or deleting users and sites —
// lands here with who did it, what they touched, and the outcome.
//
//   Table AdminDashboardAuditLog:
//     id · actor · actorRole · action · target · detail (JSON) · outcome · ip ·
//     userAgent · createdAt
//
// Writes are best-effort: logging must never take down the operation it records.

let ensured = false;

export async function ensureAuditTable(db) {
  if (ensured) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS AdminDashboardAuditLog (
        id TEXT PRIMARY KEY,
        actor TEXT,
        actorRole TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        outcome TEXT NOT NULL DEFAULT 'ok',
        ip TEXT,
        userAgent TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_admin_audit_createdAt
         ON AdminDashboardAuditLog (createdAt DESC)`
    )
    .run();
  ensured = true;
}

/**
 * Record one operation.
 *
 * @param {D1Database} db
 * @param {Request} request              used for IP + user agent
 * @param {object}   entry
 * @param {string}   entry.action        e.g. 'login', 'user.delete', 'account.invite'
 * @param {string}  [entry.actor]        username of the operator ('-' when anonymous)
 * @param {string}  [entry.actorRole]
 * @param {string}  [entry.target]       what was acted on (email, site id, username)
 * @param {object}  [entry.detail]       any extra context, stored as JSON
 * @param {string}  [entry.outcome]      'ok' | 'denied' | 'failed'
 */
export async function logAudit(db, request, entry) {
  if (!db || !entry?.action) return;
  try {
    await ensureAuditTable(db);
    await db
      .prepare(
        `INSERT INTO AdminDashboardAuditLog
           (id, actor, actorRole, action, target, detail, outcome, ip, userAgent, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .bind(
        crypto.randomUUID(),
        entry.actor || '-',
        entry.actorRole || null,
        entry.action,
        entry.target || null,
        entry.detail ? JSON.stringify(entry.detail).slice(0, 4000) : null,
        entry.outcome || 'ok',
        request?.headers?.get('CF-Connecting-IP') || null,
        (request?.headers?.get('User-Agent') || '').slice(0, 300) || null
      )
      .run();
  } catch (err) {
    // Never let logging break the operation it is describing.
    console.error('[adminAudit] write failed', err?.message || err);
  }
}

/**
 * Read the log, newest first.
 * Filters: actor (exact), action (prefix, so 'user.' matches every user action),
 * search (across target/detail), and a row limit.
 */
export async function listAudit(db, { actor, action, search, limit } = {}) {
  await ensureAuditTable(db);

  const where = [];
  const binds = [];
  if (actor && actor !== 'all') {
    where.push('actor = ?');
    binds.push(actor);
  }
  if (action && action !== 'all') {
    where.push('action LIKE ?');
    binds.push(`${action}%`);
  }
  if (search) {
    where.push('(target LIKE ? OR detail LIKE ? OR action LIKE ?)');
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const sql =
    `SELECT id, actor, actorRole, action, target, detail, outcome, ip, userAgent, createdAt
       FROM AdminDashboardAuditLog` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY createdAt DESC, rowid DESC LIMIT ${cap}`;

  const { results = [] } = await db.prepare(sql).bind(...binds).all();
  return results.map((r) => ({
    ...r,
    detail: r.detail ? safeParse(r.detail) : null,
  }));
}

/** Distinct actors, for the filter dropdown. */
export async function listAuditActors(db) {
  await ensureAuditTable(db);
  const { results = [] } = await db
    .prepare(`SELECT DISTINCT actor FROM AdminDashboardAuditLog ORDER BY actor`)
    .all();
  return results.map((r) => r.actor).filter(Boolean);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return s;
  }
}
