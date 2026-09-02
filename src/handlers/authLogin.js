// src/handlers/authLogin.js
import {
  getUserByEmail,
  createSession,
  hashPassword,
  isPasswordSet,
  verifyStoredPassword,
  updateUserPasswordHash,
} from '../services/db.js';
import { pwDebug, describeStored } from '../utils/pwDebug.js';
import { resolvePasswordField, AuthCryptoError } from '../utils/authCrypto.js';

/**
 * Password sign-in.
 *
 * A client-supplied `passwordHash` is deliberately NOT accepted any more. The previous
 * scheme compared that field to the stored value, which made the stored value a login
 * credential in its own right: anyone able to read the User table could authenticate as
 * any user without ever knowing a password. The password now arrives either RSA-OAEP
 * encrypted (passwordEnc) or as plaintext over HTTPS, and is checked against a PBKDF2
 * hash here. Encryption is a transport-layer nicety; TLS and the PBKDF2 hash at rest are
 * what actually protect the credential.
 */
export async function handleAuthLogin(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();

  // `passwordEnc` is the RSA-OAEP form; `password` stays accepted so the endpoint keeps
  // working before the key secret is set and for any client that has not been updated.
  let password = '';
  let encrypted = false;
  try {
    ({ password, encrypted } = await resolvePasswordField(env, { enc: body.passwordEnc, plain: body.password }));
  } catch (e) {
    if (e instanceof AuthCryptoError) {
      pwDebug('login:decrypt-failed', { email, reason: e.message });
      return Response.json({ success: false, error: e.message, code: 'PASSWORD_ENC_FAILED' }, { status: 400 });
    }
    throw e;
  }

  pwDebug('login:request', { email, passwordProvided: !!password, passwordLen: password.length, encrypted, legacyHashFieldSent: body.passwordHash !== undefined });

  if (!email) {
    return Response.json({ success: false, error: 'email required' }, { status: 400 });
  }
  if (!password) {
    return Response.json({ success: false, error: 'password required' }, { status: 400 });
  }

  const user = await getUserByEmail(db, email);
  // D1 may return the column as passwordHash, password_hash, passwordhash or other casing
  const passKey = user && Object.keys(user).find((k) => k.toLowerCase() === 'passwordhash');
  const stored = user && (
    user.passwordHash ??
    user.password_hash ??
    user.passwordhash ??
    (passKey ? user[passKey] : undefined)
  );

  pwDebug('login:lookup', { email, userFound: !!user, userId: user?.id ?? null, storedFormat: describeStored(stored), storedColumn: passKey ?? null });

  if (!user) {
    return Response.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
  }

  // Accounts created through the OTP flow hold the 'passwordless' sentinel rather than a
  // hash. Report that distinctly (the frontend raises PasswordNotSetError on this flag)
  // so the user is pointed at the email-code route instead of "wrong password".
  if (!isPasswordSet(stored)) {
    pwDebug('login:no-password-set', { email, userId: user.id, storedFormat: describeStored(stored) });
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
  pwDebug('login:verify', { email, userId: user.id, valid, needsRehash, storedFormat: describeStored(stored) });
  if (!valid) {
    return Response.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
  }

  // Legacy 'client:' SHA-256 row — upgrade it to PBKDF2 now that the plaintext is in hand.
  // Non-fatal by design: a write failure here must never block an otherwise valid sign-in.
  if (needsRehash) {
    try {
      await updateUserPasswordHash(db, user.id, await hashPassword(password));
      pwDebug('login:rehashed', { userId: user.id, from: 'legacy-client-sha256', to: 'pbkdf2' });
    } catch (e) {
      pwDebug('login:rehash-failed', { userId: user.id, error: e?.message || String(e) });
      console.error('[AuthLogin] password rehash failed', {
        userId: user.id,
        error: e?.message || String(e),
      });
    }
  }

  const session = await createSession(db, { userId: user.id });
  pwDebug('login:success', { userId: user.id, email, sessionCreated: true });

  const isProd = env.NODE_ENV === 'production';

  // Use Secure only in production (HTTPS); drop it in dev so localhost can send the cookie
  const cookieFlags = isProd
    ? 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';

  return new Response(
    JSON.stringify({ success: true }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `sid=${session.id}; ${cookieFlags}`,
      },
    }
  );
}
