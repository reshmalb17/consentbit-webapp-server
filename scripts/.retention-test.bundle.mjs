// src/services/email.js
async function sendBrevoEmail(env2, { to: to2, name, subject, html, text, attachment }) {
  const apiKey = env2.BREVO_API_KEY;
  const fromEmail = env2.BREVO_FROM_EMAIL;
  const fromName = env2.BREVO_FROM_NAME || "ConsentBit";
  if (!apiKey) {
    console.warn("[Email] BREVO_API_KEY not set \u2014 skipping email");
    return;
  }
  if (!fromEmail) {
    console.warn("[Email] BREVO_FROM_EMAIL not set \u2014 skipping email");
    return;
  }
  const payload = {
    sender: { email: fromEmail, name: fromName },
    // email.consentbit.com has no MX — route replies to the monitored support inbox.
    replyTo: { email: env2.BREVO_REPLY_TO || "web@consentbit.com", name: fromName },
    to: [{ email: to2, name: name || to2 }],
    subject,
    htmlContent: html,
    textContent: text
  };
  if (Array.isArray(attachment) && attachment.length) {
    payload.attachment = attachment;
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": apiKey,
      accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[Email] Brevo send failed", { status: res.status, to: to2, subject, snippet: body.slice(0, 300) });
  } else {
  }
}
var MUTED_EMAIL_RECIPIENTS = [
  "@platanhotels.pl"
];
function isEmailMuted(to2) {
  const addr = String(to2 || "").trim().toLowerCase();
  if (!addr) return false;
  return MUTED_EMAIL_RECIPIENTS.some((m) => m.startsWith("@") ? addr.endsWith(m) : addr === m);
}
function skipMuted(kind, to2) {
  if (!isEmailMuted(to2)) return false;
  console.log(`[Email] ${kind} skipped \u2014 recipient is muted`, { to: to2 });
  return true;
}
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
                ConsentBit \xB7 Cookie Consent Management<br/>
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
var BTN = "display:inline-block;background:#007AFF;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;";
var HR = '<div style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;"></div>';
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function formatEmailDate(ymd) {
  const d = /* @__PURE__ */ new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ymd || "");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function sendRetentionReminderEmail(env2, ctx, { to: to2, name, domain, kind, count, date, from, until, cutoff }) {
  if (skipMuted("sendRetentionReminderEmail", to2)) return;
  const displayName = escapeHtml(name || "there");
  const displayDomain = escapeHtml(domain || "your website");
  const webappUrl = (env2.WEBAPP_PUBLIC_URL || "https://accounts.consentbit.com").replace(/\/$/, "");
  const n = Number(count) || 0;
  const records = `${n.toLocaleString("en-US")} consent record${n === 1 ? "" : "s"}`;
  const onDate = formatEmailDate(date);
  const P = "margin:0 0 18px;color:#6b7280;font-size:15px;line-height:1.6;";
  const ST = "color:#111827;";
  const downloadHow = "Dashboard \u2192 Consent Logs \u2192 choose the month \u2192 Download";
  let subject, preheader, bodyHtml, bodyText;
  if (kind === "free") {
    const fromDate = formatEmailDate(from);
    const toDate = formatEmailDate(until);
    subject = `Consent records for ${domain || "your website"} will be hidden from ${onDate}`;
    preheader = `${records} for ${domain || "your website"} will pass the Free plan's 3-month limit from ${onDate}.`;
    bodyHtml = `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="${P}">
      Your site <strong style="${ST}">${displayDomain}</strong> is on the ConsentBit Free plan, which shows
      consent records from the last 3 months.
    </p>
    <p style="${P}">
      From <strong style="${ST}">${onDate}</strong>, <strong style="${ST}">${records}</strong> collected between
      ${fromDate} and ${toDate} will be older than 3 months and will no longer be visible in your dashboard.
    </p>
    <p style="margin:0 0 22px;color:#111827;font-size:15px;line-height:1.6;font-weight:600;">
      Upgrade to a Pro plan to keep your consent records for 12 months
      (24 months for US privacy-law records).
    </p>
    <a href="${webappUrl}/dashboard" style="${BTN}">Upgrade plan \u2192</a>
    ${HR}
    <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
      Need a copy? Download these records before ${onDate}: ${downloadHow}.
    </p>`;
    bodyText = `Your site ${domain || "your website"} is on the ConsentBit Free plan, which shows consent records from the last 3 months.

From ${onDate}, ${records} collected between ${fromDate} and ${toDate} will be older than 3 months and will no longer be visible in your dashboard.

Upgrade to a Pro plan to keep your consent records for 12 months (24 months for US privacy-law records).

Upgrade plan: ${webappUrl}/dashboard

Need a copy? Download these records before ${onDate}: ${downloadHow}.`;
  } else {
    const cutoffDate = formatEmailDate(cutoff);
    subject = `Consent records for ${domain || "your website"} reach the end of their retention period on ${onDate}`;
    preheader = `${records} for ${domain || "your website"} will be removed on ${onDate}. Download a copy before then.`;
    bodyHtml = `
    <p style="margin:0 0 14px;color:#111827;font-size:15px;line-height:1.6;">Hi ${displayName},</p>
    <p style="${P}">
      ConsentBit keeps consent records for 12 months (24 months for records collected under US privacy laws).
    </p>
    <p style="${P}">
      On <strong style="${ST}">${onDate}</strong>, <strong style="${ST}">${records}</strong> for
      <strong style="${ST}">${displayDomain}</strong> collected before ${cutoffDate} will be removed from your account.
    </p>
    <p style="${P}">
      If you need them for your own records or for an audit, <strong style="${ST}">download and keep a copy
      before ${onDate}</strong>: ${downloadHow}.
    </p>
    ${HR}
    <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">
      After ${onDate}, these records will no longer be available in your dashboard.
    </p>`;
    bodyText = `ConsentBit keeps consent records for 12 months (24 months for records collected under US privacy laws).

On ${onDate}, ${records} for ${domain || "your website"} collected before ${cutoffDate} will be removed from your account.

If you need them for your own records or for an audit, download and keep a copy before ${onDate}: ${downloadHow}.

After ${onDate}, these records will no longer be available in your dashboard.`;
  }
  const html = layout(preheader, `${bodyHtml}
    <p style="margin:18px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">Best regards,<br/>ConsentBit Team</p>`);
  const text = `Hi ${name || "there"},

${bodyText}

Best regards,
ConsentBit Team
`;
  const send = sendBrevoEmail(env2, { to: to2, name, subject, html, text }).catch((e) => console.error("[Email] sendRetentionReminderEmail failed:", e?.message));
  if (ctx?.waitUntil) ctx.waitUntil(send);
  return send;
}

// scripts/send-retention-reminder-test.mjs
var to = process.argv[2] || "reshma@seattlenewmedia.com";
var env = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_FROM_EMAIL: process.env.BREVO_FROM_EMAIL || "web@email.consentbit.com",
  BREVO_FROM_NAME: process.env.BREVO_FROM_NAME || "ConsentBit",
  WEBAPP_PUBLIC_URL: "https://accounts.consentbit.com"
};
if (!env.BREVO_API_KEY) {
  console.error("Missing BREVO_API_KEY env var. Set it then re-run.");
  process.exit(1);
}
var realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url, opts);
  const body = await res.clone().text().catch(() => "");
  console.log(`[${JSON.parse(opts.body).subject}] \u2192 ${res.status} ${body}`);
  return res;
};
await sendRetentionReminderEmail(env, null, {
  to,
  name: "Reshma",
  domain: "example.com",
  kind: "free",
  count: 128,
  date: "2026-11-01",
  from: "2026-08-01",
  until: "2026-08-14"
});
await sendRetentionReminderEmail(env, null, {
  to,
  name: "Reshma",
  domain: "example.com",
  kind: "paid",
  count: 2450,
  date: "2026-11-01",
  cutoff: "2025-11-01"
});
