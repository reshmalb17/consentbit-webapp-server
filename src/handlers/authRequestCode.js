import { createEmailVerificationCode } from '../services/db.js';

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sendEmailViaBrevo(env, { to, subject, text }) {
  const apiKey = env.BREVO_API_KEY;
  const fromEmail = env.BREVO_FROM_EMAIL;
  const fromName = env.BREVO_FROM_NAME || 'ConsentBit';

  if (!apiKey) throw new Error('BREVO_API_KEY not configured');
  if (!fromEmail) throw new Error('BREVO_FROM_EMAIL not configured');

  const payload = {
    sender: { email: fromEmail, name: fromName },
    to: [{ email: to }],
    subject,
    textContent: text,
  };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': apiKey,
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('[AuthRequestCode] Brevo non-200', { status: res.status, bodySnippet: t.slice(0, 400) });
    throw new Error(`Brevo send failed: ${res.status} ${t}`.slice(0, 300));
  }
}

export async function handleAuthRequestCode(request, env) {
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
  const name = purpose === 'signup' ? (body?.name || '').trim() : null;

  const emailDomain = email.includes('@') ? email.split('@')[1] : '';
  console.log('[AuthRequestCode] request', {
    purpose,
    emailDomain,
    hasBrevoApiKey: Boolean(env.BREVO_API_KEY),
    hasBrevoFrom: Boolean(env.BREVO_FROM_EMAIL),
    otpTtlMinutes: env.OTP_TTL_MINUTES,
    otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
    nodeEnv: env.NODE_ENV,
    returnOtpInResponse: String(env.RETURN_OTP_IN_RESPONSE || '').toLowerCase() === 'true',
  });

  if (!isValidEmail(email)) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (purpose === 'signup' && !name) {
    return Response.json({ success: false, error: 'name is required for signup' }, { status: 400 });
  }

  const code = generateCode();
  const salt = env.OTP_SECRET || 'dev-otp-secret';
  const codeHash = await sha256Hex(`${purpose}|${email}|${code}|${salt}`);

  const ttlMinutes = Number(env.OTP_TTL_MINUTES || 10) || 10;
  const row = await createEmailVerificationCode(db, { email, purpose, codeHash, name, ttlMinutes });

  const subject = 'Your ConsentBit verification code';
  const text = `Your verification code is: ${code}\n\nIt expires in ${ttlMinutes} minutes.`;

  const isProd = env.NODE_ENV === 'production';
  const allowReturn = String(env.RETURN_OTP_IN_RESPONSE || '').toLowerCase() === 'true';

  try {
    console.log('[AuthRequestCode] sending via Brevo', { toDomain: emailDomain, expiresAt: row.expiresAt });
    await sendEmailViaBrevo(env, { to: email, subject, text });
  } catch (e) {
    // Dev fallback: return code in response if explicitly allowed or non-prod.
    console.error('[AuthRequestCode] Brevo send failed:', e?.message || e);
    if (!isProd || allowReturn) {
      return Response.json(
        { success: true, message: 'DEV: email not configured; returning code', requestId: row.id, expiresAt: row.expiresAt, code },
        { status: 200 },
      );
    }
    console.error('[AuthRequestCode] Email send failed:', e);
    return Response.json({ success: false, error: 'Failed to send verification code' }, { status: 502 });
  }

  return Response.json(
    { success: true, requestId: row.id, expiresAt: row.expiresAt },
    { status: 200 },
  );
}

