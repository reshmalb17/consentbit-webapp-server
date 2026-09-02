// // src/handlers/authMe.js
// import {
//   getSessionById,
//   getUserById,
//   getOrganizationsForUser,
//   getOrCreateOrganizationForUser,
// } from '../services/db.js';

// function getSessionIdFromCookie(request) {
//   const cookie = request.headers.get('Cookie') || '';
//   const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
//   return match ? match[1].trim() : null;
// }

// export async function handleAuthMe(request, env) {
//   const db = env.CONSENT_WEBAPP;

//   const sid = getSessionIdFromCookie(request);
//   if (!sid) {
//     return Response.json({ authenticated: false }, { status: 200 });
//   }

//   const session = await getSessionById(db, sid);
//   if (!session) {
//     return Response.json({ authenticated: false }, { status: 200 });
//   }

//   const userId = session.userId ?? session.user_id;
//   const user = await getUserById(db, userId);
//   if (!user) {
//     return Response.json({ authenticated: false }, { status: 200 });
//   }

//   // New app convention: one organization per user.
//   // Ensure it exists so frontend always has a stable organizationId.
//   const defaultOrgName = user?.name ? `${user.name}'s Organization` : 'My Organization';
//   await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: defaultOrgName });
//   const orgs = await getOrganizationsForUser(db, user.id);
//   return Response.json(
//     {
//       authenticated: true,
//       user: {
//         id: user.id,
//         email: user.email,
//         name: user.name,
//       },
//       organizations: orgs,
//     },
//     { status: 200 },
//   );
// }
// src/handlers/authMe.js
import {
  getSessionById,
  getUserById,
  getOrganizationsForUser,
  getOrCreateOrganizationForUser,
  isPasswordSet,
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

  // 1. Get session
  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ authenticated: false }, { status: 200 });
  }

  // 2. Get user + orgs in parallel (both only need userId)
  const userId = session.userId ?? session.user_id;
  const [user, orgsInitial] = await Promise.all([
    getUserById(db, userId),
    getOrganizationsForUser(db, userId),
  ]);
  if (!user) {
    return Response.json({ authenticated: false }, { status: 200 });
  }

  // 3. If user has no orgs yet, create one then refetch
  let orgs = orgsInitial;
  if (!orgs || orgs.length === 0) {
    const defaultOrgName = user.name ? `${user.name}'s Organization` : 'My Organization';
    await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: defaultOrgName });
    orgs = await getOrganizationsForUser(db, user.id);
  }

  return Response.json(
    {
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        billingEmail: user.billingEmail ?? null,
        // Drives the profile password panel: "Set a password" for accounts that sign in
        // by emailed code only, "Change password" (which then requires the current one)
        // for accounts that already have one. Never send the hash itself — only whether
        // one exists. D1 casing varies by how the row was written, so check every
        // spelling before concluding there is no password.
        hasPassword: isPasswordSet(
          user.passwordHash ?? user.password_hash ?? user.passwordhash ?? null,
        ),
      },
      organizations: orgs,
    },
    { status: 200 },
  );
}
