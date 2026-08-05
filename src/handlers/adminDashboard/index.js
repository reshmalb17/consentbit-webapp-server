// src/handlers/adminDashboard/index.js
//
// HTTP handlers backing the standalone ConsentBit Admin Dashboard (Next.js app).
//
// Authorization lives in ./auth.js: the X-Admin-User + X-Admin-Key headers must
// match a row in the AdminDashboardAccount table (or X-Admin-Key alone may be
// env.ADMIN_SECRET, for tooling). The resolved role gates writes — 'viewer' may
// read, only 'admin' may edit/delete. The dashboard therefore needs NO static key
// of its own: it forwards the operator's own login credentials.
//
// Routes (registered in src/index.js, all treated as PUBLIC for TRANSPORT only —
// any-origin CORS, plain JSON, no CSRF — with authorization enforced HERE via the
// admin headers, mirroring the Framer billing pattern):
//
//   POST   /api/admin/dashboard/auth      body: { username, secret }  (login; unauthenticated by design)
//   GET    /api/admin/dashboard/stats
//   GET    /api/admin/dashboard/users?platform=&search=
//   GET    /api/admin/dashboard/user?id=<id>
//   PATCH  /api/admin/dashboard/user?id=<id>   { name?, email?, billingEmail? } admin only
//   DELETE /api/admin/dashboard/user?id=<id>&confirm=<email>                    admin only
//   PATCH  /api/admin/dashboard/site?id=<id>   { name?, domain?, ... }          admin only
//   DELETE /api/admin/dashboard/site?ids=<id,...>                               admin only
//   PATCH  /api/admin/dashboard/organization?id=<id>  { name }                  admin only
//   PATCH  /api/admin/dashboard/subscription?id=<id>  { planId?, status?, ... } admin only
//   GET    /api/admin/dashboard/sites?search=&platform=&banner=&regulation=&year=&month=&audience=
//   GET    /api/admin/dashboard/usage?month=&state=&plan=&platform=&legacy=      per-site usage
//   GET    /api/admin/dashboard/scans?search=&days=&year=&month=&claimed=&env=  cookie-checker activity
//   GET    /api/admin/dashboard/accounts              list logins (no keys ever)
//   POST   /api/admin/dashboard/accounts              { action: 'create' }      admin only
//                                                     { action: 'change-key' }  own account only
//   DELETE /api/admin/dashboard/accounts?username=    viewer accounts, admin only

import { resolveCaller, unauthorized, forbidden } from './auth.js';
import {
  getStats,
  listUsers,
  listSites,
  listUsage,
  getSiteStats,
  getUserDetail,
  updateUser,
  updateOrganization,
  updateSite,
  updateSubscription,
  deleteUserEverywhere,
  deleteSites,
} from './queries.js';
import {
  resolveAccount,
  touchLogin,
  listAccounts,
  getAccount,
  inviteViewer,
  reissueInvite,
  startPasswordReset,
  resolveToken,
  completeWithToken,
  changeAccountSecret,
  renameAccount,
  deleteAccount,
  normalizeUsername,
} from './accounts.js';
import { sendAdminInviteEmail, sendAdminResetEmail } from './emails.js';
import { logAudit, listAudit, listAuditActors } from './audit.js';
import { listScanEvents, getScanStats } from './scans.js';

function getDb(env) {
  return env.CONSENT_WEBAPP || null;
}

/** The scanner's own D1 — a different database from CONSENT_WEBAPP. */
function getScannerDb(env) {
  return env.COOKIE_SCANNER_DB || null;
}

function noDb() {
  return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
}

/**
 * POST /api/admin/dashboard/auth  { username, secret }
 * Backend login check — returns the account the credentials grant, or 401.
 * Called server-to-server by the dashboard's Next.js login route.
 *
 * This is the ONE unauthenticated route: the submitted credentials are themselves
 * what is being checked, so there is nothing to gate it with.
 */
