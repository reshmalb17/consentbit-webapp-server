// src/handlers/authSignup.js
import { ensureSchema } from '../services/db.js';
import { getUserByEmail, createUser, createSession, hashPassword } from '../services/db.js';

export async function handleAuthSignup(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not configured' }, { status: 503 });
  }

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  const passwordHash = body.passwordHash || '';
  const confirmPasswordHash = body.confirmPasswordHash ?? '';
  const password = body.password || '';
  const confirmPassword = body.confirmPassword ?? body.confirm_password ?? '';

  if (!email || !email.includes('@')) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }

  let storedHash;
  if (passwordHash && confirmPasswordHash) {
    if (passwordHash !== confirmPasswordHash) {
      return Response.json({ success: false, error: 'Password and confirm password do not match' }, { status: 400 });
    }
    // Client hash must be SHA-256 hex (64 chars)
    if (!/^[a-f0-9]{64}$/i.test(passwordHash)) {
      return Response.json({ success: false, error: 'Invalid password format' }, { status: 400 });
    }
    storedHash = 'client:' + passwordHash;
  } else if (password && confirmPassword) {
    if (password.length < 8) {
      return Response.json({ success: false, error: 'Password must be at least 8 characters' }, { status: 400 });
    }
    if (password !== confirmPassword) {
      return Response.json({ success: false, error: 'Password and confirm password do not match' }, { status: 400 });
    }
    storedHash = await hashPassword(password);
  } else {
    return Response.json({ success: false, error: 'passwordHash + confirmPasswordHash or password + confirmPassword required' }, { status: 400 });
  }

  await ensureSchema(db);

  const existing = await getUserByEmail(db, email);
  if (existing) {
    return Response.json({ success: false, error: 'An account with this email already exists' }, { status: 409 });
  }

  const user = await createUser(db, { email, name: name || null, passwordHash: storedHash });

  const session = await createSession(db, { userId: user.id });

  const isProd = env.NODE_ENV === 'production';
  const cookieFlags = isProd
    ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

  return Response.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name } },
    {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sid=${session.id}; ${cookieFlags}`,
      },
    }
  );
}
