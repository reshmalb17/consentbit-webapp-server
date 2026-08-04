// src/handlers/adminDashboard/emails.js
//
// Invite and password-reset emails for the Admin Dashboard, sent through the
// shared Brevo service. The link carries a single-use token; only its SHA-256
// digest is stored, so these messages are the one and only time the token exists
// in readable form.

import { sendBrevoEmail } from '../../services/email.js';

/** Where the dashboard lives. Override with ADMIN_DASHBOARD_URL if it ever moves. */
function dashboardUrl(env) {
  const raw = env?.ADMIN_DASHBOARD_URL || 'https://admin.consentbit.com';
  return String(raw).replace(/\/+$/, '');
}

const BTN =
  'display:inline-block;background:#007AFF;color:#ffffff;text-decoration:none;' +
  'font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;';

function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#ffffff;border-radius:16px;padding:40px 40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
          ${bodyHtml}
        </td></tr>
        <tr><td align="center" style="padding:24px 0 8px;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
            ConsentBit Admin · internal tool<br/>
            If you weren't expecting this email you can safely ignore it.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * "You've been given access" — sent when an admin adds a new operator.
 * The recipient sets their own password; nobody else ever knows it.
 */
export function sendAdminInviteEmail(env, ctx, { to, token, invitedBy, role = 'viewer' }) {
  const link = `${dashboardUrl(env)}/accept-invite?token=${encodeURIComponent(token)}`;
  const from = invitedBy && invitedBy !== '-' ? invitedBy : 'a ConsentBit admin';

  const html = shell(
    'Your ConsentBit Admin invitation',
    `<h1 style="margin:0 0 16px;font-size:22px;color:#111827;">You've been invited to ConsentBit Admin</h1>
     <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">
       ${escapeHtml(from)} has given you <b>${escapeHtml(role)}</b> access to the ConsentBit
       admin dashboard.
     </p>
     <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
       Choose your password to activate the account. This link works once and expires in 7 days.
     </p>
     <p style="margin:0 0 24px;"><a href="${link}" style="${BTN}">Set my password</a></p>
     <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;word-break:break-all;">
       Or paste this into your browser:<br/>${link}
     </p>`
  );

  const text =
    `You've been invited to ConsentBit Admin by ${from} with ${role} access.\n\n` +
    `Set your password (link works once, expires in 7 days):\n${link}\n`;

  return dispatch(env, ctx, {
    to,
    subject: 'Your ConsentBit Admin invitation',
    html,
    text,
  });
}

/** "Reset your password" — sent from the login page's forgot-password flow. */
export function sendAdminResetEmail(env, ctx, { to, token }) {
  const link = `${dashboardUrl(env)}/reset-password?token=${encodeURIComponent(token)}`;

  const html = shell(
    'Reset your ConsentBit Admin password',
    `<h1 style="margin:0 0 16px;font-size:22px;color:#111827;">Reset your password</h1>
     <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
       Someone asked to reset the password for this ConsentBit Admin account. This link
       works once and expires in 1 hour. If it wasn't you, ignore this email — your
       current password keeps working.
     </p>
     <p style="margin:0 0 24px;"><a href="${link}" style="${BTN}">Choose a new password</a></p>
     <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;word-break:break-all;">
       Or paste this into your browser:<br/>${link}
     </p>`
  );

  const text =
    `Reset your ConsentBit Admin password (link works once, expires in 1 hour):\n${link}\n\n` +
    `If you didn't ask for this, ignore this email.\n`;

  return dispatch(env, ctx, {
    to,
    subject: 'Reset your ConsentBit Admin password',
    html,
    text,
  });
}

/**
 * Hand the send to the runtime's background queue when we have a ctx, so the
 * caller's response isn't waiting on Brevo. Returns a promise either way.
 */
function dispatch(env, ctx, opts) {
  const p = sendBrevoEmail(env, opts).catch((err) =>
    console.error('[adminDashboard/email] send failed', err?.message || err)
  );
  if (ctx?.waitUntil) {
    ctx.waitUntil(p);
    return Promise.resolve();
  }
  return p;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
