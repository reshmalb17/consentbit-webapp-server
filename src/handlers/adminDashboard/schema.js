// src/handlers/adminDashboard/schema.js
//
// Metadata describing how CONSENT_WEBAPP rows relate to a User, used to build the
// cascade-delete. Mirrors src/services/db.js and src/handlers/adminClearWebappData.js.
//
// Ownership graph:
//   User (id)
//     ├─ owns → Organization (ownerUserId)
//     │           ├─ Site (organizationId)
//     │           │     ├─ many child rows keyed by siteId
//     │           │     └─ WebflowOAuthSite (siteId) → WebflowOAuthToken (userKey)
//     │           └─ billing rows keyed by organizationId
//     ├─ OrganizationMember (userId)
//     ├─ Session (userId)
//     ├─ Feedback (userId)
//     ├─ OwnershipTransfer (userId, currentEmail, newEmail)
//     └─ EmailVerificationCode (email)
//
// Not user-linked, so never cascaded: Plan, PromoCode, ProcessedPaymentIntent
// (keyed by Stripe payment-intent id) and WebflowOAuthState (short-lived, keyed
// only by the OAuth state nonce).

/** Tables whose rows belong to a Site (deleted first — deepest children). */
export const SITE_CHILD_TABLES = [
  'Consent',
  'Cookie',
  'Script',
  'ScanHistory',
  'ScanUsage',
  'ScheduledScan',
  'ScanTopupRequest',
  'PageviewUsage',
  'BannerCustomization',
  'CustomCookieRule',
  'LicenseActivation',
];

/** Tables whose rows belong to an Organization (billing / membership). */
export const ORG_CHILD_TABLES = [
  'Subscription',
  'SubscriptionQueue',
  'PaymentEvent',
  'OrganizationMember',
];

/** Tables whose rows belong directly to a User (keyed by userId). */
export const USER_CHILD_TABLES = ['Session', 'Feedback', 'OwnershipTransfer'];

/**
 * Tables keyed by a user's EMAIL rather than their id. Cleaned up using the
 * email snapshot taken before the User row is removed.
 *   OwnershipTransfer also stores currentEmail/newEmail, so a transfer someone
 *   else started TOWARDS this address is cleared as well.
 */
export const EMAIL_KEYED_ROWS = [
  { table: 'EmailVerificationCode', columns: ['email'] },
  { table: 'OwnershipTransfer', columns: ['currentEmail', 'newEmail'] },
];

/** Normalize a raw Site.platform value to one of the three buckets. */
export function normalizePlatform(raw) {
  const v = (raw || '').toLowerCase();
  if (v === 'webflow') return 'webflow';
  if (v === 'framer') return 'framer';
  return 'webapp';
}
