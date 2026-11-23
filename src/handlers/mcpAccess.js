// src/handlers/mcpAccess.js
//
// Profile → MCP access. The account owner turns AI-client access (ChatGPT, Claude,
// Cursor … through the ConsentBit MCP server) on or off, and sees / disconnects
// the clients that are connected.
//
//   GET  /api/mcp-access                   → { enabled, connections[] }
//   POST /api/mcp-access                   → { enabled: boolean }  turn access on/off
//   POST /api/mcp-access/disconnect        → { connectionId }      revoke one client
//   GET  /api/mcp-access/authorize?nonce=  → the pending AI-client request, for the Allow page
//   POST /api/mcp-access/authorize         → { nonce, decision: 'allow' | 'deny' } → { redirectTo }
//
// The MCP worker (consentbit-mcp) writes McpAuthRequest when a client starts OAuth
// and McpConnection when it finishes, and refuses every tool call when
// McpAccess.enabled is 0 or the connection has revokedAt set. OAuth tokens live in
// its OAuthStore table (D1, no KV); a disconnect here also deletes that grant's
// rows so the token dies at once. Table definitions must match consentbit-mcp's
// src/mcpTables.js.
import { getSessionById } from '../services/db.js';

let tablesReady = false;

async function ensureMcpTables(db) {
  if (tablesReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS McpAccess (
       userId TEXT PRIMARY KEY,
       enabled INTEGER NOT NULL DEFAULT 0,
       updatedAt TEXT NOT NULL
     )`
  ).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS McpConnection (
       id TEXT PRIMARY KEY,
       userId TEXT NOT NULL,
       grantId TEXT,
       clientId TEXT,
       clientName TEXT,
       scopes TEXT,
       createdAt TEXT NOT NULL,
       lastUsedAt TEXT,
       revokedAt TEXT
     )`
  ).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_mcpconnection_user ON McpConnection(userId, createdAt)`).run();
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS McpAuthRequest (
       nonce TEXT PRIMARY KEY,
       oauthRequest TEXT NOT NULL,
       clientId TEXT,
       clientName TEXT,
       scopes TEXT,
       callbackUrl TEXT NOT NULL,
       createdAt TEXT NOT NULL,
       expiresAt TEXT NOT NULL,
       userId TEXT,
       code TEXT,
       decision TEXT,
       decidedAt TEXT,
       consumedAt TEXT
     )`
  ).run();
  tablesReady = true;
}