export async function handleAdminDashboardAuth(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();

  let username = '';
  let secret = '';
  try {
    const body = await request.json();
    username = String(body?.username ?? '');
    secret = String(body?.secret ?? '');
  } catch (_) {
    return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
  }

  try {
    const account = await resolveAccount(db, username, secret);
    if (!account) {
      await logAudit(db, request, {
        action: 'login',
        actor: normalizeUsername(username) || '-',
        target: normalizeUsername(username) || null,
        outcome: 'denied',
        detail: { reason: 'invalid credentials' },
      });
      return Response.json({ role: null }, { status: 401 });
    }
    await touchLogin(db, account.username);
    await logAudit(db, request, {
      action: 'login',
      actor: account.username,
      actorRole: account.role,
    });
    return Response.json({ role: account.role, username: account.username });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * /api/admin/dashboard/account-setup — the emailed-link surface. Unauthenticated
 * by design: the single-use token IS the credential, and it is only ever valid
 * for the account it was minted for.
 *
 *   GET  ?token=…            → { username, purpose } if the link is still good
 *   POST { token, secret }   → sets the password, activating an invited account
 */
export async function handleAdminDashboardAccountSetup(request, env) {
  const db = getDb(env);
  if (!db) return noDb();

  try {
    if (request.method === 'GET') {
      const token = new URL(request.url).searchParams.get('token') || '';
      const found = await resolveToken(db, token);
      if (!found) {
        return Response.json(
          { success: false, error: 'That link is invalid or has expired.' },
          { status: 400 }
        );
      }
      return Response.json({ username: found.username, purpose: found.purpose });
    }

    if (request.method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
      }
      const r = await completeWithToken(db, String(body?.token || ''), body?.secret);
      if (!r.ok) return Response.json({ success: false, error: r.error }, { status: 400 });

      await logAudit(db, request, {
        action: r.purpose === 'invite' ? 'account.invite_accepted' : 'account.password_reset',
        actor: r.username,
        actorRole: r.role,
        target: r.username,
      });
      return Response.json({ ok: true, username: r.username, purpose: r.purpose });
    }

    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * POST /api/admin/dashboard/account-recover  { email }
 * Forgot-password. Always answers the same way whether or not the address has an
 * account, so it can't be used to enumerate operators.
 */
export async function handleAdminDashboardRecover(request, env, ctx) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();

  let email = '';
  try {
    const body = await request.json();
    email = normalizeUsername(body?.email);
  } catch (_) {
    return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
  }

  const generic = { ok: true, message: 'If that account exists, a reset link is on its way.' };
  if (!email) return Response.json(generic);

  try {
    const r = await startPasswordReset(db, email);
    if (r.token) {
      await sendAdminResetEmail(env, ctx, { to: r.username, token: r.token });
      await logAudit(db, request, {
        action: 'account.reset_requested',
        actor: r.username,
        target: r.username,
      });
    } else {
      await logAudit(db, request, {
        action: 'account.reset_requested',
        actor: email,
        target: email,
        outcome: 'denied',
        detail: { reason: 'no such active account' },
      });
    }
  } catch (err) {
    console.error('[adminDashboard] recover failed', err?.message || err);
  }

  return Response.json(generic);
}

/** GET /api/admin/dashboard/audit?actor=&action=&search=&limit= — admin only. */
export async function handleAdminDashboardAudit(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();
  if (caller.role !== 'admin') return forbidden('Only an admin can view the activity log.');

  const url = new URL(request.url);
  try {
    const entries = await listAudit(db, {
      actor: url.searchParams.get('actor') || undefined,
      action: url.searchParams.get('action') || undefined,
      search: (url.searchParams.get('search') || '').trim() || undefined,
      limit: url.searchParams.get('limit') || undefined,
    });
    return Response.json({ entries, actors: await listAuditActors(db), count: entries.length });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * GET /api/admin/dashboard/sites — site-level list with the owning user.
 *
 * Read-only, open to viewers. Deleting sites stays on the singular /site route.
 * Filters: search, platform, banner=live|not-live, year, month, audience.
 */
export async function handleAdminDashboardSites(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();

  const url = new URL(request.url);
  try {
    const sites = await listSites(db, {
      search: (url.searchParams.get('search') || '').trim(),
      platform: url.searchParams.get('platform') || 'all',
      banner: url.searchParams.get('banner') || 'all',
      regulation: url.searchParams.get('regulation') || 'all',
      year: url.searchParams.get('year') || '',
      month: url.searchParams.get('month') || '',
      audience: url.searchParams.get('audience') || 'all',
      plan: url.searchParams.get('plan') || 'all',
      legacy: url.searchParams.get('legacy') || 'all',
      limit: url.searchParams.get('limit') || undefined,
    });
    return Response.json({ sites, stats: await getSiteStats(db), count: sites.length });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * GET /api/admin/dashboard/usage — per-site scan + pageview usage for a month,
 * against each site's plan allowance.
 *
 * Read-only, so viewers may call it: it is consumption data with no key material.
 * Filters: search, platform, plan, legacy, audience, state, month, limit.
 */
export async function handleAdminDashboardUsage(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();

  const url = new URL(request.url);
  try {
    const usage = await listUsage(db, {
      search: (url.searchParams.get('search') || '').trim(),
      platform: url.searchParams.get('platform') || 'all',
      plan: url.searchParams.get('plan') || 'all',
      legacy: url.searchParams.get('legacy') || 'all',
      audience: url.searchParams.get('audience') || 'all',
      state: url.searchParams.get('state') || 'all',
      month: url.searchParams.get('month') || '',
      limit: url.searchParams.get('limit') || undefined,
    });
    return Response.json({ ...usage, count: usage.rows.length });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * GET /api/admin/dashboard/scans — public cookie-checker activity.
 *
 * Reads the scanner's database, not consent-webapp. Open to viewers: it is
 * activity data, and contains no key material.
 *
 * Filters: search (URL/domain/claim email), days, year, month,
 * claimed=claimed|anonymous, env=live|staging, limit.
 */
export async function handleAdminDashboardScans(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();

  const scannerDb = getScannerDb(env);
  if (!scannerDb) {
    return Response.json(
      { success: false, error: 'COOKIE_SCANNER_DB not configured' },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  try {
    const events = await listScanEvents(scannerDb, {
      search: (url.searchParams.get('search') || '').trim() || undefined,
      days: url.searchParams.get('days') || undefined,
      year: url.searchParams.get('year') || undefined,
      month: url.searchParams.get('month') || undefined,
      claimed: url.searchParams.get('claimed') || undefined,
      env: url.searchParams.get('env') || undefined,
      limit: url.searchParams.get('limit') || undefined,
    });
    return Response.json({ events, stats: await getScanStats(scannerDb), count: events.length });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * /api/admin/dashboard/accounts — manage the dashboard's own logins.
 *
 * Keys are write-only: nothing here ever returns a stored key.
 *
 *   GET    → admin: every account (username/role/timestamps); viewer: just itself
 *   POST   { action: 'create', username, secret }            admin only, always a viewer
 *          { action: 'rename', username, newUsername }       admin only
 *          { action: 'change-key', currentSecret, secret }   own account, current key required
 *   DELETE ?username=<name>                                  admin only, viewer accounts only
 */
export async function handleAdminDashboardAccounts(request, env, ctx) {
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();
  const who = { actor: caller.username, actorRole: caller.role };

  try {
    if (request.method === 'GET') {
      if (caller.role === 'admin') {
        return Response.json({ accounts: await listAccounts(db), me: caller.username });
      }
      const self = await getAccount(db, caller.username);
      return Response.json({ accounts: self ? [self] : [], me: caller.username });
    }

    if (request.method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
      }
      const action = String(body?.action || 'change-key');

      // Add a new operator: the account is created in 'invited' state and an
      // email goes out with a single-use link. The admin never sees or sets the
      // password — the invitee chooses it themselves.
      if (action === 'invite' || action === 'create') {
        if (caller.role !== 'admin') {
          await logAudit(db, request, {
            ...who,
            action: 'account.invite',
            target: normalizeUsername(body?.username || body?.email),
            outcome: 'denied',
          });
          return forbidden('Only an admin can add accounts.');
        }
        const r = await inviteViewer(db, body?.username || body?.email, caller.username);
        if (!r.ok) return Response.json({ success: false, error: r.error }, { status: 400 });

        await sendAdminInviteEmail(env, ctx, {
          to: r.username,
          token: r.token,
          invitedBy: caller.username,
        });
        await logAudit(db, request, { ...who, action: 'account.invite', target: r.username });
        return Response.json({
          ok: true,
          username: r.username,
          invited: true,
          accounts: await listAccounts(db),
        });
      }

      if (action === 'resend-invite') {
        if (caller.role !== 'admin') return forbidden('Only an admin can resend invitations.');
        const r = await reissueInvite(db, body?.username, caller.username);
        if (!r.ok) return Response.json({ success: false, error: r.error }, { status: 400 });

        await sendAdminInviteEmail(env, ctx, {
          to: r.username,
          token: r.token,
          invitedBy: caller.username,
        });
        await logAudit(db, request, { ...who, action: 'account.invite_resent', target: r.username });
        return Response.json({ ok: true, username: r.username, accounts: await listAccounts(db) });
      }

      if (action === 'rename') {
        if (caller.role !== 'admin') {
          return forbidden('Only an admin can change a username.');
        }
        const r = await renameAccount(db, body?.username, body?.newUsername);
        if (!r.ok) return Response.json({ success: false, error: r.error }, { status: 400 });

        await logAudit(db, request, {
          ...who,
          action: 'account.rename',
          target: r.username,
          detail: { from: r.previousUsername, to: r.username },
        });
        return Response.json({
          ok: true,
          username: r.username,
          previousUsername: r.previousUsername,
          accounts: await listAccounts(db),
        });
      }

      if (action === 'change-key') {
        // Always self-service: an account can only rotate its own key, and only
        // by proving the current one. Nobody — not even an admin — can set
        // someone else's key.
        const target = normalizeUsername(body?.username || caller.username);
        if (target !== caller.username) {
          return forbidden('You can only change your own key.');
        }
        const r = await changeAccountSecret(db, target, body?.currentSecret, body?.secret);
        if (!r.ok) {
          await logAudit(db, request, {
            ...who,
            action: 'account.change_password',
            target,
            outcome: 'failed',
            detail: { reason: r.error },
          });
          return Response.json({ success: false, error: r.error }, { status: 400 });
        }
        await logAudit(db, request, { ...who, action: 'account.change_password', target: r.username });
        return Response.json({ ok: true, username: r.username });
      }

      return Response.json({ success: false, error: 'Unknown action' }, { status: 400 });
    }

    if (request.method === 'DELETE') {
      if (caller.role !== 'admin') {
        return forbidden('Only an admin can remove viewer accounts.');
      }
      const url = new URL(request.url);
      const username = normalizeUsername(url.searchParams.get('username') || '');
      if (!username) {
        return Response.json({ success: false, error: 'Missing username' }, { status: 400 });
      }
      if (username === caller.username) {
        return Response.json(
          { success: false, error: 'You cannot delete your own account.' },
          { status: 400 }
        );
      }
      const r = await deleteAccount(db, username);
      if (!r.ok) return Response.json({ success: false, error: r.error }, { status: 400 });
      await logAudit(db, request, { ...who, action: 'account.delete', target: r.username });
      return Response.json({ ok: true, accounts: await listAccounts(db) });
    }

    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/** GET /api/admin/dashboard/stats */
export async function handleAdminDashboardStats(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const db = getDb(env);
  if (!db) return noDb();
  if (!(await resolveCaller(request, env, db))) return unauthorized();

  try {
    const stats = await getStats(db);
    return Response.json(stats);
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * /api/admin/dashboard/users
 *   GET    ?platform=&search=&plan=&status=&year=&month=&audience=&billing=   list
 *   DELETE ?ids=<id,id,…>&confirm=DELETE                             bulk cascade delete, admin only
 *
 * The bulk delete runs the same full cascade as the single-user delete, once per
 * id, and reports per-user outcomes so a partial failure is visible rather than
 * hidden behind an overall "success".
 */
export async function handleAdminDashboardUsers(request, env) {
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();

  const url = new URL(request.url);

  if (request.method === 'DELETE') {
    if (caller.role !== 'admin') return forbidden();

    const ids = (url.searchParams.get('ids') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!ids.length) {
      return Response.json({ success: false, error: 'Missing ids' }, { status: 400 });
    }
    if (url.searchParams.get('confirm') !== 'DELETE') {
      return Response.json(
        { success: false, error: 'Confirmation did not match. Deletion aborted.' },
        { status: 400 }
      );
    }

    const totals = {};
    const results = [];
    try {
      for (const id of ids) {
        const detail = await getUserDetail(db, id);
        const email = detail?.email || null;
        if (!detail) {
          results.push({ id, email, ok: false, error: 'User not found' });
          continue;
        }
        const report = await deleteUserEverywhere(db, id);
        results.push({ id, email, ok: !!report.ok, error: report.error || null });
        for (const [table, n] of Object.entries(report.deleted || {})) {
          totals[table] = (totals[table] || 0) + n;
        }
      }
    } catch (err) {
      return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
    }

    const deletedCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    await logAudit(db, request, {
      actor: caller.username,
      actorRole: caller.role,
      action: 'user.bulk_delete',
      target: `${deletedCount} users`,
      outcome: failed.length ? 'failed' : 'ok',
      detail: {
        requested: ids.length,
        deleted: results.filter((r) => r.ok).map((r) => r.email || r.id),
        failed: failed.map((f) => ({ id: f.id, error: f.error })),
        rows: totals,
      },
    });
    return Response.json({
      ok: failed.length === 0,
      requested: ids.length,
      deletedCount,
      failed,
      results,
      deleted: totals,
      ...(failed.length
        ? {
            error: `${deletedCount} of ${ids.length} deleted. ${failed.length} failed: ${failed
              .map((f) => `${f.email || f.id} (${f.error})`)
              .join('; ')}`,
          }
        : {}),
    });
  }

  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const platform = url.searchParams.get('platform') || 'all';
  const search = (url.searchParams.get('search') || '').trim();
  const plan = url.searchParams.get('plan') || 'all';
  const status = url.searchParams.get('status') || 'all';
  const year = url.searchParams.get('year') || '';
  const month = url.searchParams.get('month') || '';
  const audience = url.searchParams.get('audience') || 'all';
  const billing = url.searchParams.get('billing') || 'all';
  const legacy = url.searchParams.get('legacy') || 'all';

  try {
    const users = await listUsers(db, { platform, search, plan, status, year, month, audience, billing, legacy });
    return Response.json({ users, count: users.length });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/dashboard/site?ids=<id1,id2,...>
 * Deletes the named sites and all their child rows (consents, cookies, scripts,
 * scans, banner config, custom rules, license activations). Org-level billing is
 * left intact.
 */
export async function handleAdminDashboardSite(request, env) {
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();
  if (caller.role !== 'admin') return forbidden();

  const url = new URL(request.url);

  // PATCH /api/admin/dashboard/site?id=<id> — edit one site's own fields. The
  // billing rows hanging off its organization are Stripe's and stay read-only.
  if (request.method === 'PATCH') {
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ success: false, error: 'Missing id' }, { status: 400 });

    let body = {};
    try {
      body = await request.json();
    } catch (_) {
      return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
    }

    const fields = {};
    for (const k of ['name', 'domain', 'customDomain', 'stagingUrl', 'platform',
                     'banner_type', 'region_mode', 'verified']) {
      if (k in body) fields[k] = body[k];
    }

    const result = await updateSite(db, id, fields);
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: 400 });

    const after = await db
      .prepare(
        `SELECT id, organizationId, name, domain, customDomain, stagingUrl, platform,
                banner_type, region_mode, verified
           FROM Site WHERE id = ?`
      )
      .bind(id)
      .first();

    await logAudit(db, request, {
      actor: caller.username,
      actorRole: caller.role,
      action: 'site.edit',
      target: after?.domain || id,
      detail: { id, from: result.before, to: after },
    });
    return Response.json({ ok: true, site: after });
  }

  if (request.method !== 'DELETE') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const idsParam = url.searchParams.get('ids') || '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    return Response.json({ success: false, error: 'Missing ids' }, { status: 400 });
  }

  try {
    const report = await deleteSites(db, ids);
    await logAudit(db, request, {
      actor: caller.username,
      actorRole: caller.role,
      action: 'site.delete',
      target: (report.sites || []).map((s) => s.domain || s.id).join(', ') || ids.join(', '),
      outcome: report.ok ? 'ok' : 'failed',
      detail: { ids, rows: report.deleted, error: report.error || null },
    });
    if (!report.ok) return Response.json({ success: false, error: report.error }, { status: 400 });
    return Response.json(report);
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/dashboard/organization?id=<id>  body: { name }
 * The only editable field — ownerUserId is a real ownership transfer, which has
 * its own authorized flow, and the billing rows below it belong to Stripe.
 */
export async function handleAdminDashboardOrganization(request, env) {
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();
  if (caller.role !== 'admin') return forbidden();

  if (request.method !== 'PATCH') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ success: false, error: 'Missing id' }, { status: 400 });

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
  }

  try {
    const fields = {};
    if ('name' in body) fields.name = body.name;
    const result = await updateOrganization(db, id, fields);
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: 400 });

    const after = await db
      .prepare(`SELECT id, name FROM Organization WHERE id = ?`)
      .bind(id)
      .first();
    await logAudit(db, request, {
      actor: caller.username,
      actorRole: caller.role,
      action: 'organization.edit',
      target: after?.name || id,
      detail: { id, from: result.before, to: after },
    });
    return Response.json({ ok: true, organization: after });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/dashboard/subscription?id=<id>
 *   body: { planId?, planType?, interval?, status?, amountCents?,
 *           currentPeriodEnd?, cancelAtPeriodEnd?, licenseKey? }
 *
 * Admin only, like every other write here. The Stripe identifiers are absent by
 * design — see the note above updateSubscription().
 */
export async function handleAdminDashboardSubscription(request, env) {
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();
  if (caller.role !== 'admin') return forbidden();

  if (request.method !== 'PATCH') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ success: false, error: 'Missing id' }, { status: 400 });

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
  }

  try {
    const fields = {};
    for (const k of ['planId', 'planType', 'interval', 'status', 'amountCents',
                     'currentPeriodEnd', 'cancelAtPeriodEnd', 'licenseKey']) {
      if (k in body) fields[k] = body[k];
    }

    const result = await updateSubscription(db, id, fields);
    if (!result.ok) return Response.json({ success: false, error: result.error }, { status: 400 });

    const after = await db
      .prepare(
        `SELECT id, organizationId, planId, planType, interval, status, amountCents,
                currentPeriodEnd, cancelAtPeriodEnd, licenseKey
           FROM Subscription WHERE id = ?`
      )
      .bind(id)
      .first();
    await logAudit(db, request, {
      actor: caller.username,
      actorRole: caller.role,
      action: 'subscription.edit',
      target: id,
      detail: { id, from: result.before, to: after },
    });
    return Response.json({ ok: true, subscription: after });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * /api/admin/dashboard/user?id=<id>
 *   GET    → detail
 *   PATCH  → update { name?, email?, billingEmail? } (an email change cascades)
 *   DELETE → cascade delete (requires &confirm=<email>)
 */
export async function handleAdminDashboardUser(request, env) {
  const db = getDb(env);
  if (!db) return noDb();
  const caller = await resolveCaller(request, env, db);
  if (!caller) return unauthorized();
  // Reads are open to viewers; writes are admin-only.
  if (request.method !== 'GET' && caller.role !== 'admin') return forbidden();

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return Response.json({ success: false, error: 'Missing id' }, { status: 400 });
  }

  try {
    if (request.method === 'GET') {
      // Only the detail view asks for scans; the PATCH snapshots below don't
      // need them, so they keep the cheaper single-database read.
      const detail = await getUserDetail(db, id, getScannerDb(env));
      if (!detail) return Response.json({ success: false, error: 'User not found' }, { status: 404 });
      return Response.json(detail);
    }

    if (request.method === 'PATCH') {
      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        return Response.json({ success: false, error: 'Bad request' }, { status: 400 });
      }
      const fields = {};
      if ('name' in body) fields.name = body.name === '' ? null : body.name;
      if ('email' in body) fields.email = String(body.email);
      if ('billingEmail' in body) fields.billingEmail = body.billingEmail;

      const before = await getUserDetail(db, id);
      const result = await updateUser(db, id, fields);
      if (!result.ok) return Response.json({ success: false, error: result.error }, { status: 400 });
      // The response replaces the detail the page is rendering, so it has to be
      // the same shape the GET returns — scans included.
      const detail = await getUserDetail(db, id, getScannerDb(env));
      await logAudit(db, request, {
        actor: caller.username,
        actorRole: caller.role,
        action: 'user.edit',
        target: detail?.email || id,
        detail: {
          id,
          from: {
            name: before?.name ?? null,
            email: before?.email ?? null,
            billingEmail: before?.billingEmail ?? null,
          },
          to: {
            name: detail?.name ?? null,
            email: detail?.email ?? null,
            billingEmail: detail?.billingEmail ?? null,
          },
          // Follow-on rows a rename touched, so the log shows the blast radius.
          cascade: result.cascade || {},
          cascadeErrors: result.errors?.length ? result.errors : undefined,
        },
      });
      return Response.json({
        ok: true,
        user: detail,
        cascade: result.cascade || {},
        errors: result.errors || [],
      });
    }

    if (request.method === 'DELETE') {
      const confirm = url.searchParams.get('confirm');
      const detail = await getUserDetail(db, id);
      if (!detail) return Response.json({ success: false, error: 'User not found' }, { status: 404 });
      if (confirm !== detail.email) {
        return Response.json(
          { success: false, error: 'Confirmation email did not match. Deletion aborted.' },
          { status: 400 }
        );
      }
      const report = await deleteUserEverywhere(db, id);
      await logAudit(db, request, {
        actor: caller.username,
        actorRole: caller.role,
        action: 'user.delete',
        target: detail.email,
        outcome: report.ok ? 'ok' : 'failed',
        detail: { id, rows: report.deleted, error: report.error || null },
      });
      if (!report.ok) return Response.json({ success: false, error: report.error }, { status: 400 });
      return Response.json(report);
    }

    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  } catch (err) {
    return Response.json({ success: false, error: err?.message || 'Failed' }, { status: 500 });
  }
}
