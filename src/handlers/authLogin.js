// src/handlers/authLogin.js
import { getUserByEmail, createSession } from '../services/db.js';

/** Compute SHA-256(email|password) as hex - same as frontend hashPasswordForRequest */
async function computeClientHash(email, password) {
  const s = `${(email || '').trim().toLowerCase()}|${(password || '').trim()}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function handleAuthLogin(request, env) {
  const db = env.CONSENT_WEBAPP;
  // Request body: email + passwordHash (required). Optional: password for server-side verify fallback.

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const email = (body.email || '').trim().toLowerCase();
  let passwordHash = (body.passwordHash || '').trim();
  const password = (body.password || '').trim();

  console.log('[AuthLogin] Attempt', { email: email ? `${email.slice(0, 3)}***@${email.split('@')[1] || '?'}` : 'missing' });

  if (!email) {
    return Response.json(
      { success: false, error: 'email required' },
      { status: 400 }
    );
  }
  // If password sent, compute hash server-side so login works even if client hash differed
  if (password && !passwordHash) {
    passwordHash = await computeClientHash(email, password);
  }
  if (!passwordHash) {
    console.log('[AuthLogin] Rejected: missing passwordHash (and no password)');
    return Response.json(
      { success: false, error: 'passwordHash required' },
      { status: 400 }
    );
  }

  const user = await getUserByEmail(db, email);
  // D1 may return column as passwordHash, password_hash, passwordhash, or other casing
  const passKey = user && Object.keys(user).find((k) => k.toLowerCase() === 'passwordhash');
  const stored = user && (
    user.passwordHash ??
    user.password_hash ??
    user.passwordhash ??
    (passKey ? user[passKey] : undefined)
  );
  if (!user || !stored) {
    console.log('[AuthLogin] Rejected: user not found or no stored hash', {
      email: email ? `${email.slice(0, 3)}***` : 'n/a',
      userKeys: user ? Object.keys(user).filter((k) => k.toLowerCase().includes('pass')).join(',') : 'none',
    });
    return Response.json(
      { success: false, error: 'Invalid credentials' },
      { status: 401 }
    );
  }
  // Diagnostic: lengths only (no hash values)
  const storedPrefix = typeof stored === 'string' ? stored.slice(0, 7) : 'n/a';
  const storedHashLen = typeof stored === 'string' && stored.startsWith('client:') ? stored.length - 7 : 0;
  console.log('[AuthLogin] Hash check', { storedPrefix, storedHashLen, sentHashLen: passwordHash.length });

  let valid = false;
  if (stored.startsWith('client:')) {
    // New accounts: verify with client-sent SHA-256 hash (case-insensitive hex)
    const storedHash = stored.slice(7).toLowerCase();
    valid = passwordHash.toLowerCase() === storedHash;
  } else {
    console.log('[AuthLogin] Rejected: legacy account', { userId: user.id });
    // Legacy accounts (PBKDF2): we no longer accept plain password; user must reset
    return Response.json(
      { success: false, error: 'This account uses an older sign-in method. Please use “Forgot password” to set a new password.' },
      { status: 401 }
    );
  }
  if (!valid) {
    console.log('[AuthLogin] Rejected: hash mismatch', { email: email ? `${email.slice(0, 3)}***` : 'n/a' });
    return Response.json(
      { success: false, error: 'Invalid credentials' },
      { status: 401 }
    );
  }

  const session = await createSession(db, { userId: user.id });
  console.log('[AuthLogin] Success', { userId: user.id, email: email ? `${email.slice(0, 3)}***@${email.split('@')[1] || '?'}` : 'n/a' });

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
