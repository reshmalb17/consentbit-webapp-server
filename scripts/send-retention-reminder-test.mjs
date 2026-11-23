// One-off tester: sends BOTH retention reminder emails (Free + Pro) using the real
// template, src/services/email.js sendRetentionReminderEmail(), with sample data.
//
// consent-manager's package.json is CommonJS, so bundle first, then run:
//   npx esbuild scripts/send-retention-reminder-test.mjs --bundle --platform=node --format=esm --outfile=scripts/.retention-test.bundle.mjs
//   $env:BREVO_API_KEY="xkeysib-..."; node scripts/.retention-test.bundle.mjs reshma@seattlenewmedia.com
//
// Optional env: BREVO_FROM_EMAIL (default web@email.consentbit.com), BREVO_FROM_NAME (default ConsentBit)

import { sendRetentionReminderEmail } from '../src/services/email.js';

const to = process.argv[2] || 'reshma@seattlenewmedia.com';
const env = {
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_FROM_EMAIL: process.env.BREVO_FROM_EMAIL || 'web@email.consentbit.com',
  BREVO_FROM_NAME: process.env.BREVO_FROM_NAME || 'ConsentBit',
  WEBAPP_PUBLIC_URL: 'https://accounts.consentbit.com',
};
if (!env.BREVO_API_KEY) {
  console.error('Missing BREVO_API_KEY env var. Set it then re-run.');
  process.exit(1);
}

// Brevo's response is otherwise only logged on failure — print it either way.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const res = await realFetch(url, opts);
  const body = await res.clone().text().catch(() => '');
  console.log(`[${JSON.parse(opts.body).subject}] → ${res.status} ${body}`);
  return res;
};

await sendRetentionReminderEmail(env, null, {
  to, name: 'Reshma', domain: 'example.com', kind: 'free', count: 128,
  date: '2026-11-01', from: '2026-08-01', until: '2026-08-14',
});
await sendRetentionReminderEmail(env, null, {
  to, name: 'Reshma', domain: 'example.com', kind: 'paid', count: 2450,
  date: '2026-11-01', cutoff: '2025-11-01',
});
