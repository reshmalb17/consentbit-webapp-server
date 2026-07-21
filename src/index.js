// src/index.js
import { handleSites } from './handlers/sites.js';
import { handleCDNScript } from './handlers/cdnNm.js';
import { handleConsentV2Script } from './handlers/consentv2handler.js';
import { handleEmbedFloatingLogo } from './handlers/embedFloatingLogo.js';
import { handleConsent } from './handlers/consent.js';
import { handleFramerConsent } from './handlers/framerConsent.js';
import { handleScanScripts } from './handlers/scanScripts.js';
import { handleScanCookies } from './handlers/scanCookies.js';
import { handleVerifyScript } from './handlers/verifyScript.js';
import { handlePageview } from './handlers/pageview.js';
import { handleScanHistory } from './handlers/scanHistory.js';
import { handleCookies } from './handlers/cookies.js';
import { handleMarkVerified } from './handlers/markVerified.js';
import { handleScanSite, handleScanSiteConsented } from './handlers/scanSite.js';
import { handleBannerCustomization } from './handlers/bannerCustomization.js';
import { handleScheduledScan } from './handlers/scheduledScan.js';
import { handleConsentLogs } from './handlers/consentLogs.js';
import { handleValidatePromo } from './handlers/validatePromo.js';
import { handleCreateCheckoutSession } from './handlers/createCheckoutSession.js';
import { handleCheckoutSessionDetails } from './handlers/checkoutSessionDetails.js';
import { handleCheckoutToken } from './handlers/checkoutToken.js';
import { handleWebflowCheckoutToken } from './handlers/webflowCheckoutToken.js';
import { handleWebflowTrack } from './handlers/webflowTrack.js';
import { handleCheckoutSuccessRedirect } from './handlers/checkoutSuccessRedirect.js';
import { handleStripeWebhook } from './handlers/stripeWebhook.js';
import { reportStripeMeteredUsage } from './handlers/reportStripeUsage.js';
import { handleLicenses } from './handlers/licenses.js';
import { handleActivateLicense } from './handlers/activateLicense.js';
import { handleActivateLicenseWebflow } from './handlers/activateLicenseWebflow.js';
import { handleCheckDomainScript } from './handlers/checkDomainScript.js';
import { handleCancelSubscription } from './handlers/cancelSubscription.js';
import { handleUpgradeSubscription } from './handlers/updateSubscription.js';
import { handleCreateSetupIntent, handleUpdatePaymentMethod } from './handlers/updatePaymentMethod.js';
import { handleSwitchBillingInterval, handleSwitchIntervalPreview } from './handlers/switchBillingInterval.js';
import { handleChangeTier, handleChangeTierPreview } from './handlers/changeTier.js';
import { handleDebugSchema } from './handlers/debugSchema.js';
import { handleAdminSeedLegacy } from './handlers/adminSeedLegacy.js';
import { handleAdminSeedBannerConfigs } from './handlers/adminSeedBannerConfigs.js';
import { handleAdminCheckMissedBanners } from './handlers/adminCheckMissedBanners.js';
import { handleAdminUpdateLegacyPlans } from './handlers/adminUpdateLegacyPlans.js';
import { handleAdminBackfillWfSiteId } from './handlers/adminBackfillWfSiteId.js';
import { handleAdminBackfillFramerSiteId } from './handlers/adminBackfillFramerSiteId.js';
import { handleAdminClearWebappData } from './handlers/adminClearWebappData.js';
import { handleAdminResetLegacyWebflow } from './handlers/adminResetLegacyWebflow.js';
import { handleAdminMigrateFromKv, handleAdminMigrateFramerFromKv } from './handlers/adminMigrateFromKv.js';
import { handleAdminMigrateSingleSite } from './handlers/adminMigrateSingleSite.js';
import { handleAdminMigrateCustomization } from './handlers/adminMigrateCustomization.js';
import { handleAdminBackfillDescriptions } from './handlers/adminBackfillDescriptions.js';
import { handleAdminInjectScript } from './handlers/adminInjectScript.js';
import { handleAdminMigrateFromDashboard } from './handlers/adminMigrateFromDashboard.js';
import { handleAdminBackfillConsentR2 } from './handlers/adminBackfillConsentR2.js';
import { handleAdminBackfillStripeSubscriptions } from './handlers/adminBackfillStripeSubscriptions.js';
import { handleAdminBackfillPosthog } from './handlers/adminBackfillPosthog.js';
import { handleAdminBackfillClickup } from './handlers/adminBackfillClickup.js';
import { handleAdminMicheleClickup } from './handlers/adminMicheleClickup.js';
import { handleAdminTestScanReport } from './handlers/adminTestScanReport.js';
import { handleCheckLegacyScript } from './handlers/checkLegacyScript.js';
import { handleLegacyConsentLogs } from './handlers/legacyConsentLogs.js';
import { handleLegacyConsentCsv } from './handlers/legacyConsentCsv.js';
import { handleLegacyConsentPdf } from './handlers/legacyConsentPdf.js';
import { handleLegacyConsentLogsFramer, handleLegacyConsentFramerRaw } from './handlers/legacyConsentLogsFramer.js';
import { handleLegacyConsentCsvFramer } from './handlers/legacyConsentCsvFramer.js';
import { handleLegacyConsentPdfFramer } from './handlers/legacyConsentPdfFramer.js';
import { handleConsentPdf } from './handlers/consentPdf.js';
import { handleConsentCsv } from './handlers/consentCsv.js';
import { handleSyncEvent } from './handlers/syncEvent.js';
import { handleBillingSummary, handleBillingPortal, handleBillingInvoices, handleBillingUsage } from './handlers/billing.js';
import { handleCustomCookieRules } from './handlers/customCookieRules.js';
import { handleScanPending } from './handlers/scanPending.js';

