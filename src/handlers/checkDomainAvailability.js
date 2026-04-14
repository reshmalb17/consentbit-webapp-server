// src/handlers/checkDomainAvailability.js
import {
  ensureSchema,
  getSessionById,
  getUserById,
  getSubscriptionByOrganization,
  getOrganizationsForUser,
  normalizeDomain,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function isActiveSubscription(sub) {
  const status = sub ? String(sub.status || '').toLowerCase() : '';
  return status === 'active' || status === 'trialing';
}

export async function handleCheckDomainAvailability(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const [session, body] = await Promise.all([
    getSessionById(db, sid),
    request.json().catch(() => null),
  ]);
  if (!session) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (!body) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const websiteUrl = String(body.websiteUrl || '').trim();
  const domain = normalizeDomain(websiteUrl);
  if (!domain) {
    return Response.json({ success: false, error: 'websiteUrl is required' }, { status: 400 });
  }

  const excludeSiteId = String(body.excludeSiteId ?? '').trim() || null;

  await ensureSchema(db);
  const existingSite = await db
    .prepare(
      `SELECT id, organizationId, domain FROM Site WHERE LOWER(domain) = LOWER(?1) LIMIT 1`,
    )
    .bind(domain)
    .first();

  if (!existingSite) {
    return Response.json({ success: true, available: true, domain }, { status: 200 });
  }

  // Updating an existing site: same row / same URL is always OK for preflight.
  if (excludeSiteId && String(existingSite.id) === excludeSiteId) {
    return Response.json(
      {
        success: true,
        available: true,
        domain,
        code: 'SAME_SITE',
        message: 'OK',
      },
      { status: 200 },
    );
  }

  // Rename / manage-site URL: another site already holds this domain — block with a clear reason.
  if (excludeSiteId) {
    const userOrgs = await getOrganizationsForUser(db, user.id);
    const allowedOrgIds = new Set(userOrgs.map((o) => String(o.id)));
    const holderOrgId = String(existingSite.organizationId ?? existingSite.organizationid ?? '');
    const sameAccount = holderOrgId && allowedOrgIds.has(holderOrgId);
    return Response.json(
      {
        success: true,
        available: false,
        domain,
        code: sameAccount ? 'DOMAIN_IN_USE_SAME_ACCOUNT' : 'DOMAIN_IN_USE_OTHER_ACCOUNT',
        message: sameAccount
          ? 'This website URL is already used by another site in your account.'
          : 'This website URL is already registered to another ConsentBit account.',
      },
      { status: 200 },
    );
  }

  // Add-site flow (no excludeSiteId): legacy “claimable” behaviour for inactive subscriptions
  const orgId = existingSite.organizationId ?? existingSite.organizationid;
  let sub = null;
  try {
    sub = orgId ? await getSubscriptionByOrganization(db, orgId) : null;
  } catch {
    sub = null;
  }

  if (isActiveSubscription(sub)) {
    return Response.json(
      {
        success: true,
        available: false,
        domain,
        code: 'DOMAIN_IN_USE_ACTIVE',
        message: 'This domain is already in use by another account.',
      },
      { status: 200 },
    );
  }

  return Response.json(
    {
      success: true,
      available: true,
      domain,
      code: 'DOMAIN_CLAIMABLE',
      message: 'Domain is available.',
    },
    { status: 200 },
  );
}