function randomHex(bytes) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A pending request the Allow page may still act on.
async function pendingAuthRequest(db, nonce) {
  if (!/^[0-9a-f]{48}$/.test(nonce)) return null;
  const row = await db.prepare(`SELECT * FROM McpAuthRequest WHERE nonce = ?1`).bind(nonce).first();
  if (!row || row.decidedAt || row.consumedAt || Date.parse(row.expiresAt) < Date.now()) return null;
  return row;
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

// Only the account owner (a member of their own organization) manages MCP access —
// team-only users have no OrganizationMember row of their own.
async function ownsAccount(db, userId) {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM OrganizationMember WHERE userId = ?1 LIMIT 1`)
    .bind(userId)
    .first()
    .catch(() => null);
  return !!row;
}

async function readState(db, userId) {
  const access = await db.prepare(`SELECT enabled FROM McpAccess WHERE userId = ?1`).bind(userId).first();
  const { results } = await db
    .prepare(
      `SELECT id, clientName, scopes, createdAt, lastUsedAt
         FROM McpConnection WHERE userId = ?1 AND revokedAt IS NULL
        ORDER BY createdAt DESC LIMIT 50`
    )
    .bind(userId)
    .all();
  return {
    enabled: !!access?.enabled,
    connections: (results || []).map((c) => ({
      id: c.id,
      clientName: c.clientName || 'AI client',
      scopes: String(c.scopes || '').split(/[\s,]+/).filter(Boolean),
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt || null,
    })),
  };
}

// Drop the OAuth grant + tokens the MCP worker stored for this connection. The
// table only exists once consentbit-mcp has run against this database.
async function deleteOAuthGrant(db, userId, grantId) {
  await db
    .prepare(`DELETE FROM OAuthStore WHERE key = ?1 OR key LIKE ?2`)
    .bind(`grant:${userId}:${grantId}`, `token:${userId}:${grantId}:%`)
    .run()
    .catch(() => {});
}

export async function handleMcpAccess(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  const path = new URL(request.url).pathname;

  const sid = getSessionIdFromCookie(request);
  const session = sid ? await getSessionById(db, sid).catch(() => null) : null;
  const userId = session?.userId ?? session?.user_id ?? null;
  if (!userId) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  if (!(await ownsAccount(db, userId))) {
    return Response.json({ success: false, error: 'Only the account owner can manage MCP access' }, { status: 403 });
  }

  try {
    await ensureMcpTables(db);
  } catch (error) {
    console.error('[McpAccess] table setup failed:', error);
    return Response.json({ success: false, error: 'Service unavailable, please try again' }, { status: 503 });
  }

  if (request.method === 'GET' && path === '/api/mcp-access') {
    return Response.json({ success: true, ...(await readState(db, userId)) });
  }

  if (request.method === 'GET' && path === '/api/mcp-access/authorize') {
    const pending = await pendingAuthRequest(db, new URL(request.url).searchParams.get('nonce') || '');
    if (!pending) {
      return Response.json({ success: false, error: 'This connection request has expired. Start again from your AI client.' }, { status: 404 });
    }
    const access = await db.prepare(`SELECT enabled FROM McpAccess WHERE userId = ?1`).bind(userId).first();
    return Response.json({
      success: true,
      request: {
        clientName: pending.clientName || 'AI client',
        scopes: String(pending.scopes || '').split(/\s+/).filter(Boolean),
        expiresAt: pending.expiresAt,
      },
      enabled: !!access?.enabled,
    });
  }

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const now = new Date().toISOString();

  if (path === '/api/mcp-access/authorize') {
    const pending = await pendingAuthRequest(db, String(body?.nonce || ''));
    if (!pending) {
      return Response.json({ success: false, error: 'This connection request has expired. Start again from your AI client.' }, { status: 404 });
    }
    const decision = body?.decision === 'allow' ? 'allow' : 'deny';
    if (decision === 'allow') {
      const access = await db.prepare(`SELECT enabled FROM McpAccess WHERE userId = ?1`).bind(userId).first();
      if (!access?.enabled) {
        return Response.json({ success: false, error: 'Turn on MCP access first.' }, { status: 409 });
      }
    }
    // The MCP worker exchanges this one-time code at callbackUrl and issues the grant.
    const code = randomHex(24);
    const res = await db
      .prepare(
        `UPDATE McpAuthRequest SET userId = ?1, code = ?2, decision = ?3, decidedAt = ?4
          WHERE nonce = ?5 AND decidedAt IS NULL`
      )
      .bind(userId, code, decision, now, pending.nonce)
      .run();
    if (!res?.meta?.changes) {
      return Response.json({ success: false, error: 'This connection request was already answered.' }, { status: 409 });
    }
    const redirectTo = `${pending.callbackUrl}?nonce=${pending.nonce}&code=${code}`;
    return Response.json({ success: true, redirectTo });
  }

  if (path === '/api/mcp-access/disconnect') {
    const connectionId = String(body?.connectionId || '').trim();
    if (!connectionId) return Response.json({ success: false, error: 'connectionId is required' }, { status: 400 });
    const conn = await db
      .prepare(`SELECT grantId FROM McpConnection WHERE id = ?1 AND userId = ?2 AND revokedAt IS NULL`)
      .bind(connectionId, userId)
      .first();
    if (!conn) {
      return Response.json({ success: false, error: 'Connection not found' }, { status: 404 });
    }
    await db
      .prepare(`UPDATE McpConnection SET revokedAt = ?1 WHERE id = ?2 AND userId = ?3`)
      .bind(now, connectionId, userId)
      .run();
    if (conn.grantId) await deleteOAuthGrant(db, userId, conn.grantId);
    return Response.json({ success: true, ...(await readState(db, userId)) });
  }

  if (typeof body?.enabled !== 'boolean') {
    return Response.json({ success: false, error: 'enabled must be true or false' }, { status: 400 });
  }
  await db
    .prepare(
      `INSERT INTO McpAccess (userId, enabled, updatedAt) VALUES (?1, ?2, ?3)
       ON CONFLICT(userId) DO UPDATE SET enabled = excluded.enabled, updatedAt = excluded.updatedAt`
    )
    .bind(userId, body.enabled ? 1 : 0, now)
    .run();
  return Response.json({ success: true, ...(await readState(db, userId)) });
}