import { handleAuthDashboardInit } from './handlers/authDashboardInit.js';
import { handleAuthLogin } from './handlers/authLogin.js';
import { handleAuthSignup } from './handlers/authSignup.js';
import { handleAuthMe } from './handlers/authMe.js';
import { handleAuthProfile } from './handlers/authProfile.js';
import { handleTransferOwnershipRequest, handleTransferOwnershipAuthorize, handleWfTransferOwnershipRequest } from './handlers/authTransferOwnership.js';
import { handleAuthRequestCode } from './handlers/authRequestCode.js';
import { handleAuthVerifyCode } from './handlers/authVerifyCode.js';
import { handleAuthLogout } from './handlers/authLogout.js';
import { handleOnboardingFirstSetup } from './handlers/onboardingFirstSetup.js';
import { handleCheckDomainAvailability } from './handlers/checkDomainAvailability.js';
import { handleRenameDomain } from './handlers/renameDomain.js';
import { handleWebflowFreeRegister } from './handlers/webflowFreeRegister.js';
import { handleFeedback } from './handlers/feedback.js';
import { handleCustomCheckout, handleValidateCoupon } from './handlers/customeCheeckout.js';
import { handleSyncPlugin, handleSyncPluginCustomization, handleGetPluginData, handleGetPluginPlan } from './handlers/SyncPlugin.js';
import { handlePaymentSubscription } from './handlers/paymentSubscription.js';
import { handleWebflowBilling, handleWebflowCancelSubscription, handleWebflowSwitchInterval } from './handlers/webflowBilling.js';
import { handleWebflowBillings, handleWebflowCancelSubscriptions, handleWebflowSwitchIntervals } from './handlers/webflowBillingWf.js';
import { requireConsentSession, requireConsentPdfAccess } from './middleware/consentAccess.js';
import { handleFramerBilling, handleFramerCancelSubscription, handleFramerSwitchInterval } from './handlers/framerBilling.js';
import {
  handleFramerChangeTier,
  handleFramerChangeTierPreview,
  handleFramerSwitchInterval as handleFramerUpgradeSwitchInterval,
  handleFramerSwitchIntervalPreview as handleFramerUpgradeSwitchIntervalPreview,
} from './handlers/framerUpgrade.js';
import { handleFramerTransferOwnershipRequest } from './handlers/authTransferOwnershipFramer.js';
import { handleWebflowScriptCleanupReport, handleWebflowScriptCleanupRemove } from './handlers/webflowScriptCleanup.js';
import { handleWebflowOAuthAuthorize, handleWebflowOAuthCallback, handleWebflowOAuthStatus } from './handlers/webflowOAuth.js';
import { handleWebflowPublish, handleWebflowDomains } from './handlers/webflowPublish.js';

import { handleOptions, withCors, withPublicCors } from './utils/cors.js';
import {
  checkRateLimit,
  rateLimitedResponse,
  validateCsrf,
  sanitizeRequestBody,
  wrapAndEncodeResponse,
  withSecurityHeaders,
} from './middleware/security.js';
import { requireWebflowIdentity } from './middleware/webflowIdentity.js';
import {
  ensureSchema,
  getDueScheduledScans,
  claimDueScheduledScan,
  updateScheduledScanAfterRun,
  deactivateScheduledScan,
  calculateNextRunAt,
  getPendingSubscriptionQueue,
  deleteSubscriptionQueueRow,
  markSubscriptionQueueFailed,
  saveSubscription,
  getSiteById,
  getScanUsageForSite,
  getEffectivePlanForOrganization,
  getOrgOwnerEmail,
  markScanLimitNotified,
} from './services/db.js';
import { sendScanLimitEmail } from './services/email.js';

// ---------------------------------------------------------------------------
// Endpoint classification sets
// ---------------------------------------------------------------------------

/**
 * Public endpoints — called directly from CDN scripts on customer sites.
 * These allow any origin, skip CSRF checks, and responses are NOT encoded
 * (the CDN script must be able to read plain JSON).
 */
const PUBLIC_PATHS = new Set([
  '/api/consent',
  '/api/framer-consent',
  '/api/scan-scripts',
  '/api/scan-cookies',
  '/api/pageview',
  '/api/scan-site',
  '/api/scan-site-consented',
  '/api/scan-pending',
  '/api/v2/webflow-free-register',
  '/api/payment/subscription',
  '/api/webflow/billing',
  '/api/webflow/cancel-subscription',
  '/api/webflow/switch-interval',
  '/api/webflow/script-cleanup',
  // Framer plugin billing surface. Public + authless by design (see the SECURITY
  // note in handlers/framerBilling.js) — these restore the behaviour the Framer
  // plugin had before /api/webflow/* was put behind a Webflow ID token, which
  // Framer cannot mint. Gate these and remove them from this set when the Framer
  // identity check lands.
  '/api/framer/billing',
  '/api/framer/cancel-subscription',
  '/api/framer/switch-interval',
  // Framer plugin UPGRADE surface (tier change + interval switch, with proration
  // preview). These are "public" only for TRANSPORT (any-origin CORS, no cookie/CSRF,
  // plain-JSON responses) — authorization is enforced INSIDE each handler via the
  // Framer plugin's JWT (Authorization: Bearer <auth_token>), verified with
  // env.FRAMER_JWT_SECRET. See handlers/framerUpgrade.js.
  '/api/framer/upgrade/change-tier',
  '/api/framer/upgrade/change-tier/preview',
  '/api/framer/upgrade/switch-interval',
  '/api/framer/upgrade/switch-interval/preview',
  // Framer account ownership transfer (request step). Authless by design — the
  // authorization link is emailed only to the resolved owner, who must click it to
  // complete the transfer (see SECURITY note in authTransferOwnershipFramer.js).
  // The authorize step reuses /api/auth/transfer-ownership/authorize (token-only).
  '/api/framer/transfer-ownership/request',
  // Webflow OAuth (browser redirects) — must skip body-encoding so the 302
  // Location survives, allow any origin, and skip CSRF (GET).
  '/api/webflow/oauth/authorize',
  '/api/webflow/oauth/callback',
  '/api/webflow/oauth/status',
  // Webflow site publish + domains (called from the Designer extension).
  '/api/webflow/publish',
  '/api/webflow/domains',
  '/api/banner-customization',
  '/api/licenses/activate-license',
  '/api/licenses/check-domain-script',
  '/api/checkout-token',
  '/api/v2/webflow-checkout-token',
  // Legacy aliases without /api/ prefix (backwards-compat for older bundles)
  '/licenses/activate-license',
  '/licenses/check-domain-script',
]);

