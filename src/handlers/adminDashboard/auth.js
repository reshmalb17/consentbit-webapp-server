// src/handlers/adminDashboard/auth.js
//
// Authorization for the standalone Admin Dashboard routes.
//
// The dashboard has no static key of its own: the username + key the operator
// types at login ARE the credentials used for every subsequent call. So a caller
// is authorized by presenting
//
//   X-Admin-User + X-Admin-Key  → matched against the AdminDashboardAccount table;
//                                 grants that account's role ('admin' | 'viewer')
//
// or, as a break-glass path for server-to-server tooling and manual curl checks,
//
//   X-Admin-Key === env.ADMIN_SECRET  → grants 'admin' (no username needed)
//
// Read-only routes accept either role; mutating routes require 'admin'.

import { resolveAccount } from './accounts.js';
import { ctEq } from './crypto.js';

/**
 * Returns { username, role } for the request's admin headers, or null.
 * role is 'admin' | 'viewer'.
 */
export async function resolveCaller(request, env, db) {
  const key = request.headers.get('X-Admin-Key') || '';
  if (!key) return null;

  if (env?.ADMIN_SECRET && ctEq(key, env.ADMIN_SECRET)) {
    return { username: request.headers.get('X-Admin-User') || 'env', role: 'admin' };
  }

  const username = request.headers.get('X-Admin-User') || '';
  if (!username || !db) return null;
  return await resolveAccount(db, username, key);
}

export function unauthorized() {
  return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
}

export function forbidden(message) {
  return Response.json(
    { success: false, error: message || 'Forbidden — admin role required' },
    { status: 403 }
  );
}
