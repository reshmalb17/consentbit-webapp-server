// src/handlers/adminDashboard/accounts.js
//
// DB-backed login accounts for the Admin Dashboard.
// The AdminDashboardAccount table is the SINGLE source of truth — nothing is
// read from wrangler.toml / env.
//
//   Table AdminDashboardAccount:
//     username (PK)  the operator's email address; also their login id
//     role           'admin' | 'viewer'
//     secretHash     salted PBKDF2 digest — NEVER the key itself
//     status         'invited' (emailed, no key yet) | 'active'
//     invitedBy      who sent the invite
//     tokenHash      SHA-256 of the current invite / reset link token
//     tokenPurpose   'invite' | 'reset'
//     tokenExpiresAt when that link stops working
//     createdAt / updatedAt / lastLoginAt
//
// Rules the handlers enforce on top of this module:
//   - admin  : invites new viewers by email, renames accounts, removes viewers.
//   - viewer : changes only its own key.
//   - nobody, including an admin, can read or set another account's key. Keys are
//     set by the account holder through an emailed link, or changed by supplying
//     the current key.
//
// Migration: the first run creates the table and carries over the older
// role-keyed AdminDashboardCredential / plaintext-secret rows, hashing whatever
// key they had so existing logins keep working, and blanking the plaintext.

import { hashSecret, verifySecret, isHashed, createToken, sha256Hex } from './crypto.js';

const SEED = {
  admin: 'snm-admin-_R24Azbzk4I0r6nqC8H3IFc_005az3TX',
  viewer: 'snm-123',
};

export const USERNAME_RULE = 'Username must be a valid email address.';
export const SECRET_RULE = 'Password must be at least 8 characters.';

/** Link lifetimes. Invites get longer than resets — someone has to be onboarded. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/** New accounts must be email addresses; legacy names stay valid for sign-in only. */
export function isValidUsername(name) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(name) && name.length <= 254;
}

