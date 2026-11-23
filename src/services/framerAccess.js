// src/services/framerAccess.js
//
// Who may use the Framer plugin on a given project, and with which role.
//
// A Framer login (JWT minted by framer.consentbit.com /email/verify-otp) only proves
// the caller owns an email address — anyone can get one. It says nothing about the
// Framer project, because every collaborator who signs in on a project gets a token
// carrying that project's id. So access is decided here, per site, from:
//
//   owner  — the email that first connected the project in the plugin (KV
//            AUTH_STORE_FRAMER[platformSiteId].userData.email), or the site's owner in
//            the web app (OrganizationMember, via getSiteRole).
//   admin  — an active web-app team member with role 'admin' on this site.
//   member — an active web-app team member with role 'member' on this site.
//   null   — anyone else: no access to the project's account.
//
// Team membership is managed only in the web app (Profile → Team) and follows the same
// rules there (Essential/Growth sites, suspended when the plan lapses — getSiteRole).
//
// What each role may do from the plugin mirrors the web app:
//   owner  everything, including transfer ownership.
//   admin  acts as owner (plan changes, billing, cancel) except transfer ownership.
//   member banner, scan and consent logs; no plan/billing changes.

import { extractBearer, verifyJwtHS256, emailFromPayload } from '../handlers/framerUpgrade.js';
import { getSiteRole } from './team.js';

const TAG = '[framer-access]';

export const FRAMER_BILLING_ROLES = ['owner', 'admin'];
export const FRAMER_OWNER_ROLES = ['owner'];

const deny = (status, error, code) =>
  ({ ok: false, res: Response.json({ success: false, error, ...(code ? { code } : {}) }, { status }) });

function normEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

// Verify the plugin's Bearer token. Returns { email } or null (missing / bad / expired).
export async function readFramerToken(request, env) {
  const token = extractBearer(request);
  if (!token) return null;
  const secret = env.FRAMER_JWT_SECRET ? String(env.FRAMER_JWT_SECRET).trim() : '';
  if (!secret) {
    console.error(`${TAG} FRAMER_JWT_SECRET not configured`);
    return null;
  }
  const payload = await verifyJwtHS256(token, secret);
  if (!payload) return null;
  const email = emailFromPayload(payload);
  return email ? { email, payload } : null;
}

// Site row by internal id OR Framer platformSiteId.
export async function resolveFramerSite(db, siteId) {
  if (!db || !siteId) return null;
  return db
    .prepare('SELECT id, organizationId, platformSiteId FROM Site WHERE id = ?1 OR platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
    .bind(String(siteId))
    .first()
    .catch(() => null);
}

async function readKvRecord(env, platformSiteId) {
  if (!env.AUTH_STORE_FRAMER || !platformSiteId) return null;
  try {
    return await env.AUTH_STORE_FRAMER.get(String(platformSiteId), { type: 'json' });
  } catch (_) {
    return null;
  }
}

// Owner email recorded by the plugin for this Framer project, if any.
export function kvOwnerEmail(kv) {
  return normEmail(kv?.userData?.email) || null;
}

// Role of `email` on `site` ('owner' | 'admin' | 'member' | null). `kv` is the project's
// AUTH_STORE_FRAMER record when already loaded (saves a read).
export async function resolveFramerRole(env, email, site, kv) {
  const e = normEmail(email);
  if (!e) return null;

  const record = kv !== undefined ? kv : await readKvRecord(env, site?.platformSiteId);
  if (kvOwnerEmail(record) === e) return 'owner';

  const db = env.CONSENT_WEBAPP;
  if (!db || !site?.id) return null;
  try {
    const user = await db.prepare('SELECT id FROM User WHERE lower(email) = ?1 LIMIT 1').bind(e).first();
    if (!user?.id) return null;
    return await getSiteRole(db, user.id, site.id);
  } catch (err) {
    console.warn(`${TAG} role lookup failed:`, err?.message || err);
    return null;
  }
}

// Gate a plugin request on the caller's role for `site`.
// Returns { ok:true, email, role } or { ok:false, res }.
export async function requireFramerRole(request, env, site, allowedRoles) {
  const tok = await readFramerToken(request, env);
  if (!tok) return deny(401, 'Please sign in to ConsentBit again.', 'AUTH_REQUIRED');
  if (!site) return deny(404, 'Site not found', 'SITE_NOT_FOUND');
  const role = await resolveFramerRole(env, tok.email, site);
  if (!role) {
    return deny(403, 'This Framer project is connected to another ConsentBit account.', 'NOT_PROJECT_MEMBER');
  }
  if (!allowedRoles.includes(role)) {
    return deny(
      403,
      allowedRoles.length === 1
        ? 'Only the account owner can do this.'
        : 'Only the account owner or an admin can manage the plan and billing. Ask the owner.',
      'ROLE_NOT_ALLOWED',
    );
  }
  return { ok: true, email: tok.email, role };
}

// GET /api/framer/session?siteId=<Framer project id>   (Authorization: Bearer <plugin token>)
//
// The plugin's sign-in check. Replaces framer.consentbit.com /auth/me for the plugin,
// because only this worker can see web-app team members.
//   200 { loggedIn, role, user:{email}, isPublished, kvData:{ webAppSiteId, cdnScriptId } | null }
//       role null + kvData null → project not connected yet (new install; caller may claim it).
//   401 AUTH_REQUIRED       — no / invalid / expired token.
//   403 NOT_PROJECT_MEMBER  — the project belongs to another account and the caller is
//                             neither its owner nor a web-app team member on it.
// Only ids the plugin needs are returned — never the owner's email or other account data.
export async function handleFramerSession(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const tok = await readFramerToken(request, env);
  if (!tok) {
    return Response.json({ success: false, loggedIn: false, error: 'Please sign in again.', code: 'AUTH_REQUIRED' }, { status: 401 });
  }

  const platformSiteId = new URL(request.url).searchParams.get('siteId');
  if (!platformSiteId) {
    return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
  }

  const kv = await readKvRecord(env, platformSiteId);
  const user = { email: tok.email };

  // Not connected yet — no owner to protect. The caller becomes the owner when they connect.
  if (!kv || (!kvOwnerEmail(kv) && !kv.webAppSiteId)) {
    return Response.json({ success: true, loggedIn: true, role: null, user, isPublished: false, kvData: null });
  }

  const site = await resolveFramerSite(env.CONSENT_WEBAPP, kv.webAppSiteId || platformSiteId);
  const role = await resolveFramerRole(env, tok.email, site || { platformSiteId }, kv);
  if (!role) {
    return Response.json(
      {
        success: false,
        loggedIn: true,
        code: 'NOT_PROJECT_MEMBER',
        error: 'This Framer project is connected to another ConsentBit account. Ask the account owner to add you as a team member in the ConsentBit dashboard.',
      },
      { status: 403 },
    );
  }

  return Response.json({
    success: true,
    loggedIn: true,
    role,
    user,
    isPublished: !!kv.isPublished,
    kvData: { webAppSiteId: kv.webAppSiteId || null, cdnScriptId: kv.cdnScriptId || null },
  });
}
