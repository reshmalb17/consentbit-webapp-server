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
    return Response.json(
      { success: false, error: 'Invalid credentials' },
      { status: 401 }
    );
  }
  // Diagnostic: lengths only (no hash values)
  const storedPrefix = typeof stored === 'string' ? stored.slice(0, 7) : 'n/a';
  const storedHashLen = typeof stored === 'string' && stored.startsWith('client:') ? stored.length - 7 : 0;
  let valid = false;
  if (stored.startsWith('client:')) {
    // New accounts: verify with client-sent SHA-256 hash (case-insensitive hex)
    const storedHash = stored.slice(7).toLowerCase();
    valid = passwordHash.toLowerCase() === storedHash;
  } else {
    // Legacy accounts (PBKDF2): we no longer accept plain password; user must reset
    return Response.json(
      { success: false, error: 'This account uses an older sign-in method. Please use “Forgot password” to set a new password.' },
      { status: 401 }
    );
  }
  if (!valid) {
    return Response.json(
      { success: false, error: 'Invalid credentials' },
      { status: 401 }
    );
  }

  const session = await createSession(db, { userId: user.id });

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
