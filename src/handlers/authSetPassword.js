// src/handlers/authSetPassword.js
import {
  getSessionById,
  getUserById,
  hashPassword,
  isPasswordSet,
  verifyStoredPassword,
  updateUserPasswordHash,
  validatePasswordPolicy,
} from '../services/db.js';
import { pwDebug, describeStored } from '../utils/pwDebug.js';
import { resolvePasswordField, AuthCryptoError } from '../utils/authCrypto.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Set a first password, or change an existing one, for the signed-in user.
 *
 * When the account already has a password, `currentPassword` is required and verified —
 * without that, a stolen session cookie would be enough to change the credential and lock
 * the real owner out. Accounts still on the OTP-only default can set a first password
 * without one, which is what lets this double as the reset path: sign in with an email
 * code, then set a password.
 */
export async function handleAuthSetPassword(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    pwDebug('set-password:no-cookie', { hasCookieHeader: !!request.headers.get('Cookie') });
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  const session = await getSessionById(db, sid);
  if (!session) {
    pwDebug('set-password:session-not-found', {});
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  const user = await getUserById(db, session.userId ?? session.user_id);
  if (!user) {
    pwDebug('set-password:user-not-found', { userId: session.userId ?? session.user_id });
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // Accepts either the RSA-OAEP form (`*Enc`) or plaintext — see authCrypto.js.
  let newPassword = '';
  let confirmPassword = '';
  let currentPassword = '';
  let encrypted = false;
  try {
    const np = await resolvePasswordField(env, { enc: body?.newPasswordEnc, plain: body?.newPassword });
    const cp = await resolvePasswordField(env, { enc: body?.confirmPasswordEnc, plain: body?.confirmPassword });
    const op = await resolvePasswordField(env, { enc: body?.currentPasswordEnc, plain: body?.currentPassword });
    newPassword = np.password;
    confirmPassword = cp.password;
    currentPassword = op.password;
    encrypted = np.encrypted;
  } catch (e) {
    if (e instanceof AuthCryptoError) {
      pwDebug('set-password:decrypt-failed', { userId: user.id, reason: e.message });
      return Response.json({ success: false, error: e.message, code: 'PASSWORD_ENC_FAILED' }, { status: 400 });
    }
    throw e;
  }

  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) {
    pwDebug('set-password:policy-rejected', { userId: user.id, reason: policyError, newLen: newPassword.length });
    return Response.json({ success: false, error: policyError }, { status: 400 });
  }
  // The UI uses a single field with a reveal toggle, so confirm is only compared when sent.
  if (confirmPassword && newPassword !== confirmPassword) {
    pwDebug('set-password:confirm-mismatch', { userId: user.id });
    return Response.json({ success: false, error: 'Passwords do not match' }, { status: 400 });
  }

  // D1 may return the column as passwordHash, password_hash, passwordhash or other casing
  const passKey = Object.keys(user).find((k) => k.toLowerCase() === 'passwordhash');
  const stored =
    user.passwordHash ??
    user.password_hash ??
    user.passwordhash ??
    (passKey ? user[passKey] : undefined);

  pwDebug('set-password:input', { userId: user.id, email: user.email, storedFormat: describeStored(stored), hasExistingPassword: isPasswordSet(stored), newLen: newPassword.length, confirmProvided: !!confirmPassword, currentProvided: !!currentPassword, encrypted });

  if (isPasswordSet(stored)) {
    if (!currentPassword) {
      pwDebug('set-password:current-required', { userId: user.id });
      return Response.json(
        { success: false, error: 'Current password is required to change your password.' },
        { status: 400 },
      );
    }
    const { valid } = await verifyStoredPassword({
      email: user.email,
      password: currentPassword,
      stored,
    });
    pwDebug('set-password:current-verified', { userId: user.id, valid });
    if (!valid) {
      return Response.json(
        { success: false, error: 'Current password is incorrect.' },
        { status: 401 },
      );
    }

    // Reusing the same password is a no-op dressed up as a change: the user believes
    // they have rotated a credential that may have been exposed, when nothing moved.
    // Checked here rather than only in the UI so it holds for any caller.
    if (newPassword === currentPassword) {
      pwDebug('set-password:unchanged', { userId: user.id });
      return Response.json(
        { success: false, error: 'New password must be different from your current password.' },
        { status: 400 },
      );
    }
  }

  await updateUserPasswordHash(db, user.id, await hashPassword(newPassword));
  pwDebug('set-password:updated', { userId: user.id, email: user.email, storedFormatNow: 'pbkdf2-salt:hash' });

  return Response.json(
    { success: true, hasPassword: true, message: 'Password updated.' },
    { status: 200 },
  );
}

/**
 * POST /api/auth/verify-password — check the signed-in user's current password without
 * changing anything.
 *
 * The profile panel uses this to reveal the "new password" fields only once the current
 * one is confirmed, so a user is not asked to type a new password before finding out the
 * old one was wrong. handleAuthSetPassword re-verifies on save regardless — this endpoint
 * is a UX gate, never the authorization.
 *
 * Deliberately NOT in AUTH_RATE_PATHS: everything in that set is CSRF-exempt, and this
 * takes a password from an existing session, so the CSRF header check matters more here
 * than the looser rate limit would. Guessing through it already requires a valid session,
 * i.e. the account is compromised anyway.
 */
export async function handleAuthVerifyPassword(request, env) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  const session = await getSessionById(db, sid);
  if (!session) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  const user = await getUserById(db, session.userId ?? session.user_id);
  if (!user) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  let currentPassword = '';
  try {
    const op = await resolvePasswordField(env, {
      enc: body?.currentPasswordEnc,
      plain: body?.currentPassword,
    });
    currentPassword = op.password;
  } catch (e) {
    if (e instanceof AuthCryptoError) {
      return Response.json({ success: false, error: e.message, code: 'PASSWORD_ENC_FAILED' }, { status: 400 });
    }
    throw e;
  }

  // D1 casing varies by how the row was written.
  const stored =
    user.passwordHash ?? user.password_hash ?? user.passwordhash ?? null;

  // No password set: nothing to verify, and the caller should be showing the
  // "set a first password" form rather than asking for a current one.
  if (!isPasswordSet(stored)) {
    return Response.json({ success: true, valid: false, passwordNotSet: true });
  }

  if (!currentPassword) {
    return Response.json({ success: false, error: 'Enter your current password' }, { status: 400 });
  }

  const { valid } = await verifyStoredPassword({
    email: user.email,
    password: currentPassword,
    stored,
  });
  pwDebug('verify-password:result', { userId: user.id, valid, storedFormat: describeStored(stored) });

  // 200 either way — "wrong password" is a normal answer here, not a request failure.
  return Response.json({ success: true, valid });
}
