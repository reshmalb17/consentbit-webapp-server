/**
 * src/services/email.js
 *
 * Transactional email service via Brevo (https://app.brevo.com).
 *
 * Required env vars (set in Cloudflare dashboard → Worker → Settings → Variables):
 *   BREVO_API_KEY      — your Brevo API key (v3)
 *   BREVO_FROM_EMAIL   — verified sender address, e.g. hello@consentbit.com
 *   BREVO_FROM_NAME    — sender display name, defaults to "ConsentBit"
 *   WEBAPP_PUBLIC_URL  — production webapp URL, e.g. https://app.consentbit.com
 *
 * Three emails are sent automatically:
 *   1. Welcome       — immediately after a new user completes OTP signup
 *   2. Free plan     — after first-setup creates their first site
 *   3. Paid plan     — after Stripe checkout.session.completed is processed
 */

// ---------------------------------------------------------------------------
// Core Brevo HTTP helper
// ---------------------------------------------------------------------------

/**
 * Send a single transactional email via the Brevo v3 API.
 *
 * @param {object} env  Cloudflare Worker env bindings
 * @param {{ to: string, name?: string, subject: string, html: string, text: string }} opts
 */
export async function sendBrevoEmail(env, { to, name, subject, html, text }) {
  const apiKey   = env.BREVO_API_KEY;
  const fromEmail = env.BREVO_FROM_EMAIL;
  const fromName  = env.BREVO_FROM_NAME || 'ConsentBit';

  if (!apiKey)    { console.warn('[Email] BREVO_API_KEY not set — skipping email'); return; }
  if (!fromEmail) { console.warn('[Email] BREVO_FROM_EMAIL not set — skipping email'); return; }

  const payload = {
    sender:      { email: fromEmail, name: fromName },
    to:          [{ email: to, name: name || to }],
    subject,
    htmlContent: html,
    textContent: text,
  };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'content-type': 'application/json',
      'api-key':       apiKey,
      accept:          'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[Email] Brevo send failed', { status: res.status, to, subject, snippet: body.slice(0, 300) });
  } else {
  }
}

// ---------------------------------------------------------------------------
// Shared layout wrapper
// ---------------------------------------------------------------------------

