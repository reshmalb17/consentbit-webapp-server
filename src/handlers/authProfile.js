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
