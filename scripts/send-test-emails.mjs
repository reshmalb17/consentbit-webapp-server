// One-off tester: sends the REAL Free-Plan welcome email (full layout + footer,
// with the auto-link fix) to a recipient via Brevo. The HTML below mirrors
// src/services/email.js sendFreePlanEmail() exactly — keep them in sync.
//
//   PowerShell:
//     $env:BREVO_API_KEY="xkeysib-..."; node scripts/send-test-emails.mjs reshma@seattlenewmedia.com
//
// Optional env: BREVO_FROM_EMAIL (default web@email.consentbit.com), BREVO_FROM_NAME (default ConsentBit)

const to = process.argv[2] || 'reshma@seattlenewmedia.com';
const apiKey = process.env.BREVO_API_KEY;
const fromEmail = process.env.BREVO_FROM_EMAIL || 'web@email.consentbit.com';
const fromName = process.env.BREVO_FROM_NAME || 'ConsentBit';

if (!apiKey) {
  console.error('Missing BREVO_API_KEY env var. Set it then re-run.');
  process.exit(1);
}

// ---- sample data ----
const displayName = 'there';
const displayDomain = 'check-planupdate.com';
const dashboardUrl = 'https://accounts.consentbit.com/dashboard';
const scriptUrl =
  'https://consent-webapp-manager.web-8fb.workers.dev/consentbit/bc5a202f-909c-434d-b0cd-81adf6ad5f95/script.js';

// ---- shared styles (mirror email.js) ----
const BTN =
  'display:inline-block;background:#007AFF;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;';
const HR = '<div style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;"></div>';

function layout(preheader, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ConsentBit</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:600px;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#ffffff;border-radius:16px;padding:40px 40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
          ${bodyHtml}
        </td></tr>
        <tr><td align="center" style="padding:24px 0 8px;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
            ConsentBit · Cookie Consent Management<br/>
            You're receiving this because you signed up at consentbit.com.<br/>
            <a href="https://consentbit.com" style="color:#9ca3af;text-decoration:none;">Visit website</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---- auto-link disabled snippet (mirror email.js) ----
const noAutoLink = (url) =>
  String(url).replace('://', ':<span></span>//').replace(/\.(?=[a-z]{2,})/gi, '<span></span>.');
const snippet = `&lt;script id="consentbit" src="${noAutoLink(scriptUrl)}" async&gt;&lt;/script&gt;`;

const subject = `Your site is ready: ${displayDomain}`;
const html = layout(
  `Your site is ready on the ConsentBit Free Plan.`,
  `
  <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
  <p style="margin:0 0 20px;color:#6b7280;font-size:15px;line-height:1.6;">
    Good news; your website, <strong style="color:#111827;">${displayDomain}</strong>, has been successfully set up on the ConsentBit Free Plan.
  </p>
  <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
    To activate your cookie consent banner, simply copy and paste the script below into the
    <code style="font-size:13px;background:#f3f4f6;padding:2px 6px;border-radius:4px;">&lt;head&gt;</code> section of your website:
  </p>
  ${HR}
  <p style="margin:0 0 10px;color:#111827;font-size:14px;font-weight:600;">Installation script</p>
  <div style="background:#f3f4f6;border-radius:8px;padding:16px 20px;margin-bottom:24px;overflow:hidden;border:1px solid #e5e7eb;">
    <code style="color:#374151;font-size:13px;font-family:'Courier New',Courier,monospace;line-height:1.6;word-break:break-all;">
      &lt;!-- ConsentBit --&gt;<br/>
      ${snippet}
    </code>
  </div>
  ${HR}
  <p style="margin:0 0 10px;color:#111827;font-size:14px;font-weight:700;">Your Free Plan includes:</p>
  <ul style="margin:0 0 18px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
    <li>1 domain</li>
    <li>7,500 page views per month</li>
    <li>100 cookie scans</li>
    <li>GDPR &amp; CCPA compliance support</li>
  </ul>
  <p style="margin:0 0 22px;color:#6b7280;font-size:14px;line-height:1.6;">
    As your website grows, you can upgrade your plan anytime to unlock additional features and higher limits.
  </p>
  <a href="${dashboardUrl}" style="${BTN}">Go to Dashboard →</a>
  ${HR}
  <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
    If you need any help with setup or installation, simply reply to this email and our team will be happy to assist.
  </p>
  <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
  `
);

const res = await fetch('https://api.brevo.com/v3/smtp/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'api-key': apiKey, accept: 'application/json' },
  body: JSON.stringify({
    sender: { email: fromEmail, name: fromName },
    to: [{ email: to, name: to }],
    subject,
    htmlContent: html,
  }),
});
console.log(`${subject} → ${res.status} ${await res.text()}`);
if (!res.ok) process.exitCode = 1;
