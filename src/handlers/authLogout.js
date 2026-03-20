import { deleteSessionById, getSessionById } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleAuthLogout(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    // Still clear cookie to be safe
    return Response.json(
      { success: true },
      {
        status: 200,
        headers: {
          'Set-Cookie': 'sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
        },
      },
    );
  }

  // Ensure schema exists (defensive)
  try {
    // deleteSessionById doesn't need session lookup but we keep getSessionById for debugging/validity
    await getSessionById(db, sid);
  } catch (_) {}

  await deleteSessionById(db, sid);

  return Response.json(
    { success: true },
    {
      status: 200,
      headers: {
        'Set-Cookie': 'sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax',
      },
    },
  );
}

