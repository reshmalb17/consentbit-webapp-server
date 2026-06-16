import { createEmailVerificationCode, getUserByEmail } from '../services/db.js';

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

async function sendEmailViaBrevo(env, { to, subject, text, html }) {
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
    ...(html ? { htmlContent: html } : {}),
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

export async function handleAuthRequestCode(request, env, ctx) {
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

  if (!isValidEmail(email)) {
    return Response.json({ success: false, error: 'Valid email is required' }, { status: 400 });
  }
  if (purpose === 'signup' && !name) {
    return Response.json({ success: false, error: 'name is required for signup' }, { status: 400 });
  }

  const code = generateCode();
  const salt = env.OTP_SECRET || 'dev-otp-secret';

  // Run user lookup and hash computation in parallel — neither depends on the other
  const [existingUser, codeHash] = await Promise.all([
    getUserByEmail(db, email),
    sha256Hex(`${purpose}|${email}|${code}|${salt}`),
  ]);

  if (purpose === 'login' && !existingUser) {
    return Response.json({ success: false, error: 'No account found with this email. Please sign up first.' }, { status: 404 });
  }
  if (purpose === 'signup' && existingUser) {
    return Response.json({ success: false, error: 'An account with this email already exists. Please log in instead.' }, { status: 409 });
  }

  const loginUser = purpose === 'login' ? existingUser : null;
  const displayName = name || loginUser?.name || '';

  const ttlMinutes = Number(env.OTP_TTL_MINUTES || 10) || 10;
  const row = await createEmailVerificationCode(db, { email, purpose, codeHash, name, ttlMinutes });

  const subject = `Your ConsentBit verification code`;
  const text = `Hello${displayName ? ` ${displayName}` : ''},\n\nYour verification code is: ${code}\n\nThis code will expire in ${ttlMinutes} minutes, so please use it as soon as possible.\n\nIf you did not request this verification code, you can safely ignore this email.\n\nBest regards,\nConsentBit Team\n`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#ffffff;border-radius:12px;padding:32px 28px;border:1px solid #e5e7eb;">
      <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hello${displayName ? ` ${displayName}` : ''},</p>
      <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">Your verification code is:</p>

      <!-- Large, selectable code. Tap-and-hold (mobile) or click-drag (desktop) selects it for copy. -->
      <div style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:20px 16px;text-align:center;margin:0 0 22px;">
        <span style="display:inline-block;color:#111827;font-size:40px;font-weight:700;letter-spacing:10px;font-family:'Courier New',Courier,monospace;line-height:1.2;user-select:all;-webkit-user-select:all;">${code}</span>
      </div>

      <p style="margin:0 0 18px;color:#6b7280;font-size:14px;line-height:1.6;">This code will expire in ${ttlMinutes} minutes, so please use it as soon as possible.</p>
      <p style="margin:0 0 22px;color:#9ca3af;font-size:13px;line-height:1.6;">If you did not request this verification code, you can safely ignore this email.</p>
      <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
    </div>
  </div>
  </body></html>`;

  const hasBrevoConfig = Boolean(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL);
  const allowReturn = String(env.RETURN_OTP_IN_RESPONSE || '').toLowerCase() === 'true';

  console.log('[AuthRequestCode] email config check —', {
    hasBrevoApiKey: !!env.BREVO_API_KEY,
    hasBrevoFromEmail: !!env.BREVO_FROM_EMAIL,
    fromEmail: env.BREVO_FROM_EMAIL || '(not set)',
    allowReturn,
    hasBrevoConfig,
    toEmail: email,
    purpose,
    requestId: row.id,
  });

  // If Brevo is not configured, fall back to returning the code in the response (dev only)
  if (!hasBrevoConfig || allowReturn) {
    console.warn('[AuthRequestCode] ⚠️ DEV fallback — Brevo not configured, returning code in response. Email NOT sent.');
    return Response.json(
      { success: true, message: 'DEV: email not configured; returning code', requestId: row.id, expiresAt: row.expiresAt, code },
      { status: 200 },
    );
  }

  // Brevo is configured — fire email in background and respond immediately
  console.log('[AuthRequestCode] dispatching Brevo email to:', email);
  ctx.waitUntil(
    sendEmailViaBrevo(env, { to: email, subject, text, html })
      .then(() => {
        console.log('[AuthRequestCode] ✅ Brevo email sent to:', email);
      })
      .catch((e) => {
        console.error('[AuthRequestCode] ❌ Brevo send failed:', e?.message || e);
      })
  );

  return Response.json(
    { success: true, requestId: row.id, expiresAt: row.expiresAt },
    { status: 200 },
  );
}

