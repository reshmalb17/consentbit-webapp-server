// src/handlers/framerBilling.js
//
// Billing surface for the FRAMER plugin (/api/framer/*).
//
// Why this file exists: the Framer plugin used to call /api/webflow/billing,
// /api/webflow/cancel-subscription and /api/webflow/switch-interval directly.
// Those paths now require a Webflow ID token (see LEGACY_WEBFLOW_AUTH_PATHS in
// index.js + middleware/webflowIdentity.js), which a Framer plugin cannot mint —
// so every Profile/Upgrade call from Framer started failing with 401. These
// routes give Framer its own paths with the pre-token behaviour restored.
//
// The handlers themselves are platform-agnostic — they resolve a site by
// `id OR platformSiteId`, so a Framer siteId works unchanged. Rather than copy
// that logic (Stripe invoice filtering, proration, cancel reconciliation), these
// wrappers delegate to it, keeping ONE implementation to maintain.
//
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY — READ BEFORE EXTENDING
//
// These routes are intentionally UNAUTHENTICATED for now: they authorize on
// knowledge of a siteId alone. That is a deliberate, temporary decision to
// restore the Framer plugin's Profile/Upgrade tabs, NOT an oversight.
//
// The exposure, stated plainly so nobody has to rediscover it:
//   • GET  /api/framer/billing?siteId=<id>      → that site's Stripe invoice
//     history (amounts, dates, hosted invoice PDF links) to any caller.
//   • POST /api/framer/cancel-subscription      → cancels a paying customer's
//     subscription. No credential required.
//   • POST /api/framer/switch-interval          → changes their billing interval.
// siteIds are not secret (they appear in checkout `platformId` and CDN script
// URLs), so these are reachable by anyone who can run curl.
//
// TO CLOSE THIS: the Framer plugin already holds a JWT (localStorage
// `auth_token`, minted by the email-OTP login on framer.consentbit.com). Add a
// `requireFramerIdentity` middleware that resolves it via
// GET ${FRAMER_AUTH_BASE}/auth/me?siteId=<framerSiteId> and requires the
// resolved session's webAppSiteId to match the requested siteId — mirroring
// middleware/webflowIdentity.js. Then move these paths OUT of PUBLIC_PATHS in
// index.js and gate them the way /api/wf/* is gated. The single call site for
// that check is marked below.
// ─────────────────────────────────────────────────────────────────────────────

import {
  handleWebflowBilling,
  handleWebflowCancelSubscription,
  handleWebflowSwitchInterval,
} from './webflowBilling.js';

// GET /api/framer/billing?siteId=<framerSiteId | webappSiteId>
// → { success, plan, status, interval, currentPeriodEnd, cancelAtPeriodEnd,
//     invoices[], scansUsed, scansLimit, pageviewsUsed, pageviewsLimit }
export async function handleFramerBilling(request, env) {
  // ← identity check goes here (see SECURITY note above)
  return handleWebflowBilling(request, env);
}

// POST /api/framer/cancel-subscription   body: { siteId }
// → { success, cancelAtPeriodEnd, currentPeriodEnd }
export async function handleFramerCancelSubscription(request, env) {
  // ← identity check goes here (see SECURITY note above)
  return handleWebflowCancelSubscription(request, env);
}

// POST /api/framer/switch-interval   body: { siteId, targetInterval: 'monthly' | 'yearly' }
// → { success, interval, nextBillingDate }
export async function handleFramerSwitchInterval(request, env) {
  // ← identity check goes here (see SECURITY note above)
  return handleWebflowSwitchInterval(request, env);
}
