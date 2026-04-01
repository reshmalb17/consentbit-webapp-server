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
    console.log('[Email] Sent', { subject, to });
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

          <!-- Logo header -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="background:#007AFF;border-radius:10px;padding:10px 20px;">
                    <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.3px;">ConsentBit</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

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
  const dashboardUrl = (env.WEBAPP_PUBLIC_URL || 'https://app.consentbit.com').replace(/\/$/, '') + '/dashboard';

  const subject = `Welcome to ConsentBit, ${name || 'there'}!`;

  const html = layout(
    `Welcome to ConsentBit. Your account is ready — let's get you set up.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Welcome to ConsentBit. We are glad to have you with us.
    </p>
    <p style="margin:0 0 20px;color:#6b7280;font-size:15px;line-height:1.6;">
      Your account is ready, and you’re just a few quick steps away from getting your site compliant and running smoothly.
    </p>

    ${HR}

    <p style="margin:0 0 12px;color:#111827;font-size:15px;font-weight:600;">Here’s how to get started:</p>

    <ul style="margin:0 0 22px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>Add your website (domain)</li>
      <li>Choose a plan (you can start free)</li>
      <li>Paste one simple script on your site</li>
    </ul>

    <p style="margin:0 0 22px;color:#6b7280;font-size:14px;line-height:1.6;">
      That’s it, your cookie consent banner will be live in minutes.
    </p>

    <a href="${dashboardUrl}" style="${BTN}">Go to your Dashboard →</a>

    ${HR}

    <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
      If you need help at any point, just reply to this email or visit:
      <a href="https://consentbit.com/docs" style="color:#007AFF;text-decoration:none;">https://consentbit.com/docs</a>
    </p>
    `
  );

  const text = `Hi ${displayName},

Welcome to ConsentBit. We are glad to have you with us.

Your account is ready, and you’re just a few quick steps away from getting your site compliant and running smoothly.

Here’s how to get started:
- Add your website (domain)
- Choose a plan (you can start free)
- Paste one simple script on your site

That’s it, your cookie consent banner will be live in minutes.

Go to your dashboard: ${dashboardUrl}

If you need help at any point, just reply to this email or visit:
https://consentbit.com/docs

Best,
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
  const dashboardUrl  = (env.WEBAPP_PUBLIC_URL || 'https://app.consentbit.com').replace(/\/$/, '') + '/dashboard';
  const snippet = scriptUrl
    ? `&lt;script id="consentbit" src="${scriptUrl}" async&gt;&lt;/script&gt;`
    : '&lt;script id="consentbit" src="YOUR_SCRIPT_URL" async&gt;&lt;/script&gt;';

  const subject = `Your site is ready: ${displayDomain}`;

  const html = layout(
    `Your site is ready on the free plan.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 20px;color:#6b7280;font-size:15px;line-height:1.6;">
      Good news, your site <strong style="color:#111827;">${displayDomain}</strong> is all set up on the free plan.
    </p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      To get your consent banner live, just copy and paste the script below into your website’s
      <code style="font-size:13px;background:#f3f4f6;padding:2px 6px;border-radius:4px;">&lt;head&gt;</code> section:
    </p>

    ${HR}

    <p style="margin:0 0 10px;color:#111827;font-size:14px;font-weight:600;">Installation script</p>
    <div style="background:#1e293b;border-radius:8px;padding:16px 20px;margin-bottom:24px;overflow:hidden;">
      <code style="color:#7dd3fc;font-size:13px;font-family:'Courier New',Courier,monospace;line-height:1.6;word-break:break-all;">
        &lt;!-- ConsentBit --&gt;<br/>
        ${snippet}
      </code>
    </div>

    <p style="margin:0 0 18px;color:#6b7280;font-size:14px;line-height:1.6;">
      Once added, your banner will be up and running in minutes.
    </p>

    <a href="${dashboardUrl}" style="${BTN}">Customize your banner →</a>

    ${HR}

    <p style="margin:0 0 10px;color:#111827;font-size:14px;font-weight:700;">Your Free Plan includes:</p>
    <ul style="margin:0 0 18px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>1 domain</li>
      <li>7,500 page views/month</li>
      <li>100 cookie scans</li>
      <li>GDPR &amp; CCPA compliance</li>
    </ul>

    <p style="margin:0 0 18px;color:#6b7280;font-size:14px;line-height:1.6;">
      Need more as you grow? You can upgrade anytime.
    </p>
    <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
      Thanks for getting started with ConsentBit, we’re here if you need anything.
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best,<br/>ConsentBit Team</p>
    `
  );

  const text = `Hi ${displayName},

Good news, your site ${displayDomain} is all set up on the free plan.

To get your consent banner live, just copy and paste the script below into your website’s <head> section:

