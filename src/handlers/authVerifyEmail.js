// src/handlers/authVerifyEmail.js
//
// Confirms that whoever signed up controls the email address on the account.
//
// The direct password signup at /api/auth/signup creates the account immediately —
// nothing there proves the address belongs to the person registering it. This closes
// that gap after the fact: the account works right away, but paid checkout stays blocked
// until this link is clicked (see createCheckoutSession.js).
//
//   POST /api/auth/verify-email          { token }   → confirm
//   GET  /api/auth/verify-email?token=…              → confirm (link click)
//   POST /api/auth/verify-email/resend               → new link for the logged-in user
//
// Token shape mirrors OwnershipTransfer: "<rowId>.<secret>". Only sha256(secret) is
// stored, so reading the table does not yield a usable link.

import {
  getSessionById,
  getUserById,
  getEmailVerificationTokenById,
  markEmailVerificationTokenUsed,
  markUserEmailVerified,
  cancelPendingEmailVerifications,
  createEmailVerificationToken,
  isEmailVerified,
} from '../services/db.js';
import { sendVerifyEmailLink } from '../services/email.js';

const TTL_MINUTES = 24 * 60;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function appOrigin(env) {
  return (env.WEBAPP_PUBLIC_URL || 'https://accounts.consentbit.com').replace(/\/$/, '');
}

/**
 * Issue a fresh link. Shared by signup and the resend endpoint.
 * Returns false when the address is already verified or email isn't configured.
 */
export async function issueEmailVerification(env, ctx, db, user) {
  if (!user?.id || !user?.email) return false;
  if (isEmailVerified(user)) return false;

  // Only the newest link stays valid — an older one in an inbox must not resurrect.
  await cancelPendingEmailVerifications(db, user.id);

  const secret = randomToken();
  const tokenHash = await sha256Hex(secret);
  const row = await createEmailVerificationToken(db, {
    userId: user.id,
    email: user.email,
    tokenHash,
    ttlMinutes: TTL_MINUTES,
  });

  const token = `${row.id}.${secret}`;
  const link = `${appOrigin(env)}/verify-email?token=${encodeURIComponent(token)}`;

  sendVerifyEmailLink(env, ctx, {
    to: user.email,
    name: user.name || '',
    link,
    ttlHours: Math.round(TTL_MINUTES / 60),
  });
  return true;
}

export async function handleAuthVerifyEmail(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database not available' }, { status: 503 });

  let token = '';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      token = String(body?.token || '').trim();
    } catch { /* fall through to the query string */ }
  }
  if (!token) {
    try { token = String(new URL(request.url).searchParams.get('token') || '').trim(); } catch { /* ignore */ }
  }

  if (!token || !token.includes('.')) {
    return Response.json({ success: false, error: 'Invalid or missing verification token' }, { status: 400 });
  }

  const [id, secret] = token.split('.');
  const row = await getEmailVerificationTokenById(db, id);
  if (!row) {
    return Response.json({ success: false, error: 'This verification link is not valid' }, { status: 400 });
  }

  // Compare hashes, never the secret itself.
  const computed = secret ? await sha256Hex(secret) : '';
  if (!secret || computed !== row.tokenHash) {
    return Response.json({ success: false, error: 'This verification link is not valid' }, { status: 400 });
  }

  // Already used is reported as success: clicking twice (or a mail scanner prefetching
  // the link) should not look like a failure to the person who did the right thing.
  if (row.status === 'used') {
    return Response.json({ success: true, alreadyVerified: true });
  }
  if (row.status !== 'pending') {
    return Response.json({ success: false, error: 'This verification link is no longer valid' }, { status: 400 });
  }
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    return Response.json(
      { success: false, expired: true, error: 'This verification link has expired. Request a new one from your profile.' },
      { status: 400 },
    );
  }

  await markUserEmailVerified(db, row.userId);
  await markEmailVerificationTokenUsed(db, row.id);

  console.log('[VerifyEmail] verified', { userId: row.userId, email: row.email });
  return Response.json({ success: true, email: row.email });
}

/** POST /api/auth/verify-email/resend — logged-in user asks for another link. */
export async function handleAuthVerifyEmailResend(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const session = await getSessionById(db, sid);
  if (!session) return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  const user = await getUserById(db, session.userId ?? session.user_id);
  if (!user) return Response.json({ success: false, error: 'Login required' }, { status: 401 });

  if (isEmailVerified(user)) {
    return Response.json({ success: true, alreadyVerified: true });
  }

  const sent = await issueEmailVerification(env, ctx, db, user);
  return Response.json({ success: true, sent });
}