/**
 * Authenticated Webflow Designer Extension API surface (/api/wf/*).
 *
 * These are dedicated copies of the Designer-app endpoints that REQUIRE a valid
 * Webflow ID token (Authorization: Bearer <idToken>) and enforce that the caller
 * is authorized for the site they name (see middleware/webflowIdentity.js). They
 * reuse the exact same handler logic as the legacy public endpoints — the legacy
 * paths are left untouched so older bundles keep working, while the updated app
 * calls only these authenticated routes.
 *
 * Key: the path segment AFTER '/api/wf/'. Value: (request, env, ctx) => Response.
 */
const WEBFLOW_APP_ROUTES = {
  'oauth/status':        (req, env)      => handleWebflowOAuthStatus(req, env, { authenticated: true }),
  'verify-script':       (req, env)      => handleVerifyScript(req, env),
  'banner-customization':(req, env)      => handleBannerCustomization(req, env),
  'scan-site-consented': (req, env, ctx) => handleScanSiteConsented(req, env, ctx),
  'scan-history':        (req, env)      => handleScanHistory(req, env),
  'cookies':             (req, env)      => handleCookies(req, env),
  'consent-logs':        (req, env)      => handleConsentLogs(req, env),
  'consent-csv':         (req, env)      => handleConsentCsv(req, env),
  'consent-pdf':         (req, env)      => handleConsentPdf(req, env),
  'custom-cookie-rules': (req, env)      => handleCustomCookieRules(req, env),
  'scheduled-scan':      (req, env)      => handleScheduledScan(req, env),
  'script-cleanup':      (req, env)      => (req.method === 'POST'
                                             ? handleWebflowScriptCleanupRemove(req, env)
                                             : handleWebflowScriptCleanupReport(req, env)),
  'publish':             (req, env)      => handleWebflowPublish(req, env),
  'domains':             (req, env)      => handleWebflowDomains(req, env),
  'billings':             (req, env)     => handleWebflowBillings(req, env),
  'cancel-subscriptions': (req, env)     => handleWebflowCancelSubscriptions(req, env),
  'switch-intervals':     (req, env)     => handleWebflowSwitchIntervals(req, env),
  'payment/subscription':(req, env)      => handlePaymentSubscription(req, env),
  'webflow-free-register':(req, env)     => handleWebflowFreeRegister(req, env),
  'webflow-checkout-token':(req, env)    => handleWebflowCheckoutToken(req, env),
  'transfer-ownership/request': (req, env, ctx, identity) => handleWfTransferOwnershipRequest(req, env, ctx, identity),
  'track':               (req, env, ctx, identity) => handleWebflowTrack(req, env, ctx, identity),
};

/**
 * LEGACY Webflow-Designer endpoints that the updated app no longer uses (it calls
 * the authenticated /api/wf/* copies above). They previously answered anyone with a
 * siteId — the reviewer's "trigger publish / cancel-subscription on another
 * installation" and account-data finding. Since the previous app is not live, these
 * have no legitimate remaining caller, so we now require a valid Webflow ID token on
 * them too. (oauth/status stays public but PII-stripped — the hosted checkout page
 * still reads its non-PII fields and cannot mint an ID token.)
 */
const LEGACY_WEBFLOW_AUTH_PATHS = new Set([
  '/api/webflow/publish',
  '/api/webflow/domains',
  '/api/webflow/script-cleanup',
  '/api/v2/webflow-free-register',
  '/api/v2/webflow-checkout-token',
]);

/**
 * Auth/onboarding endpoints that receive a stricter per-IP rate limit
 * (brute-force protection, security measure #7).
 * CSRF is NOT required here because these calls establish the session.
 */
const AUTH_RATE_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/request-code',
  '/api/auth/verify-code',
  '/api/auth/transfer-ownership/authorize',
  '/api/onboarding/first-setup',
]);

/**
 * Paths exempt from the CSRF header check.
 * Includes: public CDN endpoints, auth-setup endpoints, Stripe webhook
 * (which uses its own signature verification), and read-only GET endpoints.
 */
const CSRF_EXEMPT_PATHS = new Set([
  ...PUBLIC_PATHS,
  ...AUTH_RATE_PATHS,
  '/api/webhooks/stripe',
  '/api/auth/logout',
  '/api/auth/dashboard-init',
  '/api/checkout-success-redirect',
  '/api/custom-checkout',
  '/api/sync-plugin',
  '/api/sync-plugin-customization',
  '/api/sync-plugin-data',
  '/api/v2/webflow-free-register',
  '/api/sync-plugin-plan',
  '/api/admin/seed-legacy-users',
  '/api/admin/seed-banner-configs',
  '/api/admin/check-missed-banners',
  '/api/admin/update-legacy-plans',
  '/api/admin/backfill-wf-site-id',
  '/api/admin/backfill-framer-site-id',
  '/api/admin/clear-webapp-data',
  '/api/admin/reset-legacy-webflow',
  '/api/admin/migrate-from-kv',
  '/api/admin/migrate-framer-from-kv',
  '/api/admin/migrate-single-site',
  '/api/admin/migrate-customization',
  '/api/admin/backfill-descriptions',
  '/api/admin/inject-script',
  '/api/admin/migrate-from-dashboard',
  '/api/admin/backfill-consent-r2',
  '/api/admin/backfill-stripe-subscriptions',
  '/api/admin/backfill-posthog',
  '/api/admin/backfill-clickup',
  '/api/admin/michele-clickup',
  '/api/admin/test-scan-report',
  '/api/payment/subscription',
]);

