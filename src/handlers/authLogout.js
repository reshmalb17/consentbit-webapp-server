// src/handlers/authLogout.js
import { deleteSessionById } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Clears session cookie and removes session row (if present).
 */
export async function handleAuthLogout(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (sid) {
    await deleteSessionById(db, sid);
  }

  const isProd = env.NODE_ENV === 'production';
  const cookieFlags = isProd
    ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `sid=; ${cookieFlags}`,
    },
  });
}
