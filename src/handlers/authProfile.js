import { getSessionById, getUserById, updateUserBillingEmail } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export async function handleAuthProfile(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'PATCH') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'User not found' }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { billingEmail } = body;

  // Validate billing email if provided (allow empty string to clear it)
  if (billingEmail !== undefined && billingEmail !== '' && !isValidEmail(billingEmail)) {
    return Response.json({ success: false, error: 'Invalid billing email address' }, { status: 400 });
  }

  const updated = await updateUserBillingEmail(db, userId, billingEmail ?? null);

  return Response.json({
    success: true,
    user: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      billingEmail: updated.billingEmail ?? null,
    },
  }, { status: 200 });
}

// ── Webflow-App profile update (Designer extension) ─────────────────────────
// Same effect as handleAuthProfile (updates the account owner's billing email),
// but identified by the Webflow ID token instead of a session cookie: the owner
// is the owner member of the current site's organization. Mirrors the webapp,
// which only persists billingEmail. Uses POST (PATCH isn't in the CORS allowlist).
export async function handleWfProfileUpdate(request, env, ctx, identity) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST' && request.method !== 'PATCH') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const webflowSiteId = identity?.webflowSiteId
    || request.headers.get('X-Webflow-Site-Id')
    || request.headers.get('x-webflow-site-id');
  const owner = await db
    .prepare(
      `SELECT u.id FROM Site s
         JOIN OrganizationMember m ON m.organizationId = s.organizationId AND lower(m.role) = 'owner'
         JOIN User u ON u.id = m.userId
        WHERE s.platformSiteId = ?1
        ORDER BY s.createdAt ASC LIMIT 1`,
    )
    .bind(webflowSiteId)
    .first();
  if (!owner) {
    return Response.json({ success: false, error: 'No account owner found for this site.' }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { billingEmail } = body;
  if (billingEmail !== undefined && billingEmail !== '' && !isValidEmail(billingEmail)) {
    return Response.json({ success: false, error: 'Invalid billing email address' }, { status: 400 });
  }

  const updated = await updateUserBillingEmail(db, owner.id, billingEmail ?? null);

  return Response.json({
    success: true,
    user: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      billingEmail: updated.billingEmail ?? null,
    },
  }, { status: 200 });
}