function layout(preheader, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ConsentBit</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <!-- preheader text (hidden in body, shown in inbox preview) -->
  <span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</span>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:600px;" cellpadding="0" cellspacing="0">

          <!-- Card -->
          <tr>
            <td style="background:#ffffff;border-radius:16px;padding:40px 40px 32px;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding:24px 0 8px;">
              <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
                ConsentBit · Cookie Consent Management<br/>
                You're receiving this because you signed up at consentbit.com.<br/>
                <a href="https://consentbit.com" style="color:#9ca3af;text-decoration:none;">Visit website</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Shared button style
const BTN = 'display:inline-block;background:#007AFF;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;';

// Divider
const HR = '<div style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;"></div>';

// ---------------------------------------------------------------------------
// 1. Welcome email — sent on successful OTP signup
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {ExecutionContext|null} ctx   Pass Worker ctx so email fires in background
 * @param {{ to: string, name: string }} opts
 */
export function sendWelcomeEmail(env, ctx, { to, name }) {
  const displayName = name || 'there';
  const dashboardUrl = (env.WEBAPP_PUBLIC_URL || 'https://accounts.consentbit.com').replace(/\/$/, '') + '/dashboard';

  const subject = `Welcome to ConsentBit, ${name || 'there'}!`;

  const html = layout(
    `Welcome to ConsentBit. Your account is ready — let's get you set up.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Welcome to ConsentBit; we're excited to have you onboard.
    </p>
    <p style="margin:0 0 20px;color:#6b7280;font-size:15px;line-height:1.6;">
      Your account has been successfully created, and you're just a few quick steps away from making your website compliant and ready to go.
    </p>

    ${HR}

    <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">Getting started is simple:</p>

    <ul style="margin:0 0 22px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>Add your website domain</li>
      <li>Choose a plan; you can start with our Free Plan</li>
      <li>Copy and paste a single script into your website</li>
    </ul>

    <p style="margin:0 0 22px;color:#6b7280;font-size:14px;line-height:1.6;">
      That's it — your cookie consent banner can be live within minutes.
    </p>

    <a href="${dashboardUrl}" style="${BTN}">Go to Your Dashboard →</a>

    ${HR}

    <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
      If you have any questions or need assistance along the way, feel free to reply to this email. We're here to help.
    </p>
    `
  );

  const text = `Hi ${displayName},

Welcome to ConsentBit; we're excited to have you onboard.

Your account has been successfully created, and you're just a few quick steps away from making your website compliant and ready to go.

Getting started is simple:
- Add your website domain
- Choose a plan; you can start with our Free Plan
- Copy and paste a single script into your website

That's it — your cookie consent banner can be live within minutes.

Go to Your Dashboard: ${dashboardUrl}

If you have any questions or need assistance along the way, feel free to reply to this email. We're here to help.

Best regards,
ConsentBit Team
`;

  const send = sendBrevoEmail(env, { to, name, subject, html, text })
    .catch(e => console.error('[Email] sendWelcomeEmail failed:', e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}

// ---------------------------------------------------------------------------
// 2. Free plan email — sent after first-setup creates the site
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {ExecutionContext|null} ctx
 * @param {{ to: string, name: string, domain: string, scriptUrl: string }} opts
 */
export function sendFreePlanEmail(env, ctx, { to, name, domain, scriptUrl }) {
  const displayName  = name || 'there';
  const displayDomain = domain || 'your website';
  const dashboardUrl  = (env.WEBAPP_PUBLIC_URL || 'https://accounts.consentbit.com').replace(/\/$/, '') + '/dashboard';
  // Break the "://" and "." patterns with empty <span>s so email clients
  // (Gmail/Apple Mail/Outlook) stop auto-linking the URL. The spans render
  // as nothing and contribute no characters when the text is selected/copied,
  // so the user gets a clean, selectable snippet instead of a link that
  // navigates to the raw .js file.
  const noAutoLink = (url) =>
    String(url)
      .replace('://', ':<span></span>//')
      .replace(/\.(?=[a-z]{2,})/gi, '<span></span>.');
  const snippet = scriptUrl
    ? `&lt;script id="consentbit" src="${noAutoLink(scriptUrl)}" async&gt;&lt;/script&gt;`
    : '&lt;script id="consentbit" src="YOUR_SCRIPT_URL" async&gt;&lt;/script&gt;';

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

  const text = `Hi ${displayName},

Good news; your website, ${displayDomain}, has been successfully set up on the ConsentBit Free Plan.

To activate your cookie consent banner, simply copy and paste the script below into the <head> section of your website:

<!-- ConsentBit -->
<script id="consentbit" src="${scriptUrl || 'YOUR_SCRIPT_URL'}" async></script>

Your Free Plan includes:
- 1 domain
- 7,500 page views per month
- 100 cookie scans
- GDPR & CCPA compliance support

As your website grows, you can upgrade your plan anytime to unlock additional features and higher limits.

Go to Dashboard: ${dashboardUrl}

If you need any help with setup or installation, simply reply to this email and our team will be happy to assist.

Best regards,
ConsentBit Team
`;

  const send = sendBrevoEmail(env, { to, name, subject, html, text })
    .catch(e => console.error('[Email] sendFreePlanEmail failed:', e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}

// ---------------------------------------------------------------------------
// 3. Paid plan email — sent after Stripe checkout.session.completed
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {ExecutionContext|null} ctx
 * @param {{
 *   to: string, name: string, domain: string, planName: string,
 *   invoice?: { invoiceNumber, invoiceUrl, invoicePdf, amountPaid, currency, date, interval } | null
 * }} opts
 */
export function sendPaidPlanEmail(env, ctx, { to, name, domain, planName, invoice = null, variant = 'default' }) {
  const displayName   = name || 'there';
  const displayDomain = domain || 'your website';
  const displayPlan   = planName || 'Basic';
  const dashboardUrl  = (env.WEBAPP_PUBLIC_URL || 'https://accounts.consentbit.com').replace(/\/$/, '') + '/dashboard';
  const loginEmail    = to || 'your email';
  const isTcf         = variant === 'tcf';


  // Invoice section HTML
  const invoiceHtml = invoice ? `
    ${HR}
    <p style="margin:0 0 12px;color:#111827;font-size:14px;font-weight:700;">Invoice Details</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:#f9fafb;border-radius:8px;padding:16px 20px;margin-bottom:20px;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:6px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${invoice.invoiceNumber ? `<tr><td style="color:#6b7280;font-size:13px;width:140px;">Invoice Number</td><td style="color:#111827;font-size:13px;font-weight:600;">${invoice.invoiceNumber}</td></tr>` : ''}
            ${invoice.date         ? `<tr><td style="color:#6b7280;font-size:13px;padding-top:6px;">Billing Date</td><td style="color:#111827;font-size:13px;padding-top:6px;">${invoice.date}</td></tr>` : ''}
            ${invoice.amountPaid   ? `<tr><td style="color:#6b7280;font-size:13px;padding-top:6px;">Amount Paid</td><td style="color:#111827;font-size:13px;font-weight:600;padding-top:6px;">${invoice.currency} ${invoice.amountPaid}</td></tr>` : ''}
            ${invoice.interval     ? `<tr><td style="color:#6b7280;font-size:13px;padding-top:6px;">Billing Cycle</td><td style="color:#111827;font-size:13px;padding-top:6px;text-transform:capitalize;">${invoice.interval}</td></tr>` : ''}
          </table>
        </td>
      </tr>
    </table>
    ${invoice.invoicePdf || invoice.invoiceUrl ? `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        ${invoice.invoicePdf    ? `<td style="padding-right:12px;"><a href="${invoice.invoicePdf}" style="${BTN}font-size:14px;padding:10px 22px;" target="_blank">⬇ Download Invoice PDF</a></td>` : ''}
        ${invoice.invoiceUrl    ? `<td><a href="${invoice.invoiceUrl}" style="display:inline-block;background:#f3f4f6;color:#111827;text-decoration:none;font-size:14px;font-weight:600;padding:10px 22px;border-radius:8px;border:1px solid #e5e7eb;" target="_blank">View Invoice Online →</a></td>` : ''}
      </tr>
    </table>` : ''}
  ` : '';

  // Invoice plain text
  const invoiceText = invoice ? `
--- Invoice Details ---
${invoice.invoiceNumber ? `Invoice Number: ${invoice.invoiceNumber}` : ''}
${invoice.date         ? `Billing Date: ${invoice.date}` : ''}
${invoice.amountPaid   ? `Amount Paid: ${invoice.currency} ${invoice.amountPaid}` : ''}
${invoice.interval     ? `Billing Cycle: ${invoice.interval}` : ''}
${invoice.invoicePdf   ? `Download Invoice PDF: ${invoice.invoicePdf}` : ''}
${invoice.invoiceUrl   ? `View Invoice Online: ${invoice.invoiceUrl}` : ''}
` : '';

  // --- IAB/TCF setup variant (Essential/Growth purchased via Webflow/Framer app) ---
  if (isTcf) {
    const subject = `Your ${displayPlan} plan is active — enable your IAB TCF banner`;

    const html = layout(
      `Your ${displayPlan} plan is active. Log in to add your IAB/TCF consent banner.`,
      `
      <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
      <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
        Thank you for choosing <strong style="color:#111827;">ConsentBit ${displayPlan}</strong> for
        <strong style="color:#111827;">${displayDomain}</strong> — your plan is now active.
      </p>
      <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">
        Your plan includes the <strong style="color:#111827;">IAB TCF (Transparency &amp; Consent Framework) banner</strong> —
        the IAB-compliant consent banner required for sites running Google-certified ad partners and TCF vendors.
      </p>

      ${HR}

      <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:700;">Enable it from your dashboard</p>
      <p style="margin:0 0 16px;color:#6b7280;font-size:14px;line-height:1.6;">
        The TCF banner is set up in your ConsentBit dashboard (not from the Webflow/Framer app). Here's how:
      </p>
      <ol style="margin:0 0 22px;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
        <li>Go to <strong>accounts.consentbit.com</strong> and log in with this email — <strong style="color:#111827;">${loginEmail}</strong>. <span style="color:#9ca3af;">(Your account is already created; just request a login code if it's your first time.)</span></li>
        <li>Open your site, <strong>${displayDomain}</strong>, and go to <strong>Cookie Banner</strong>.</li>
        <li>In the <strong>General</strong> tab, find the <strong>"Support IAB TCF v2.3"</strong> card and turn on <strong>"Enable IAB TCF Support"</strong>.</li>
      </ol>

      <a href="${dashboardUrl}" style="${BTN}">Open Dashboard →</a>

      ${invoiceHtml}

      ${HR}

      <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
        If you need a hand setting up the TCF banner or choosing vendors, just reply to this email and our team will help you get it live.
      </p>
      <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
      `
    );

    const text = `Hi ${displayName},

Thank you for choosing ConsentBit ${displayPlan} for ${displayDomain} — your plan is now active.

Your plan includes the IAB TCF (Transparency & Consent Framework) banner — the IAB-compliant consent banner required for sites running Google-certified ad partners and TCF vendors.

Enable it from your dashboard (not from the Webflow/Framer app):

1. Go to accounts.consentbit.com and log in with this email — ${loginEmail}.
   (Your account is already created; request a login code if it's your first time.)
2. Open your site, ${displayDomain}, and go to Cookie Banner.
3. In the General tab, find the "Support IAB TCF v2.3" card and turn on "Enable IAB TCF Support".

Open your dashboard: ${dashboardUrl}
${invoiceText}
If you need a hand setting up the TCF banner or choosing vendors, just reply to this email and our team will help.

Best regards,
ConsentBit Team
`;

    const send = sendBrevoEmail(env, { to, name, subject, html, text })
      .catch(e => console.error('[Email] sendPaidPlanEmail (tcf) failed:', e?.message));

    if (ctx?.waitUntil) ctx.waitUntil(send);
    return;
  }

  const subject = `You're all set on the ${displayPlan} plan`;

  const html = layout(
    `Your ${displayPlan} plan is active.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Thank you for choosing ConsentBit.
    </p>
    <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">
      Your <strong style="color:#111827;">${displayPlan}</strong> plan has been successfully activated for
      <strong style="color:#111827;">${displayDomain}</strong>, and your account is now ready to use.
    </p>
    <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">
      Your plan includes features designed to help you manage cookie consent and compliance efficiently. Available features may vary depending on your selected plan (Basic, Essential, or Growth).
    </p>

    ${invoiceHtml}

    <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
      If you need any assistance or have questions about your subscription, simply reply to this email and our team will be glad to help.
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
    `
  );

  const text = `Hi ${displayName},

Thank you for choosing ConsentBit.

Your ${displayPlan} plan has been successfully activated for ${displayDomain}, and your account is now ready to use.

Your plan includes features designed to help you manage cookie consent and compliance efficiently. Available features may vary depending on your selected plan (Basic, Essential, or Growth).
${invoiceText}
If you need any assistance or have questions about your subscription, simply reply to this email and our team will be glad to help.

Best regards,
ConsentBit Team
`;

  const send = sendBrevoEmail(env, { to, name, subject, html, text })
    .catch(e => console.error('[Email] sendPaidPlanEmail failed:', e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}

// ---------------------------------------------------------------------------
// 4. Scan limit reached — sent once per month when scheduled scans are blocked
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Cancellation confirmation — sent immediately when user cancels
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {ExecutionContext|null} ctx
 * @param {{ to: string, name: string }} opts
 */
export function sendCancellationEmail(env, ctx, { to, name }) {
  const displayName = name || 'there';

  const subject = `Your ConsentBit Subscription Has Been Cancelled`;

  const html = layout(
    `Your ConsentBit subscription has been cancelled successfully.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Your ConsentBit subscription has been cancelled successfully.
    </p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      You will retain access to your current plan until the end of your billing period.
    </p>

    ${HR}

    <p style="margin:0 0 18px;color:#6b7280;font-size:14px;line-height:1.6;">
      If you have any feedback or need assistance in the future, feel free to reach out — we're always happy to help.
    </p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:14px;line-height:1.6;">
      Thank you for trying ConsentBit.
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>Team ConsentBit</p>
    `
  );

  const text = `Hi ${displayName},

Your ConsentBit subscription has been cancelled successfully.

You will retain access to your current plan until the end of your billing period.

If you have any feedback or need assistance in the future, feel free to reach out — we're always happy to help.

Thank you for trying ConsentBit.

Best regards,
Team ConsentBit
`;

  const send = sendBrevoEmail(env, { to, name, subject, html, text })
    .catch(e => console.error('[Email] sendCancellationEmail failed:', e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}

// ---------------------------------------------------------------------------
// 6. Payment failure reminders (1 = gentle, 2 = follow-up, 3 = final)
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {ExecutionContext|null} ctx
 * @param {{ to: string, name: string, updatePaymentUrl?: string, reminderNumber: 1|2|3 }} opts
 */
export function sendPaymentFailureEmail(env, ctx, { to, name, updatePaymentUrl, reminderNumber = 1 }) {
  const displayName   = name || 'there';
  const billingUrl    = updatePaymentUrl || ((env.WEBAPP_PUBLIC_URL || 'https://app.consentbit.com').replace(/\/$/, '') + '/billing');

  const configs = {
    1: {
      subject: `Action required: Payment failed for your ConsentBit subscription`,
      preheader: `We were unable to process your recent payment. Please update your payment details.`,
      intro: `We were unable to process your recent payment for your ConsentBit subscription.`,
      detail: `This may be due to an expired card or insufficient funds.`,
      body: `Please update your payment details to avoid any interruption in your service.`,
      note: `If you've already updated your payment, you can ignore this message.`,
    },
    2: {
      subject: `Reminder: Your ConsentBit payment is still outstanding`,
      preheader: `Just a quick reminder — your recent payment attempt was unsuccessful.`,
      intro: `Just a quick reminder that your recent payment attempt for your ConsentBit subscription was unsuccessful.`,
      detail: null,
      body: `To ensure uninterrupted access to your services, please update your payment details as soon as possible.`,
      note: `If you need any help, feel free to reach out — we're happy to assist.`,
    },
    3: {
      subject: `Final notice: Update your payment to keep your ConsentBit subscription active`,
      preheader: `Final reminder — please update your payment details to avoid suspension.`,
      intro: `This is a final reminder regarding your failed payment.`,
      detail: `If we're unable to process your payment soon, your ConsentBit subscription may be suspended.`,
      body: `To continue using the service without interruption, please update your payment details immediately.`,
      note: `If you've already resolved this, please ignore this message.`,
    },
  };

  const cfg = configs[reminderNumber] || configs[1];

  const html = layout(
    cfg.preheader,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      ${cfg.intro}
    </p>
    ${cfg.detail ? `<p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">${cfg.detail}</p>` : ''}
    <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">
      ${cfg.body}
    </p>

    <a href="${billingUrl}" style="${BTN}">Update Payment Method →</a>

    ${HR}

    <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
      ${cfg.note}
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>Support Team</p>
    `
  );

  const text = `Hi ${displayName},

${cfg.intro}
${cfg.detail ? `\n${cfg.detail}\n` : ''}
${cfg.body}

Update your payment method: ${billingUrl}

${cfg.note}

Best regards,
Support Team
`;

  const send = sendBrevoEmail(env, { to, name, subject: cfg.subject, html, text })
    .catch(e => console.error(`[Email] sendPaymentFailureEmail (reminder ${reminderNumber}) failed:`, e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}

// ---------------------------------------------------------------------------
// 4. Scan limit reached — sent once per month when scheduled scans are blocked
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {ExecutionContext|null} ctx
 * @param {{ to: string, name: string, domain: string, scansLimit: number, upgradeUrl?: string }} opts
 */
export function sendScanLimitEmail(env, ctx, { to, name, domain, scansLimit, upgradeUrl }) {
  const displayName   = name || 'there';
  const displayDomain = domain || 'your website';
  const billingUrl    = upgradeUrl || ((env.WEBAPP_PUBLIC_URL || 'https://app.consentbit.com').replace(/\/$/, '') + '/billing');

  const subject = `Your scheduled scan was paused; scan limit reached`;

  const html = layout(
    `Your scheduled cookie scan for ${displayDomain} was paused because you've reached your monthly scan limit.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Your scheduled cookie scan for <strong style="color:#111827;">${displayDomain}</strong> has been paused
      because you've reached the maximum number of scans included in your current plan for this month.
    </p>
    <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">
      Don't worry — your scan schedule is still active and will automatically resume at the beginning of next month when your quota resets.
      You can also resume scanning immediately by upgrading your plan.
    </p>

    ${HR}

    <p style="margin:0 0 12px;color:#111827;font-size:14px;font-weight:600;">What you can do next:</p>
    <ul style="margin:0 0 22px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>Wait until the 1st of next month; your scheduled scans will resume automatically</li>
      <li>Upgrade your plan to unlock additional scans instantly</li>
    </ul>

    <a href="${billingUrl}" style="${BTN}">Upgrade Plan</a>

    ${HR}

    <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
      If you have any questions, feel free to reply to this email and our team will be happy to help.
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
    `
  );

  const text = `Hi ${displayName},

Your scheduled cookie scan for ${displayDomain} has been paused because you've reached the maximum number of scans included in your current plan for this month.

Don't worry — your scan schedule is still active and will automatically resume at the beginning of next month when your quota resets. You can also resume scanning immediately by upgrading your plan.

What you can do next:
- Wait until the 1st of next month; your scheduled scans will resume automatically
- Upgrade your plan to unlock additional scans instantly

Upgrade Plan: ${billingUrl}

If you have any questions, feel free to reply to this email and our team will be happy to help.

Best regards,
ConsentBit Team
`;

  const send = sendBrevoEmail(env, { to, name, subject, html, text })
    .catch(e => console.error('[Email] sendScanLimitEmail failed:', e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}

