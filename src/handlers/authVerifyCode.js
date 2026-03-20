import {
  getLatestValidEmailVerificationCode,
  incrementEmailVerificationAttempts,
  consumeEmailVerificationCode,
  getUserByEmail,
  createUser,
  createSession,
  hashPassword,
} from '../services/db.js';

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function handleAuthVerifyCode(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body?.email || '').trim().toLowerCase();
  const purpose = body?.purpose === 'signup' ? 'signup' : 'login';
  const code = String(body?.code || '').trim();

  if (!isValidEmail(email)) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (!/^\d{6}$/.test(code)) {
    return Response.json({ success: false, error: 'Valid 6-digit code is required' }, { status: 400 });
  }

  const row = await getLatestValidEmailVerificationCode(db, { email, purpose });
  if (!row?.id) {
    return Response.json({ success: false, error: 'Code expired or not found' }, { status: 400 });
  }

  const attempts = Number(row.attempts ?? row.Attempts ?? 0);
  const maxAttempts = Number(env.OTP_MAX_ATTEMPTS || 5) || 5;
  if (attempts >= maxAttempts) {
    return Response.json({ success: false, error: 'Too many attempts. Request a new code.' }, { status: 429 });
  }

  const salt = env.OTP_SECRET || 'dev-otp-secret';
  const expected = row.codeHash ?? row.codehash;
  const computed = await sha256Hex(`${purpose}|${email}|${code}|${salt}`);

  if (!expected || computed !== expected) {
    await incrementEmailVerificationAttempts(db, row.id);
    return Response.json({ success: false, error: 'Invalid code' }, { status: 400 });
  }

  // Consume code (one-time use)
  await consumeEmailVerificationCode(db, row.id);

  if (purpose === 'login') {
    const user = await getUserByEmail(db, email);
    if (!user) {
      return Response.json({ success: false, error: 'No account found for this email. Please sign up.' }, { status: 404 });
    }

    const session = await createSession(db, { userId: user.id });
    const isProd = env.NODE_ENV === 'production';
    const cookieFlags = isProd
      ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'
      : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

    return Response.json(
      { success: true },
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': `sid=${session.id}; ${cookieFlags}`,
        },
      },
    );
  }

  // purpose === 'signup'
  const existing = await getUserByEmail(db, email);
  if (existing) {
    return Response.json({ success: false, error: 'An account with this email already exists' }, { status: 409 });
  }

  const name = (row.name || '').trim() || (body?.name || '').trim() || null;
  // Create user without password (store a random PBKDF2 hash so NOT NULL constraint is satisfied)
  const randomPassword = crypto.randomUUID() + crypto.randomUUID();
  const storedHash = await hashPassword(randomPassword);
  const user = await createUser(db, { email, name, passwordHash: storedHash });

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
    },
  );
}