// ---------------------------------------------------------------------------
// Helper: dispatch request to the correct handler
// Returns { response, isPublic }
// ---------------------------------------------------------------------------
async function dispatchApiRoute(pathname, request, env, ctx) {
  const isPublic = PUBLIC_PATHS.has(pathname);

  let response;
  switch (pathname) {
    // — Sites
    case '/api/sites':
      response = await handleSites(request, env); break;

    // — Public CDN / consent / scan endpoints
    case '/api/consent':
      response = await handleConsent(request, env, ctx); break;
    case '/api/framer-consent':
      response = await handleFramerConsent(request, env, ctx); break;
    case '/api/scan-scripts':
      response = await handleScanScripts(request, env); break;
    case '/api/scan-cookies':
      response = await handleScanCookies(request, env); break;
    case '/api/pageview':
      response = await handlePageview(request, env); break;
    case '/api/scan-site':
      response = await handleScanSite(request, env, ctx); break;
    case '/api/scan-site-consented':
      response = await handleScanSiteConsented(request, env, ctx); break;
    case '/api/scan-pending':
      response = await handleScanPending(request, env); break;

    // — Auth
    case '/api/auth/login':
      response = await handleAuthLogin(request, env); break;
    case '/api/auth/signup':
      response = await handleAuthSignup(request, env); break;
    case '/api/auth/request-code':
      response = await handleAuthRequestCode(request, env, ctx); break;
    case '/api/auth/verify-code':
      response = await handleAuthVerifyCode(request, env, ctx); break;
    case '/api/auth/logout':
      response = await handleAuthLogout(request, env); break;
    case '/api/auth/dashboard-init':
      response = await handleAuthDashboardInit(request, env); break;
    case '/api/auth/me':
      response = await handleAuthMe(request, env); break;
    case '/api/auth/profile':
      response = await handleAuthProfile(request, env); break;
    case '/api/auth/transfer-ownership/request':
      response = await handleTransferOwnershipRequest(request, env, ctx); break;
    case '/api/auth/transfer-ownership/authorize':
      response = await handleTransferOwnershipAuthorize(request, env); break;

    // — Onboarding
    case '/api/onboarding/first-setup':
      response = await handleOnboardingFirstSetup(request, env, ctx); break;
    case '/api/internal/webflow-free-register':
    case '/api/v2/webflow-free-register':
      response = await handleWebflowFreeRegister(request, env); break;
    case '/api/sites/check-domain':
      response = await handleCheckDomainAvailability(request, env); break;
    case '/api/sites/rename-domain':
      response = await handleRenameDomain(request, env); break;

    // — Banner / scan
    case '/api/banner-customization':
      response = await handleBannerCustomization(request, env); break;
    case '/api/scheduled-scan':
      response = await handleScheduledScan(request, env); break;
    case '/api/scan-history':
      response = await handleScanHistory(request, env); break;
    case '/api/cookies':
      response = await handleCookies(request, env); break;
    case '/api/mark-verified':
      response = await handleMarkVerified(request, env); break;
    case '/api/verify-script':
      response = await handleVerifyScript(request, env); break;
    case '/api/custom-cookie-rules':
      response = await handleCustomCookieRules(request, env); break;

    // — Consent logs (session-gated: web-app proxy forwards the sid cookie)
    case '/api/consent-logs': {
      const g = await requireConsentSession(request, env);
      if (!g.ok) { response = Response.json({ success: false, error: g.error }, { status: g.status }); break; }
      response = await handleConsentLogs(request, env); break;
    }

    // — Payment subscription check (Webflow app)
    case '/api/payment/subscription':
      response = await handlePaymentSubscription(request, env); break;

    // — Webflow app billing (siteId-keyed): invoices + cancel + interval.
    // KEPT and intentionally NOT in the wf identity gate — the LIVE Framer plugin
    // still calls these singular /api/webflow/* paths directly and cannot mint a
    // Webflow ID token. The authenticated copies the Webflow extension uses live at
    // /api/wf/billings, /api/wf/cancel-subscriptions, /api/wf/switch-intervals.
    case '/api/webflow/billing':
      response = await handleWebflowBilling(request, env); break;
    case '/api/webflow/cancel-subscription':
      response = await handleWebflowCancelSubscription(request, env); break;
    case '/api/webflow/switch-interval':
      response = await handleWebflowSwitchInterval(request, env); break;

    // — Framer plugin billing (authless, siteId-keyed): invoices + cancel + interval
    case '/api/framer/billing':
      response = await handleFramerBilling(request, env); break;
    case '/api/framer/cancel-subscription':
      response = await handleFramerCancelSubscription(request, env); break;
    case '/api/framer/switch-interval':
      response = await handleFramerSwitchInterval(request, env); break;

    // — Framer plugin UPGRADE (JWT-authed, siteId-keyed): tier change + interval switch,
    //   each with a prorated preview. See handlers/framerUpgrade.js.
    case '/api/framer/upgrade/change-tier':
      response = await handleFramerChangeTier(request, env); break;
    case '/api/framer/upgrade/change-tier/preview':
      response = await handleFramerChangeTierPreview(request, env); break;
    case '/api/framer/upgrade/switch-interval':
      response = await handleFramerUpgradeSwitchInterval(request, env); break;
    case '/api/framer/upgrade/switch-interval/preview':
      response = await handleFramerUpgradeSwitchIntervalPreview(request, env); break;

    // — Framer account ownership transfer (request step; authorize reuses /api/auth/*)
    case '/api/framer/transfer-ownership/request':
      response = await handleFramerTransferOwnershipRequest(request, env, ctx); break;

    // — Legacy script cleanup (remove old auto-injected ConsentBit head script)
    case '/api/webflow/script-cleanup':
      response = request.method === 'POST'
        ? await handleWebflowScriptCleanupRemove(request, env)
        : await handleWebflowScriptCleanupReport(request, env);
      break;

    // — Webflow OAuth install (browser redirects) + Designer status/publish
    case '/api/webflow/oauth/authorize':
      response = await handleWebflowOAuthAuthorize(request, env); break;
    case '/api/webflow/oauth/callback':
      response = await handleWebflowOAuthCallback(request, env); break;
    case '/api/webflow/oauth/status':
      response = await handleWebflowOAuthStatus(request, env); break;
    case '/api/webflow/publish':
      response = await handleWebflowPublish(request, env); break;
    case '/api/webflow/domains':
      response = await handleWebflowDomains(request, env); break;

    // — Billing / payments
    case '/api/validate-promo':
      response = await handleValidatePromo(request, env); break;
    case '/api/create-checkout-session':
      response = await handleCreateCheckoutSession(request, env); break;
    case '/api/checkout-session':
      response = await handleCheckoutSessionDetails(request, env); break;
    case '/api/checkout-token':
      response = await handleCheckoutToken(request, env); break;
    case '/api/v2/webflow-checkout-token':
      response = await handleWebflowCheckoutToken(request, env); break;
    case '/api/checkout-success-redirect':
      response = await handleCheckoutSuccessRedirect(request, env); break;
    case '/api/billing/summary':
      response = await handleBillingSummary(request, env); break;
    case '/api/billing/portal':
      response = await handleBillingPortal(request, env); break;
    case '/api/billing/invoices':
      response = await handleBillingInvoices(request, env); break;
    case '/api/billing/usage':
      response = await handleBillingUsage(request, env); break;

    // — Subscriptions / licenses
    case '/api/licenses':
      response = await handleLicenses(request, env); break;
    case '/api/licenses/activate':
      response = await handleActivateLicense(request, env); break;
    case '/api/licenses/activate-license':
    case '/licenses/activate-license':
      response = await handleActivateLicenseWebflow(request, env); break;
    case '/api/licenses/check-domain-script':
    case '/licenses/check-domain-script':
      response = await handleCheckDomainScript(request, env); break;
    case '/api/subscriptions/cancel':
      response = await handleCancelSubscription(request, env, ctx); break;
    case '/api/subscriptions/upgrade':
      response = await handleUpgradeSubscription(request, env); break;
    case '/api/subscriptions/switch-interval':
      response = await handleSwitchBillingInterval(request, env); break;
    case '/api/subscriptions/switch-interval/preview':
      response = await handleSwitchIntervalPreview(request, env); break;
    case '/api/subscriptions/change-tier':
      response = await handleChangeTier(request, env); break;
    case '/api/subscriptions/change-tier/preview':
      response = await handleChangeTierPreview(request, env); break;
    case '/api/billing/setup-intent':
      response = await handleCreateSetupIntent(request, env); break;
    case '/api/billing/update-payment-method':
      response = await handleUpdatePaymentMethod(request, env); break;

    // — Webhooks (own auth mechanism — Stripe signature)
    case '/api/webhooks/stripe':
      response = await handleStripeWebhook(request, env, ctx); break;

    // — Custom checkout (Stripe.js direct flow)
    case '/api/custom-checkout':
      response = await handleCustomCheckout(request, env, ctx); break;
    case '/api/validate-coupon':
      response = await handleValidateCoupon(request, env); break;

    // — Plugin sync (publish from platform plugin)
    case '/api/sync-plugin':
      response = await handleSyncPlugin(request, env); break;
    case '/api/sync-plugin-customization':
      response = await handleSyncPluginCustomization(request, env); break;
    case '/api/sync-plugin-data':
      response = await handleGetPluginData(request, env); break;
    case '/api/sync-plugin-plan':
      response = await handleGetPluginPlan(request, env); break;

    // — Feedback
    case '/api/feedback':
      response = await handleFeedback(request, env); break;

    // — Debug (should be disabled in production via env guard inside the handler)
    case '/api/debug/schema':
      response = await handleDebugSchema(request, env); break;

    // — Admin: one-time / idempotent data migrations
    case '/api/admin/seed-legacy-users':
      response = await handleAdminSeedLegacy(request, env); break;

    case '/api/admin/seed-banner-configs':
      response = await handleAdminSeedBannerConfigs(request, env); break;

    case '/api/admin/check-missed-banners':
      response = await handleAdminCheckMissedBanners(request, env); break;

    case '/api/admin/update-legacy-plans':
      response = await handleAdminUpdateLegacyPlans(request, env); break;

    case '/api/admin/backfill-wf-site-id':
      response = await handleAdminBackfillWfSiteId(request, env); break;

    case '/api/admin/backfill-framer-site-id':
      response = await handleAdminBackfillFramerSiteId(request, env); break;

    case '/api/admin/clear-webapp-data':
      response = await handleAdminClearWebappData(request, env); break;

    case '/api/admin/reset-legacy-webflow':
      response = await handleAdminResetLegacyWebflow(request, env); break;

    case '/api/admin/migrate-from-kv':
      response = await handleAdminMigrateFromKv(request, env); break;

    case '/api/admin/migrate-framer-from-kv':
      response = await handleAdminMigrateFramerFromKv(request, env); break;

    case '/api/admin/migrate-single-site':
      response = await handleAdminMigrateSingleSite(request, env); break;

    case '/api/admin/migrate-customization':
      response = await handleAdminMigrateCustomization(request, env); break;

    case '/api/admin/backfill-descriptions':
      response = await handleAdminBackfillDescriptions(request, env); break;

    case '/api/admin/inject-script':
      response = await handleAdminInjectScript(request, env); break;

    case '/api/admin/migrate-from-dashboard':
      response = await handleAdminMigrateFromDashboard(request, env); break;

    case '/api/admin/backfill-consent-r2':
      response = await handleAdminBackfillConsentR2(request, env); break;

    case '/api/admin/backfill-stripe-subscriptions':
      response = await handleAdminBackfillStripeSubscriptions(request, env); break;

    case '/api/admin/backfill-posthog':
      response = await handleAdminBackfillPosthog(request, env); break;

    case '/api/admin/backfill-clickup':
      response = await handleAdminBackfillClickup(request, env); break;

    case '/api/admin/michele-clickup':
      response = await handleAdminMicheleClickup(request, env); break;

    case '/api/admin/test-scan-report':
      response = await handleAdminTestScanReport(request, env, ctx); break;

    case '/api/check-legacy-script':
      response = await handleCheckLegacyScript(request, env); break;

    case '/api/legacy-consent-logs':
    case '/api/legacy-consent-monthly':
      response = await handleLegacyConsentLogs(request, env); break;

    case '/api/legacy-consent-csv':
      response = await handleLegacyConsentCsv(request, env); break;

    case '/api/legacy-consent-pdf':
      response = await handleLegacyConsentPdf(request, env); break;

    case '/api/legacy-consent-logs-framer':
    case '/api/legacy-consent-monthly-framer':
      response = await handleLegacyConsentLogsFramer(request, env); break;

    case '/api/legacy-consent-framer-raw':
      response = await handleLegacyConsentFramerRaw(request, env); break;

    case '/api/legacy-consent-csv-framer':
      response = await handleLegacyConsentCsvFramer(request, env); break;

    case '/api/legacy-consent-pdf-framer':
      response = await handleLegacyConsentPdfFramer(request, env); break;

    // — Consent PDF (session OR a valid signed download token from CSV-embedded links)
    case '/api/consent-pdf': {
      const g = await requireConsentPdfAccess(request, env);
      if (!g.ok) { response = Response.json({ success: false, error: g.error }, { status: g.status }); break; }
      response = await handleConsentPdf(request, env); break;
    }

    // — Consent CSV (session-gated: web-app proxy forwards the sid cookie)
    case '/api/consent-csv': {
      const g = await requireConsentSession(request, env);
      if (!g.ok) { response = Response.json({ success: false, error: g.error }, { status: g.status }); break; }
      response = await handleConsentCsv(request, env); break;
    }

    // — Bidirectional sync: receives events from dashboard-server
    case '/api/sync/event':
      response = await handleSyncEvent(request, env); break;

    default:
      response = Response.json({ success: false, error: 'Not Found' }, { status: 404 });
  }

  return { response, isPublic };
}