<!-- ConsentBit -->
<script id="consentbit" src="${scriptUrl || 'YOUR_SCRIPT_URL'}" async></script>

Once added, your banner will be up and running in minutes.

Customize your banner here: ${dashboardUrl}

Your Free Plan includes:
- 1 domain
- 7,500 page views/month
- 100 cookie scans
- GDPR & CCPA compliance

Need more as you grow? You can upgrade anytime.

Thanks for getting started with ConsentBit, we’re here if you need anything.

Best,
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
 * @param {{ to: string, name: string, domain: string, planName: string }} opts
 */
export function sendPaidPlanEmail(env, ctx, { to, name, domain, planName }) {
  const displayName   = name || 'there';
  const displayDomain = domain || 'your website';
  const displayPlan   = planName || 'Basic';
  const dashboardUrl  = (env.WEBAPP_PUBLIC_URL || 'https://app.consentbit.com').replace(/\/$/, '') + '/dashboard';

  // Plan-specific feature bullets
  const planFeatures = {
    basic:     ['1 domain', '100,000 page views / month', '750 cookie scans', 'GDPR &amp; CCPA', 'Email support'],
    essential: ['1 domain', '500,000 page views / month', '5,000 cookie scans', 'GDPR + CCPA + IAB/TCF', 'Priority support'],
    growth:    ['1 domain', '2M page views / month', '10,000 cookie scans', 'GDPR + CCPA + IAB/TCF', 'Dedicated support'],
  };
  const features = planFeatures[displayPlan.toLowerCase()] || planFeatures.basic;

  const subject = `You’re all set on the ${displayPlan} plan.`;

  const html = layout(
    `Your ${displayPlan} plan is active.`,
    `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;">
      Thanks for your purchase, your <strong style="color:#111827;">${displayPlan}</strong> plan is now active for
      <strong style="color:#111827;">${displayDomain}</strong>.
    </p>
    <p style="margin:0 0 22px;color:#6b7280;font-size:15px;line-height:1.6;">
      You now have access to everything included in your plan to keep your site fully compliant and running at scale.
    </p>

    ${HR}

    <p style="margin:0 0 10px;color:#111827;font-size:14px;font-weight:700;">Here’s what your plan includes:</p>

    <p style="margin:0 0 8px;color:#111827;font-size:13px;font-weight:700;">Basic Plan</p>
    <ul style="margin:0 0 16px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>1 domain</li>
      <li>100,000 page views/month</li>
      <li>750 cookie scans</li>
      <li>GDPR &amp; CCPA</li>
      <li>Email support</li>
    </ul>

    <p style="margin:0 0 8px;color:#111827;font-size:13px;font-weight:700;">Essential Plan</p>
    <ul style="margin:0 0 16px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>1 domain</li>
      <li>500,000 page views/month</li>
      <li>5,000 cookie scans</li>
      <li>GDPR, CCPA &amp; IAB/TCF</li>
      <li>Priority support</li>
    </ul>

    <p style="margin:0 0 8px;color:#111827;font-size:13px;font-weight:700;">Growth Plan</p>
    <ul style="margin:0 0 22px;padding-left:18px;color:#374151;font-size:14px;line-height:1.7;">
      <li>1 domain</li>
      <li>2M page views/month</li>
      <li>10,000 cookie scans</li>
      <li>GDPR, CCPA &amp; IAB/TCF</li>
      <li>Dedicated support</li>
    </ul>

    <a href="${dashboardUrl}" style="${BTN}">Go to your dashboard →</a>

    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">
      If you have any questions or need help, just reply, we’re happy to help.
    </p>
    <p style="margin:12px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">
      Thanks again for choosing ConsentBit.
    </p>
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>
    `
  );

  const text = `Hi ${displayName},

Thanks for your purchase, your ${displayPlan} plan is now active for ${displayDomain}.

You now have access to everything included in your plan to keep your site fully compliant and running at scale.

Here’s what your plan includes:

Basic Plan
- 1 domain
- 100,000 page views/month
- 750 cookie scans
- GDPR & CCPA
- Email support

Essential Plan
- 1 domain
- 500,000 page views/month
- 5,000 cookie scans
- GDPR, CCPA & IAB/TCF
- Priority support

Growth Plan
- 1 domain
- 2M page views/month
- 10,000 cookie scans
- GDPR, CCPA & IAB/TCF
- Dedicated support

Go to your dashboard: ${dashboardUrl}

If you have any questions or need help, just reply, we’re happy to help.

Thanks again for choosing ConsentBit.

Best regards,
ConsentBit Team
`;

  const send = sendBrevoEmail(env, { to, name, subject, html, text })
    .catch(e => console.error('[Email] sendPaidPlanEmail failed:', e?.message));

  if (ctx?.waitUntil) ctx.waitUntil(send);
}
