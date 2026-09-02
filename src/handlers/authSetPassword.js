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
  }

  await updateUserPasswordHash(db, user.id, await hashPassword(newPassword));
  pwDebug('set-password:updated', { userId: user.id, email: user.email, storedFormatNow: 'pbkdf2-salt:hash' });

  return Response.json(
    { success: true, hasPassword: true, message: 'Password updated.' },
    { status: 200 },
  );
}