// ---------------------------------------------------------------------------
// Cron helpers (unchanged)
// ---------------------------------------------------------------------------

function toTimestamp(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts * 1000).toISOString();
  return ts;
}

async function executeScheduledScans(env, ctx) {
  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);
  try {
    const now = new Date().toISOString();
    const dueRaw = await getDueScheduledScans(db);

    // Collapse to ONE due schedule per site. The product allows a single active schedule
    // per site (the POST handler deactivates prior ones before creating a new one), so any
    // extra active rows for the same site are stale duplicates — running them all is what
    // produced multiple scan rows for a single scheduled scan. Keep the newest row per site
    // and deactivate the older duplicates so the accumulation self-heals.
    const bySite = new Map();
    for (const s of dueRaw) {
      const prev = bySite.get(s.siteId);
      const createdAt = s.createdAt || s.createdat || '';
      if (!prev || String(createdAt) > String(prev.createdAt || prev.createdat || '')) {
        if (prev) { try { await deactivateScheduledScan(db, prev.id, now); } catch (_) {} }
        bySite.set(s.siteId, s);
      } else {
        try { await deactivateScheduledScan(db, s.id, now); } catch (_) {}
      }
    }
    const scheduledScans = [...bySite.values()];
    console.log('[Cron] executeScheduledScans —', { time: now, dueRaw: dueRaw.length, dueScans: scheduledScans.length });
    const executed = [];
    for (const scheduledScan of scheduledScans) {
      try {
        // Check scan limit before running — skip if the org has exceeded this month's quota
        const site = await getSiteById(db, scheduledScan.siteId);
        const organizationId = site ? (site.organizationId ?? site.organizationid) : null;
        if (organizationId) {
          const [{ plan }, scanUsage] = await Promise.all([
            getEffectivePlanForOrganization(db, organizationId, env),
            getScanUsageForSite(db, scheduledScan.siteId),
          ]);
          const scansLimit = plan ? (plan.scansIncluded ?? plan.scansincluded ?? 100) : 100;
          if (scanUsage.scanCount >= scansLimit) {
            // Send one notification email per site per month
            const alreadyNotified = site.scanLimitNotifiedMonth === scanUsage.yearMonth;
            if (!alreadyNotified) {
              const owner = await getOrgOwnerEmail(db, organizationId);
              if (owner?.email) {
                sendScanLimitEmail(env, ctx, {
                  to: owner.email,
                  name: owner.name,
                  domain: site.domain,
                  scansLimit,
                });
                await markScanLimitNotified(db, scheduledScan.siteId, scanUsage.yearMonth);
              }
            }

            executed.push({ id: scheduledScan.id, status: 'skipped', reason: 'scan_limit_reached' });
            continue;
          }
        }

        // Atomically CLAIM the schedule before scanning. Advancing nextRunAt / deactivating
        // up front means overlapping cron invocations can't both scan the same due schedule
        // (which was inserting duplicate scan rows). Only the invocation that actually
        // changes the row proceeds to scan.
        const isOnce = scheduledScan.frequency === 'once';
        // Advance nextRunAt to the NEXT FUTURE occurrence in a single hop. A recurring
        // scan whose nextRunAt is several periods in the past (worker downtime, or a
        // scheduledAt earlier the same day) would otherwise only advance one period per
        // cron sweep — staying "due" and re-firing on every tick, which inserts multiple
        // duplicate ScanHistory rows. Loop until strictly in the future so it fires once.
        let newNextRunAt = null;
        if (!isOnce) {
          newNextRunAt = calculateNextRunAt(scheduledScan.scheduledAt, scheduledScan.frequency, scheduledScan.nextRunAt);
          let guard = 0;
          while (new Date(newNextRunAt).getTime() <= Date.now() && guard < 1000) {
            newNextRunAt = calculateNextRunAt(scheduledScan.scheduledAt, scheduledScan.frequency, newNextRunAt);
            guard++;
          }
        }
        const claimed = await claimDueScheduledScan(db, {
          id: scheduledScan.id,
          currentNextRunAt: scheduledScan.nextRunAt,
          once: isOnce,
          newNextRunAt,
          now,
        });
        if (!claimed) {
          executed.push({ id: scheduledScan.id, status: 'skipped', reason: 'already_claimed' });
          continue;
        }

        const scanRequest = new Request('https://internal/scan-site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: scheduledScan.siteId }),
        });
        // Scan with consent accepted — same mode as the manual "Scan Now" button
        // (/api/scan-site-consented). Otherwise scheduled scans capture only pre-consent
        // cookies and their results diverge from what the user sees on a manual scan.
        await handleScanSite(scanRequest, env, ctx, { acceptConsent: true });
        executed.push({ id: scheduledScan.id, status: 'completed', deactivated: isOnce });
      } catch (err) {
        console.error(`[Cron] Failed to execute scheduled scan ${scheduledScan.id}:`, err);
        executed.push({ id: scheduledScan.id, status: 'failed', error: err.message });
      }
    }
    console.log('[Cron] executeScheduledScans done —', executed);
  } catch (err) {
    console.error('[Cron] Error executing scheduled scans:', err);
  }
}

