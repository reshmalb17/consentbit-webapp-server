import {
  createEmailVerificationCode,
  countRecentEmailVerificationCodes,
  getUserByEmail,
  hashPassword,
  validatePasswordPolicy,
} from '../services/db.js';
import { pwDebug } from '../utils/pwDebug.js';
import { resolvePasswordField, AuthCryptoError } from '../utils/authCrypto.js';

function isValidEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e.includes('@') && e.includes('.') && e.length <= 320;
}

// Cryptographic RNG (Math.random is predictable). Rejection sampling keeps the six
// digits uniform: values ≥ the largest multiple of 900000 below 2^32 are redrawn.
function generateCode() {
  const limit = Math.floor(0x100000000 / 900000) * 900000;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(100000 + (buf[0] % 900000));
}

// Per-email cap on codes issued. Each new code carries its own 5 guesses, so without
// this an attacker could keep requesting codes to keep guessing. Busiest real email
// in the live table: 5 codes in an hour.
const MAX_CODES_PER_EMAIL_PER_HOUR = 10;

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
    // email.consentbit.com has no MX — route replies to the monitored support inbox.
    replyTo: { email: env.BREVO_REPLY_TO || 'web@consentbit.com', name: fromName },
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

  // Return Brevo's messageId — the ONLY field that correlates this request to a
  // delivery record in the Brevo dashboard (Transactional → Logs). A 2xx here
  // means Brevo accepted the message, NOT that the mailbox received it: bounces,
  // blocklisting and spam-filing all happen after this point.
  const body = await res.json().catch(() => null);
  return body?.messageId || null;
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

  // Optional signup password — omitting it keeps the original OTP-only signup working.
  // Validated here so a bad password fails before we send an email, and hashed below so
  // the plaintext is never persisted anywhere.
  // Accepts either the RSA-OAEP form (`passwordEnc`) or plaintext — see authCrypto.js.
  let signupPassword = '';
  let signupConfirm = '';
  let signupEncrypted = false;
  if (purpose === 'signup') {
    try {
      const pw = await resolvePasswordField(env, { enc: body?.passwordEnc, plain: body?.password });
      const cf = await resolvePasswordField(env, { enc: body?.confirmPasswordEnc, plain: body?.confirmPassword });
      signupPassword = pw.password;
      signupConfirm = cf.password;
      signupEncrypted = pw.encrypted;
    } catch (e) {
      if (e instanceof AuthCryptoError) {
        pwDebug('request-code:decrypt-failed', { email, reason: e.message });
        return Response.json({ success: false, error: e.message, code: 'PASSWORD_ENC_FAILED' }, { status: 400 });
      }
      throw e;
    }
  }
  if (signupPassword) {
    if (signupConfirm && signupPassword !== signupConfirm) {
      return Response.json({ success: false, error: 'Passwords do not match' }, { status: 400 });
    }
    const policyError = validatePasswordPolicy(signupPassword);
    if (policyError) {
      pwDebug('request-code:policy-rejected', { email, reason: policyError, passwordLen: signupPassword.length });
      return Response.json({ success: false, error: policyError }, { status: 400 });
    }
  }
  pwDebug('request-code:input', { email, purpose, hasPassword: !!signupPassword, passwordLen: signupPassword.length, confirmProvided: !!signupConfirm, encrypted: signupEncrypted });

  const code = generateCode();
  const salt = env.OTP_SECRET || 'dev-otp-secret';

  // --- Fixed-code test/review account (e.g. Google app review) ---
  // For a single allow-listed email, issue a deterministic code and skip sending
  // an email, so reviewers can log in repeatedly with a code we hand them.
  // verify-code is untouched: it still validates the hash and consumes the row
  // normally — this only forces the code value and bypasses the Brevo send.
  // Gated entirely by env: does nothing unless TEST_LOGIN_EMAIL + TEST_LOGIN_CODE are set.
  const testEmail = (env.TEST_LOGIN_EMAIL || '').trim().toLowerCase();
  const testCode = (env.TEST_LOGIN_CODE || '').trim();
  if (testEmail && testCode && email === testEmail && purpose === 'login') {
    const ttlMinutes = Number(env.OTP_TTL_MINUTES || 10) || 10;
    const fixedHash = await sha256Hex(`${purpose}|${email}|${testCode}|${salt}`);
    const fixedRow = await createEmailVerificationCode(db, { email, purpose, codeHash: fixedHash, name: null, ttlMinutes });
    return Response.json(
      { success: true, requestId: fixedRow.id, expiresAt: fixedRow.expiresAt },
      { status: 200 },
    );
  }

  const recentCodes = await countRecentEmailVerificationCodes(db, {
    email,
    purpose,
    sinceIso: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }).catch(() => 0);
  if (recentCodes >= MAX_CODES_PER_EMAIL_PER_HOUR) {
    console.warn('[AuthRequestCode] per-email code cap reached', { emailDomain, purpose });
    return Response.json(
      { success: false, error: 'Too many codes requested for this email. Please wait an hour and try again.' },
      { status: 429 },
    );
  }

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
  const rawDisplayName = String(name || loginUser?.name || '').trim();
  // Capitalise the first letter for the greeting ("reshma" -> "Reshma").
  const displayName = rawDisplayName ? rawDisplayName.charAt(0).toUpperCase() + rawDisplayName.slice(1) : '';

  const ttlMinutes = Number(env.OTP_TTL_MINUTES || 10) || 10;
  // A large insertMs here means this request paid for the cold-start schema
  // migration — cross-reference the [ensureSchema] COLD START line in the tail.
  const signupPasswordHash = signupPassword ? await hashPassword(signupPassword) : null;
  const row = await createEmailVerificationCode(db, {
    email,
    purpose,
    codeHash,
    name,
    ttlMinutes,
    passwordHash: signupPasswordHash,
  });
  pwDebug('request-code:parked', { requestId: row.id, purpose, parkedHash: !!signupPasswordHash, hashLen: signupPasswordHash ? signupPasswordHash.length : 0 });

  const subject = `Your ConsentBit verification code`;
  // Plain-text body; the old templated versions are kept below, commented out.
  // Kept above ~800 bytes of words: spam filters penalise short mails that carry an
  // image (Brevo's open-tracking pixel) — SpamAssassin HTML_IMAGE_ONLY_08.
  const text = [
    `Hi${displayName ? ` ${displayName}` : ''},`,
    ``,
    `We received a request to sign in to your ConsentBit account. Use the code below to complete your login:`,
    ``,
    `${code}`,
    ``,
    `This code will expire in ${ttlMinutes} minutes and can only be used once. For your security, please don't share this code with anyone. The ConsentBit team will never ask you for it by email, phone, or chat.`,
    ``,
    `Didn't try to sign in?`,
    `If you didn't request this code, you can safely ignore this email. Your account remains secure, and no one can access it without this code. If you keep receiving login codes you didn't request, we recommend contacting our support team so we can help protect your account.`,
    ``,
    `Need help?`,
    `If you have any trouble signing in, reply to this email or contact us at web@consentbit.com and our team will be happy to assist you.`,
    ``,
    `Thanks,`,
    `The ConsentBit Team`,
  ].join('\n');
  // const text = `Hello${displayName ? ` ${displayName}` : ''},\n\nYour verification code is: ${code}\n\nThis code will expire in ${ttlMinutes} minutes, so please use it as soon as possible.\n\nIf you did not request this verification code, you can safely ignore this email.\n\nBest regards,\nConsentBit Team\n`;
  // HTML version: same wording as the text body above, styled to match the Framer OTP email
  // (Framer-server/consentbitapp-cf-server/src/routes/verifyOTP.js). Plenty of words, so the
  // Brevo tracking pixel no longer trips SpamAssassin HTML_IMAGE_ONLY_08.
  const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `
<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8"><title>Your ConsentBit verification code</title></head>
  <body style="font-family: Arial, sans-serif; background:#f5f7fb; margin:0; padding:32px; color:#1f2937;">
    <table align="center" cellpadding="0" cellspacing="0" width="480" style="background:#ffffff; border-radius:12px; box-shadow:0 2px 8px rgba(15,23,42,0.06); padding:32px;">
      <tr>
        <td>
          <h2 style="margin:0 0 16px 0; color:#111827;">Your ConsentBit verification code</h2>
          <p style="margin:0 0 16px 0; color:#374151; line-height:1.6;">
            Hi${displayName ? ` <strong>${esc(displayName)}</strong>` : ""},
          </p>
          <p style="margin:0 0 20px 0; color:#374151; line-height:1.6;">
            We received a request to sign in to your ConsentBit account. Use the code below to complete your login:
          </p>
          <div style="text-align:center; margin:24px 0;">
            <div style="
              display:inline-block;
              font-family: 'Courier New', monospace;
              font-size:32px;
              letter-spacing:8px;
              font-weight:700;
              padding:16px 24px;
              background:#262e84;
              color:#ffffff;
              border-radius:10px;
              -webkit-user-select: all;
              -moz-user-select: all;
              -ms-user-select: all;
              user-select: all;
              cursor: pointer;
            ">${code}</div>
          </div>
          <p style="margin:16px 0 0 0; color:#374151; line-height:1.6;">
            This code will expire in <strong>${ttlMinutes} minutes</strong> and can only be used once. For your security, please don't share this code with anyone. The ConsentBit team will never ask you for it by email, phone, or chat.
          </p>
          <p style="margin:20px 0 0 0; color:#111827; line-height:1.6;">
            <strong>Didn't try to sign in?</strong>
          </p>
          <p style="margin:4px 0 0 0; color:#6b7280; font-size:13px; line-height:1.6;">
            If you didn't request this code, you can safely ignore this email. Your account remains secure, and no one can access it without this code. If you keep receiving login codes you didn't request, we recommend contacting our support team so we can help protect your account.
          </p>
          <p style="margin:20px 0 0 0; color:#111827; line-height:1.6;">
            <strong>Need help?</strong>
          </p>
          <p style="margin:4px 0 0 0; color:#6b7280; font-size:13px; line-height:1.6;">
            If you have any trouble signing in, reply to this email or contact us at <a href="mailto:web@consentbit.com" style="color:#262e84;">web@consentbit.com</a> and our team will be happy to assist you.
          </p>
          <hr style="border:none; border-top:1px solid #e5e7eb; margin:24px 0;">
          <p style="margin:0; color:#374151; font-size:13px; line-height:1.6;">
            Thanks,<br>
            <strong>The ConsentBit Team</strong>
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
  /* const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;">
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
  </body></html>`; */

  const hasBrevoConfig = Boolean(env.BREVO_API_KEY && env.BREVO_FROM_EMAIL);
  const allowReturn = String(env.RETURN_OTP_IN_RESPONSE || '').toLowerCase() === 'true';


  // If Brevo is not configured, fall back to returning the code in the response (dev only)
  if (!hasBrevoConfig || allowReturn) {
    console.warn('[AuthRequestCode] ⚠️ DEV fallback — Brevo not configured, returning code in response. Email NOT sent.');
    return Response.json(
      { success: true, message: 'DEV: email not configured; returning code', requestId: row.id, expiresAt: row.expiresAt, code },
      { status: 200 },
    );
  }

  // Brevo is configured — fire email in background and respond immediately
  const brevoT0 = Date.now();
  ctx.waitUntil(
    sendEmailViaBrevo(env, { to: email, subject, text, html })
      .then((messageId) => {
        // ACCEPTED ≠ DELIVERED. Brevo returning 2xx only means it queued the mail.
        // To confirm the mailbox actually got it, look this messageId up in
        // Brevo → Transactional → Logs and check for Blocked / Hard bounce /
        // Soft bounce / Spam / Deferred, and check the Blocklist for the address.
      })
      .catch((e) => {
        console.error('[AuthRequestCode] ❌ Brevo send FAILED', {
          to: email,
          emailDomain,
          requestId: row.id,
          brevoMs: Date.now() - brevoT0,
          error: e?.message || String(e),
        });
      })
  );

  return Response.json(
    { success: true, requestId: row.id, expiresAt: row.expiresAt },
    { status: 200 },
  );
}