export async function ensureAccountTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS AdminDashboardAccount (
        username TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        secret TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();

  // Columns added after the table first shipped. ALTER is per-column and throws
  // when it already exists, so each one is attempted independently.
  for (const ddl of [
    `ALTER TABLE AdminDashboardAccount ADD COLUMN email TEXT`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN secretHash TEXT`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN invitedBy TEXT`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN tokenHash TEXT`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN tokenPurpose TEXT`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN tokenExpiresAt DATETIME`,
    `ALTER TABLE AdminDashboardAccount ADD COLUMN lastLoginAt DATETIME`,
  ]) {
    try {
      await db.prepare(ddl).run();
    } catch (_) {
      /* column already present */
    }
  }

  const countRow = await db.prepare(`SELECT COUNT(*) AS c FROM AdminDashboardAccount`).first();
  if ((Number(countRow?.c) || 0) === 0) {
    let migrated = [];
    try {
      const { results = [] } = await db
        .prepare(`SELECT role, secret FROM AdminDashboardCredential`)
        .all();
      migrated = results.filter((r) => r?.role && r?.secret);
    } catch (_) {
      /* table never existed — seed instead */
    }

    const rows = migrated.length
      ? migrated.map((r) => ({ username: String(r.role), role: String(r.role), secret: r.secret }))
      : [
          { username: 'admin', role: 'admin', secret: SEED.admin },
          { username: 'viewer', role: 'viewer', secret: SEED.viewer },
        ];

    for (const row of rows) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO AdminDashboardAccount
             (username, role, secretHash, status, createdAt, updatedAt)
           VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
        .bind(row.username, row.role === 'admin' ? 'admin' : 'viewer', await hashSecret(row.secret))
        .run();
    }
  }

  // Accounts created as an email address are their own contact address; older
  // name-style logins ('admin') keep a NULL email until one is set explicitly.
  try {
    await db
      .prepare(
        `UPDATE AdminDashboardAccount
            SET email = username
          WHERE (email IS NULL OR email = '') AND username LIKE '%_@_%._%'`
      )
      .run();
  } catch (_) {
    /* best effort */
  }

  await upgradePlaintextSecrets(db);
}

/**
 * The address invite / reset mail goes to: the explicit email column, falling
 * back to the username when that is itself an address. Null means the account
 * has no reachable address and cannot use emailed links.
 */
export function contactEmail(row) {
  const explicit = normalizeUsername(row?.email);
  if (explicit && isValidUsername(explicit)) return explicit;
  const name = normalizeUsername(row?.username);
  return isValidUsername(name) ? name : null;
}

/**
 * One-time sweep: any row still holding a readable key gets it hashed into
 * secretHash and the plaintext column blanked. Existing keys keep working.
 */
async function upgradePlaintextSecrets(db) {
  let rows = [];
  try {
    const { results = [] } = await db
      .prepare(
        `SELECT username, secret FROM AdminDashboardAccount
          WHERE secret IS NOT NULL AND secret != ''`
      )
      .all();
    rows = results;
  } catch (_) {
    return; // no legacy column
  }

  for (const row of rows) {
    const hash = isHashed(row.secret) ? row.secret : await hashSecret(row.secret);
    try {
      // Blanked to '' rather than NULL: the live table was created with
      // `secret TEXT NOT NULL`, and CREATE TABLE IF NOT EXISTS above never
      // relaxes an existing column, so NULL trips the constraint. '' also
      // falls outside this sweep's WHERE, so each row is upgraded once.
      await db
        .prepare(
          `UPDATE AdminDashboardAccount
              SET secretHash = COALESCE(secretHash, ?), secret = ''
            WHERE username = ?`
        )
        .bind(hash, row.username)
        .run();
    } catch (err) {
      // A maintenance sweep must not take down every admin request.
      console.error('[adminAccounts] secret upgrade failed for', row.username, err?.message);
    }
  }
}

async function findAccount(db, username) {
  await ensureAccountTable(db);
  return await db
    .prepare(
      `SELECT username, email, role, secretHash, status, invitedBy, tokenHash, tokenPurpose,
              tokenExpiresAt, createdAt, updatedAt, lastLoginAt
         FROM AdminDashboardAccount WHERE username = ?`
    )
    .bind(username)
    .first();
}

/**
 * Validate a username + key pair. Returns { username, role } or null.
 * Accounts still awaiting invite acceptance cannot sign in.
 */
export async function resolveAccount(db, username, secret) {
  const name = normalizeUsername(username);
  if (!name || !secret) return null;
  const row = await findAccount(db, name);
  if (!row || row.status === 'invited' || !row.secretHash) return null;
  if (!(await verifySecret(row.secretHash, String(secret)))) return null;
  return { username: row.username, role: row.role === 'admin' ? 'admin' : 'viewer' };
}

/** Stamp a successful sign-in. */
export async function touchLogin(db, username) {
  try {
    await db
      .prepare(`UPDATE AdminDashboardAccount SET lastLoginAt = CURRENT_TIMESTAMP WHERE username = ?`)
      .bind(normalizeUsername(username))
      .run();
  } catch (_) {
    /* non-critical */
  }
}

/** Every account — never any key material. */
export async function listAccounts(db) {
  await ensureAccountTable(db);
  const { results = [] } = await db
    .prepare(
      `SELECT username, email, role, status, invitedBy, createdAt, updatedAt, lastLoginAt,
              CASE WHEN tokenPurpose = 'invite' AND tokenHash IS NOT NULL THEN 1 ELSE 0 END
                AS invitePending
         FROM AdminDashboardAccount
        ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username`
    )
    .all();
  return results;
}

/** A single account without key material, or null. */
export async function getAccount(db, username) {
  const row = await findAccount(db, normalizeUsername(username));
  if (!row) return null;
  return {
    username: row.username,
    role: row.role,
    status: row.status,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
    invitePending: row.tokenPurpose === 'invite' && !!row.tokenHash ? 1 : 0,
  };
}

/**
 * Invite a viewer by email. The account exists immediately but cannot sign in
 * until they follow the emailed link and choose their own password — so no key
 * is ever transported by, or known to, the admin.
 *
 * Returns { ok, username, token } — the caller emails the token and discards it.
 */
export async function inviteViewer(db, email, invitedBy) {
  const name = normalizeUsername(email);
  if (!isValidUsername(name)) return { ok: false, error: USERNAME_RULE };

  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (existing) return { ok: false, error: `"${name}" already has an account.` };

  const { token, tokenHash } = await createToken();
  await db
    .prepare(
      `INSERT INTO AdminDashboardAccount
         (username, role, secretHash, status, invitedBy, tokenHash, tokenPurpose,
          tokenExpiresAt, createdAt, updatedAt)
       VALUES (?, 'viewer', NULL, 'invited', ?, ?, 'invite', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .bind(name, invitedBy || null, tokenHash, new Date(Date.now() + INVITE_TTL_MS).toISOString())
    .run();

  return { ok: true, username: name, token };
}

/** Re-send an invite: mints a fresh token and invalidates the previous one. */
export async function reissueInvite(db, username, invitedBy) {
  const name = normalizeUsername(username);
  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (!existing) return { ok: false, error: 'Account not found' };
  if (existing.status !== 'invited') {
    return { ok: false, error: 'That account has already been activated.' };
  }

  const { token, tokenHash } = await createToken();
  await db
    .prepare(
      `UPDATE AdminDashboardAccount
          SET tokenHash = ?, tokenPurpose = 'invite', tokenExpiresAt = ?, invitedBy = ?,
              updatedAt = CURRENT_TIMESTAMP
        WHERE username = ?`
    )
    .bind(tokenHash, new Date(Date.now() + INVITE_TTL_MS).toISOString(), invitedBy || existing.invitedBy, name)
    .run();

  return { ok: true, username: name, token };
}

/**
 * Start a password reset. Returns { ok: true, token } for a real, activated
 * account and { ok: true, token: null } otherwise — the caller responds
 * identically either way so the endpoint cannot be used to discover who has an
 * account.
 */
export async function startPasswordReset(db, email) {
  const name = normalizeUsername(email);
  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (!existing || existing.status === 'invited') return { ok: true, token: null };

  const { token, tokenHash } = await createToken();
  await db
    .prepare(
      `UPDATE AdminDashboardAccount
          SET tokenHash = ?, tokenPurpose = 'reset', tokenExpiresAt = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE username = ?`
    )
    .bind(tokenHash, new Date(Date.now() + RESET_TTL_MS).toISOString(), name)
    .run();

  return { ok: true, token, username: name };
}

/** Look up the account a link token belongs to, if it is still valid. */
export async function resolveToken(db, token) {
  if (!token) return null;
  await ensureAccountTable(db);
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT username, role, status, tokenPurpose, tokenExpiresAt
         FROM AdminDashboardAccount WHERE tokenHash = ?`
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (row.tokenExpiresAt && Date.parse(row.tokenExpiresAt) < Date.now()) return null;
  return {
    username: row.username,
    role: row.role,
    status: row.status,
    purpose: row.tokenPurpose,
  };
}

/**
 * Consume a link token and set the account's password. Activates an invited
 * account. The token is single-use — it is cleared here.
 */
export async function completeWithToken(db, token, newSecret) {
  const found = await resolveToken(db, token);
  if (!found) return { ok: false, error: 'That link is invalid or has expired.' };

  const value = String(newSecret ?? '').trim();
  if (value.length < 8) return { ok: false, error: SECRET_RULE };

  await db
    .prepare(
      `UPDATE AdminDashboardAccount
          SET secretHash = ?, status = 'active', tokenHash = NULL, tokenPurpose = NULL,
              tokenExpiresAt = NULL, secret = NULL, updatedAt = CURRENT_TIMESTAMP
        WHERE username = ?`
    )
    .bind(await hashSecret(value), found.username)
    .run();

  return { ok: true, username: found.username, purpose: found.purpose, role: found.role };
}

/**
 * Rotate an account's own key. The CURRENT key must be supplied and match.
 */
export async function changeAccountSecret(db, username, currentSecret, nextSecret) {
  const name = normalizeUsername(username);
  const value = String(nextSecret ?? '').trim();

  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (!existing) return { ok: false, error: 'Account not found' };
  if (!(await verifySecret(existing.secretHash, String(currentSecret ?? '')))) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  if (value.length < 8) return { ok: false, error: SECRET_RULE };
  if (await verifySecret(existing.secretHash, value)) {
    return { ok: false, error: 'New password must be different from the current one.' };
  }

  await db
    .prepare(
      `UPDATE AdminDashboardAccount
          SET secretHash = ?, secret = NULL, updatedAt = CURRENT_TIMESTAMP
        WHERE username = ?`
    )
    .bind(await hashSecret(value), name)
    .run();
  return { ok: true, username: name };
}

/** Rename an account. Key, role and status are untouched. */
export async function renameAccount(db, username, newUsername) {
  const from = normalizeUsername(username);
  const to = normalizeUsername(newUsername);

  if (!isValidUsername(to)) return { ok: false, error: USERNAME_RULE };

  await ensureAccountTable(db);
  const existing = await findAccount(db, from);
  if (!existing) return { ok: false, error: 'Account not found' };
  if (from === to) return { ok: false, error: 'That is already the username.' };

  const taken = await findAccount(db, to);
  if (taken) return { ok: false, error: `"${to}" is already taken.` };

  // `email` shadows the username unless someone pointed it at a different
  // address on purpose. Moving it with the rename keeps contactEmail() — and so
  // every invite / reset link — from being sent to the address just replaced.
  const previousEmail = normalizeUsername(existing.email) || null;
  const nextEmail = !previousEmail || previousEmail === from ? to : existing.email;

  await db
    .prepare(
      `UPDATE AdminDashboardAccount
          SET username = ?, email = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE username = ?`
    )
    .bind(to, nextEmail, from)
    .run();
  return { ok: true, username: to, previousUsername: from, email: nextEmail, role: existing.role };
}

/** Set the contact address an account's invite / reset mail goes to. */
export async function setAccountEmail(db, username, email) {
  const name = normalizeUsername(username);
  const address = normalizeUsername(email);
  if (!isValidUsername(address)) return { ok: false, error: 'Enter a valid email address.' };

  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (!existing) return { ok: false, error: 'Account not found' };

  await db
    .prepare(
      `UPDATE AdminDashboardAccount SET email = ?, updatedAt = CURRENT_TIMESTAMP WHERE username = ?`
    )
    .bind(address, name)
    .run();
  return { ok: true, username: name, email: address, previousEmail: existing.email || null };
}

/**
 * Change an account's role. Guarded so the dashboard can never be left without
 * an admin, and so nobody can quietly promote or demote themselves.
 */
export async function setAccountRole(db, username, role, callerUsername) {
  const name = normalizeUsername(username);
  const next = role === 'admin' ? 'admin' : role === 'viewer' ? 'viewer' : null;
  if (!next) return { ok: false, error: 'Role must be admin or viewer.' };

  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (!existing) return { ok: false, error: 'Account not found' };
  if (existing.role === next) return { ok: false, error: `That account is already ${next}.` };
  if (name === normalizeUsername(callerUsername)) {
    return { ok: false, error: 'You cannot change your own role.' };
  }

  if (existing.role === 'admin' && next === 'viewer') {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM AdminDashboardAccount WHERE role = 'admin'`)
      .first();
    if ((Number(row?.c) || 0) <= 1) {
      return { ok: false, error: 'That is the only admin — promote someone else first.' };
    }
  }

  await db
    .prepare(
      `UPDATE AdminDashboardAccount SET role = ?, updatedAt = CURRENT_TIMESTAMP WHERE username = ?`
    )
    .bind(next, name)
    .run();
  return { ok: true, username: name, role: next, previousRole: existing.role };
}

/** Delete a viewer account. Admin accounts are not deletable here. */
export async function deleteAccount(db, username) {
  const name = normalizeUsername(username);
  await ensureAccountTable(db);
  const existing = await findAccount(db, name);
  if (!existing) return { ok: false, error: 'Account not found' };
  if (existing.role === 'admin') return { ok: false, error: 'Admin accounts cannot be deleted.' };

  await db.prepare(`DELETE FROM AdminDashboardAccount WHERE username = ?`).bind(name).run();
  return { ok: true, username: name };
}