function getRow(row, key) {
  if (row[key] !== undefined) return row[key];
  const kl = key.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === kl) return row[k];
  }
  return undefined;
}

async function processSubscriptionQueue(env) {
  const db = env.CONSENT_WEBAPP;
  if (!db || !env.STRIPE_SECRET_KEY) return;
  try { await ensureSchema(db); } catch (err) {
    console.error('[Cron] processSubscriptionQueue ensureSchema failed', err);
    return;
  }
  const pending = await getPendingSubscriptionQueue(db, 4);
  if (pending.length === 0) return;
  for (const row of pending) {
    const id               = getRow(row, 'id');
    const organizationId   = getRow(row, 'organizationId');
    const stripeCustomerId = getRow(row, 'stripeCustomerId');
    const licenseKey       = getRow(row, 'licenseKey');
    const recurringPriceId = getRow(row, 'recurringPriceId');
    const interval         = getRow(row, 'interval');
    const trialEnd         = getRow(row, 'trialEnd');
    try {
      const params = new URLSearchParams();
      params.set('customer', stripeCustomerId);
      params.set('items[0][price]', recurringPriceId);
      params.set('items[0][quantity]', '1');
      params.set('trial_end', String(trialEnd));
      params.set('metadata[organizationId]', organizationId);
      params.set('metadata[planType]', 'bulk');
      params.set('metadata[license_key]', licenseKey);
      const res  = await fetch('https://api.stripe.com/v1/subscriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const data = await res.json();
      if (data.id) {
        await saveSubscription(db, {
          organizationId,
          stripeSubscriptionId: data.id,
          stripeCustomerId,
          stripePriceId: recurringPriceId,
          planType: 'bulk',
          interval,
          status: data.status === 'active' ? 'active' : 'trialing',
          currentPeriodStart: toTimestamp(data.current_period_start),
          currentPeriodEnd:   toTimestamp(data.current_period_end),
          amountCents: data.plan?.amount ?? null,
          licenseKey,
        });
        await deleteSubscriptionQueueRow(db, id);
      } else {
        console.error('[Cron] Stripe subscription create failed', data.error?.message || data);
        await markSubscriptionQueueFailed(db, id, data.error?.message || JSON.stringify(data));
      }
    } catch (err) {
      console.error('[Cron] SubscriptionQueue failed for', id, err);
      await markSubscriptionQueueFailed(db, id, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    console.log('[Worker] scheduled cron fired —', { cron: event?.cron, scheduledTime: event?.scheduledTime });
    ctx.waitUntil(
      Promise.all([
        executeScheduledScans(env, ctx),
        processSubscriptionQueue(env),
        reportStripeMeteredUsage(env),
      ])
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS' && (pathname.startsWith('/api/') || PUBLIC_PATHS.has(pathname))) {
      return handleOptions(request, env);
    }

    // ── Public embed asset (floating button logo) ─────────────────────────
    if (pathname === '/embed/floating-logo.svg' && request.method === 'GET') {
      return handleEmbedFloatingLogo(env);
    }

    // ── CDN scripts — no security middleware, served as-is ────────────────
    if (pathname.startsWith('/client_data/') || pathname.startsWith('/consentbit/')) {
      return handleCDNScript(request, env, url);
    }

    // ── ConsentV2 scripts — domain + subscription blocking ────────────────
    if (pathname.startsWith('/consentv2/')) {
      return handleConsentV2Script(request, env, url);
    }

    // ── Only continue for /api/ routes (or known public aliases) ─────────
    if (!pathname.startsWith('/api/') && !PUBLIC_PATHS.has(pathname)) {
      return Response.json({ success: false, error: 'Not Found' }, { status: 404 });
    }

    // ── Extract client IP ─────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
      || 'unknown';

    // ── 5. Global rate limit — 200 req / min per IP ───────────────────────
    const globalRl = checkRateLimit(`${ip}:g`, 200);
    if (!globalRl.ok) {
      const r = withSecurityHeaders(rateLimitedResponse(globalRl));
      return PUBLIC_PATHS.has(pathname)
        ? withPublicCors(r, request)
        : withCors(r, request, env);
    }

    // ── Authenticated Webflow Designer Extension surface (/api/wf/*) ──────
    // Requires a valid Webflow ID token (Authorization: Bearer <idToken>) and
    // enforces that the caller is authorized for the site they name. Reuses the
    // legacy handler logic; CSRF is not required (Bearer auth, not cookies), and
    // the mutating body is still sanitized. Responses go through the same
    // security-header + envelope-encode + credentialed-CORS pipeline.
    if (pathname.startsWith('/api/wf/')) {
      // NOTE: these routes mirror endpoints that were previously PUBLIC and are
      // therefore NOT run through sanitizeRequestBody — that recursive string
      // sanitizer mangles legitimate banner-customization content (CSS custom
      // properties like `--var`, text containing `--`, etc.) and would corrupt the
      // saved banner. Identity is enforced by the Webflow ID token below instead.
      const req = request;
      console.log(`[wf] → ${request.method} ${pathname} siteHdr=${request.headers.get('X-Webflow-Site-Id') || '-'} hasToken=${!!request.headers.get('Authorization')}`);
      const auth = await requireWebflowIdentity(req, env, {
        // oauth/status must still answer for a not-yet-authorized site (no token
        // stored) so the app can show the authorize screen. Such a site has no
        // stored data, so allowing the read leaks nothing.
        allowUnauthorizedSite: pathname === '/api/wf/oauth/status',
      });
      console.log(`[wf] ${pathname} → ${auth.ok ? 'OK' : 'DENIED ' + auth.status + ' ' + auth.code}`);
      // NOTE: these routes mirror formerly-PUBLIC endpoints, so responses are NOT
      // run through wrapAndEncodeResponse. Some handlers (e.g. banner-customization
      // GET) already envelope-encode their own body; re-encoding here double-wraps
      // it and the client decodes only the outer layer, losing the payload. The
      // frontend's parseJson transparently decodes single-encoded or plain bodies.
      if (!auth.ok) {
        const denied = withSecurityHeaders(
          Response.json({ success: false, error: auth.error, code: auth.code }, { status: auth.status })
        );
        return withCors(denied, request, env);
      }
      const sub = pathname.slice('/api/wf/'.length);
      const handler = WEBFLOW_APP_ROUTES[sub];
      if (!handler) {
        const nf = withSecurityHeaders(Response.json({ success: false, error: 'Not Found' }, { status: 404 }));
        return withCors(nf, request, env);
      }
      let wfResp;
      try {
        wfResp = await handler(req, env, ctx, auth.identity);
      } catch (err) {
        console.error('[Worker] /api/wf handler error:', err);
        wfResp = Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
      }
      return withCors(withSecurityHeaders(wfResp), request, env);
    }

    // ── Legacy Webflow-Designer endpoints — now require a valid ID token ──
    // Reject any unauthenticated caller (an attacker curling with just a siteId),
    // then fall through to the normal dispatch for authorized requests.
    if (LEGACY_WEBFLOW_AUTH_PATHS.has(pathname)) {
      const auth = await requireWebflowIdentity(request, env);
      if (!auth.ok) {
        const denied = await wrapAndEncodeResponse(
          withSecurityHeaders(
            Response.json({ success: false, error: auth.error, code: auth.code }, { status: auth.status })
          )
        );
        return PUBLIC_PATHS.has(pathname)
          ? withPublicCors(denied, request)
          : withCors(denied, request, env);
      }
      // authorized → continue to the standard pipeline / dispatch below
    }

    // Additional throttling for high-volume public analytics endpoint.
    // Defense-in-depth: prevents API spamming / fake analytics / resource exhaustion.
    if (pathname === '/api/pageview') {
      // 60 requests/min per IP for pageview posts (in addition to the global 200/min).
      const pvRl = checkRateLimit(`${ip}:pv`, 60);
      if (!pvRl.ok) {
        const r = withSecurityHeaders(rateLimitedResponse(pvRl));
        return withPublicCors(r, request);
      }
    }

    // ── 7. Brute-force protection — 10 req / min per IP on auth endpoints ─
    if (AUTH_RATE_PATHS.has(pathname)) {
      const authRl = checkRateLimit(`${ip}:auth:${pathname}`, 10);
      if (!authRl.ok) {
        return withCors(withSecurityHeaders(rateLimitedResponse(authRl)), request, env);
      }
    }

    // ── 3. CSRF check — mutating requests on non-exempt endpoints ─────────
    const isMutating = !['GET', 'HEAD'].includes(request.method);
    if (isMutating && !CSRF_EXEMPT_PATHS.has(pathname)) {
      if (!validateCsrf(request)) {
        const r = withCors(
          withSecurityHeaders(
            Response.json(
              { d: (() => { const b = new TextEncoder().encode(JSON.stringify({ success: false, error: 'Forbidden: CSRF validation failed.', code: 'CSRF_INVALID' })); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); })() },
              { status: 403 }
            )
          ),
          request, env
        );
        return r;
      }
    }

    // ── 1 & 2. Sanitize request body (non-public POST/PUT/PATCH) ──────────
    if (isMutating && !PUBLIC_PATHS.has(pathname) && pathname !== '/api/webhooks/stripe') {
      request = await sanitizeRequestBody(request);
    }

    // ── Route dispatch ────────────────────────────────────────────────────
    let response, isPublic;
    try {
      ({ response, isPublic } = await dispatchApiRoute(pathname, request, env, ctx));
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
      response = Response.json({ success: false, error: 'Internal server error' }, { status: 500 });
      // Preserve the endpoint's public-ness on error so public routes still get
      // withPublicCors (any-origin). Forcing false here routes the 500 through the
      // credentialed allowlist, which drops CORS headers for non-allowlisted
      // origins (e.g. the Webflow Designer extension) — the browser then reports a
      // masked "Failed to fetch" instead of the real error.
      isPublic = PUBLIC_PATHS.has(pathname);
    }

    // ── 8. Apply security headers ─────────────────────────────────────────
    response = withSecurityHeaders(response);

    // ── 10. Encode protected responses (not public CDN endpoints) ─────────
    if (!isPublic && pathname !== '/api/webhooks/stripe') {
      response = await wrapAndEncodeResponse(response);
    }

    // ── 6. Apply CORS ─────────────────────────────────────────────────────
    return isPublic
      ? withPublicCors(response, request)
      : withCors(response, request, env);
  },
};
