// src/handlers/authSignup.js
import { ensureSchema } from '../services/db.js';
import { getUserByEmail, createUser, createSession, hashPassword } from '../services/db.js';
import { issueEmailVerification } from './authVerifyEmail.js';

export async function handleAuthSignup(request, env, ctx) {
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
  } else if (password) {
    // confirmPassword is optional: the signup form has a single password field with a
    // reveal toggle, so there is nothing to compare. Still enforced when a client does
    // send it, so a form that adds the field keeps its typo check.
    if (password.length < 8) {
      return Response.json({ success: false, error: 'Password must be at least 8 characters' }, { status: 400 });
    }
    // Mirror the policy the signup form applies, so the server is the authority rather
    // than trusting the client to have checked.
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return Response.json({ success: false, error: 'Password must contain at least one letter and one number' }, { status: 400 });
    }
    if (confirmPassword && password !== confirmPassword) {
      return Response.json({ success: false, error: 'Password and confirm password do not match' }, { status: 400 });
    }
    storedHash = await hashPassword(password);
  } else {
    return Response.json({ success: false, error: 'password required' }, { status: 400 });
  }

  await ensureSchema(db);

  const existing = await getUserByEmail(db, email);
  if (existing) {
    return Response.json({ success: false, error: 'An account with this email already exists' }, { status: 409 });
  }

  // Email+password signup only exists in the webapp — a genuine 'webapp' origin.
  const user = await createUser(db, { email, name: name || null, passwordHash: storedHash, signupSource: 'webapp' });

  const session = await createSession(db, { userId: user.id });

  // Nothing here proved the address belongs to whoever just registered it, so send the
  // proof after the fact. The account is usable immediately; paid checkout stays gated
  // on emailVerifiedAt until this link is clicked (see createCheckoutSession.js).
  // Fire-and-forget: a mail failure must not fail an otherwise-successful signup.
  try {
    await issueEmailVerification(env, ctx, db, user);
  } catch (e) {
    console.error('[AuthSignup] verification email failed', e?.message || String(e));
  }

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
