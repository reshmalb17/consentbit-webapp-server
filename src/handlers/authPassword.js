// src/handlers/authPassword.js
//
// Dedicated password auth endpoints:
//
//   POST /api/auth/password-signup   { name, email, password, confirmPassword? }
//   POST /api/auth/password-login    { email, password }  |  { email, passwordEnc }
//
// WHY SEPARATE from /api/auth/signup and /api/auth/login:
//   /api/auth/signup still carries the retired client-side SHA-256 branch
//   (passwordHash + confirmPasswordHash, stored as 'client:<sha256>'), kept only so older
//   clients keep working. Mixing the new flow into it made it ambiguous which scheme a
//   given request was using. This file has ONE scheme: plaintext over TLS, hashed
//   server-side with PBKDF2. There is no branch accepting a client-computed hash, because
//   such a hash IS the credential and is replayable by anyone who can read it.
//
// Neither endpoint sends a one-time code. Signup creates the account and returns with the
// session cookie already set; proof of email ownership is handled afterwards by the
// emailed confirmation link (authVerifyEmail.js), and paid checkout stays blocked until
// it is clicked -- see the emailNotVerified gate in createCheckoutSession.js.

import {
  ensureSchema,
  getUserByEmail,
  createUser,
  createSession,
  hashPassword,
  isPasswordSet,
  verifyStoredPassword,
  updateUserPasswordHash,
} from '../services/db.js';
import { resolvePasswordField, AuthCryptoError } from '../utils/authCrypto.js';
import { pwDebug, describeStored } from '../utils/pwDebug.js';
import { issueEmailVerification } from './authVerifyEmail.js';

/**
 * Same policy the signup form applies. The server is the authority here; the client
 * check only spares the user a round-trip on the obvious cases.
 */
function validatePasswordPolicy(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain at least one letter and one number';
  }
  return null;
}

function sessionCookie(env, sessionId) {
  // Secure only in production. Dropped in dev so localhost, on plain HTTP, keeps the cookie.
  const isProd = env.NODE_ENV === 'production';
  const flags = isProd
    ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';
  return `sid=${sessionId}; ${flags}`;
}

/** Read the password from either the plaintext or the RSA-OAEP field. */
async function readPassword(env, body, tag) {
  try {
    const { password, encrypted } = await resolvePasswordField(env, {
      enc: body.passwordEnc,
      plain: body.password,
    });
    return { password, encrypted };
  } catch (e) {
    if (e instanceof AuthCryptoError) {
      pwDebug(`${tag}:decrypt-failed`, { reason: e.message });
      return {
        error: Response.json(
          { success: false, error: e.message, code: 'PASSWORD_ENC_FAILED' },
          { status: 400 },
        ),
      };
    }
    throw e;
  }
}

// -- POST /api/auth/password-signup -----------------------------------------
export async function handlePasswordSignup(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = (body.name || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }

  const read = await readPassword(env, body, 'password-signup');
  if (read.error) return read.error;
  const password = read.password;

  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    return Response.json({ success: false, error: policyError }, { status: 400 });
  }

  // Read through the same resolver so the confirm field can be encrypted too. Sending it
  // in plaintext beside an encrypted password would put the very same secret back in the
  // request body and defeat the point of encrypting the first one.
  // Only compared when the client actually sends it, so a form without a confirm field
  // is not forced to send a fake one.
  const confirmRead = await readPassword(
    env,
    { passwordEnc: body.confirmPasswordEnc, password: body.confirmPassword ?? body.confirm_password ?? '' },
    'password-signup-confirm',
  );
  if (confirmRead.error) return confirmRead.error;
  const confirmPassword = confirmRead.password;
  if (confirmPassword && password !== confirmPassword) {
    return Response.json(
      { success: false, error: 'Password and confirm password do not match' },
      { status: 400 },
    );
  }

  await ensureSchema(db);

  const existing = await getUserByEmail(db, email);
  if (existing) {
    // Deliberately explicit: on a signup form "already registered" is the useful answer.
    // It does reveal that an address has an account, which the login form's
    // passwordNotSet flag already reveals anyway.
    return Response.json(
      { success: false, emailTaken: true, error: 'An account with this email already exists. Log in instead.' },
      { status: 409 },
    );
  }

  const storedHash = await hashPassword(password);
  const user = await createUser(db, {
    email,
    name: name || null,
    passwordHash: storedHash,
    signupSource: 'webapp',
  });
  pwDebug('password-signup:created', { userId: user.id, email, storedFormat: describeStored(storedHash) });

  const session = await createSession(db, { userId: user.id });

  // Nothing above proved the address belongs to whoever registered it. Send that proof
  // now: the account is usable immediately, but cannot reach paid checkout until the
  // link is clicked. Non-fatal, since a mail failure must not fail a good signup.
  try {
    await issueEmailVerification(env, ctx, db, user);
  } catch (e) {
    console.error('[PasswordSignup] verification email failed', e?.message || String(e));
  }

  return Response.json(
    {
      success: true,
      emailVerificationSent: true,
      user: { id: user.id, email: user.email, name: user.name },
    },
    { status: 201, headers: { 'Set-Cookie': sessionCookie(env, session.id) } },
  );
}

// -- POST /api/auth/password-login ------------------------------------------
export async function handlePasswordLogin(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return Response.json({ success: false, error: 'email required' }, { status: 400 });

  const read = await readPassword(env, body, 'password-login');
  if (read.error) return read.error;
  const password = read.password;
  if (!password) return Response.json({ success: false, error: 'password required' }, { status: 400 });

  const user = await getUserByEmail(db, email);
  // D1 returns the column with whatever casing the row was written with.
  const passKey = user && Object.keys(user).find((k) => k.toLowerCase() === 'passwordhash');
  const stored = user && (
    user.passwordHash ?? user.password_hash ?? user.passwordhash ?? (passKey ? user[passKey] : undefined)
  );

  pwDebug('password-login:lookup', { email, userFound: !!user, storedFormat: describeStored(stored) });

  // Unknown address and wrong password give the same answer, so this endpoint cannot be
  // used to enumerate who has an account.
  if (!user) {
    return Response.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
  }

  // OTP-only account: report that distinctly. The login form turns this flag into a
  // prompt to sign in with an email code, rather than "wrong password" on a password
  // that was never set.
  if (!isPasswordSet(stored)) {
    return Response.json(
      {
        success: false,
        passwordNotSet: true,
        error: 'This account has no password yet. Sign in with an email code, then set one from your profile.',
      },
      { status: 401 },
    );
  }

  const { valid, needsRehash } = await verifyStoredPassword({ email, password, stored });
  pwDebug('password-login:verify', { email, userId: user.id, valid, needsRehash });
  if (!valid) {
    return Response.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
  }

  // Legacy 'client:' SHA-256 row: upgrade to PBKDF2 now the plaintext is in hand.
  // Non-fatal by design, since a write failure must never block a valid sign-in.
  if (needsRehash) {
    try {
      await updateUserPasswordHash(db, user.id, await hashPassword(password));
      pwDebug('password-login:rehashed', { userId: user.id });
    } catch (e) {
      console.error('[PasswordLogin] rehash failed', e?.message || String(e));
    }
  }

  const session = await createSession(db, { userId: user.id });
  pwDebug('password-login:success', { userId: user.id, email });

  return Response.json(
    { success: true, user: { id: user.id, email: user.email, name: user.name } },
    { status: 200, headers: { 'Set-Cookie': sessionCookie(env, session.id) } },
  );
}
