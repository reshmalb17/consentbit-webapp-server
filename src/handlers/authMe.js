// src/handlers/authMe.js
import {
  getSessionById,
  getUserById,
  getOrganizationsForUser,
  getOrCreateOrganizationForUser,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleAuthMe(request, env) {
  const db = env.CONSENT_WEBAPP;

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ authenticated: false }, { status: 200 });
  }

  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ authenticated: false }, { status: 200 });
  }

  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ authenticated: false }, { status: 200 });
  }

  // New app convention: one organization per user.
  // Ensure it exists so frontend always has a stable organizationId.
  const defaultOrgName = user?.name ? `${user.name}'s Organization` : 'My Organization';
  await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: defaultOrgName });
  const orgs = await getOrganizationsForUser(db, user.id);
  return Response.json(
    {
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      organizations: orgs,
    },
    { status: 200 },
  );
}
