// src/index.js
import { handleSites } from './handlers/sites.js';
import { handleCDNScript } from './handlers/cdn.js';
import { handleEmbedFloatingLogo } from './handlers/embedFloatingLogo.js';
import { handleConsent } from './handlers/consent.js';
import { handleScanScripts } from './handlers/scanScripts.js';
import { handleScanCookies } from './handlers/scanCookies.js';
import { handleVerifyScript } from './handlers/verifyScript.js';
import { handlePageview } from './handlers/pageview.js';
import { handleScanHistory } from './handlers/scanHistory.js';
import { handleCookies } from './handlers/cookies.js';
import { handleMarkVerified } from './handlers/markVerified.js';
import { handleScanSite } from './handlers/scanSite.js';
import { handleBannerCustomization } from './handlers/bannerCustomization.js';
import { handleScheduledScan } from './handlers/scheduledScan.js';
import { handleConsentLogs } from './handlers/consentLogs.js';
import { handleValidatePromo } from './handlers/validatePromo.js';
import { handleCreateCheckoutSession } from './handlers/createCheckoutSession.js';
import { handleStripeWebhook } from './handlers/stripeWebhook.js';
import { reportStripeMeteredUsage } from './handlers/reportStripeUsage.js';
import { handleLicenses } from './handlers/licenses.js';
import { handleActivateLicense } from './handlers/activateLicense.js';
import { handleCancelSubscription } from './handlers/cancelSubscription.js';
import { handleDebugSchema } from './handlers/debugSchema.js';
import { handleBillingSummary, handleBillingPortal, handleBillingInvoices, handleBillingUsage } from './handlers/billing.js';
import { handleCustomCookieRules } from './handlers/customCookieRules.js';
import { handleScanPending } from './handlers/scanPending.js';

import { handleAuthDashboardInit } from './handlers/authDashboardInit.js';
import { handleAuthLogin } from './handlers/authLogin.js';
import { handleAuthSignup } from './handlers/authSignup.js';
import { handleAuthMe } from './handlers/authMe.js';
import { handleAuthRequestCode } from './handlers/authRequestCode.js';
import { handleAuthVerifyCode } from './handlers/authVerifyCode.js';
import { handleAuthLogout } from './handlers/authLogout.js';
import { handleOnboardingFirstSetup } from './handlers/onboardingFirstSetup.js';

import { handleOptions, withCors, withPublicCors } from './utils/cors.js';
import {
  checkRateLimit,
  rateLimitedResponse,
  validateCsrf,
  sanitizeRequestBody,
  wrapAndEncodeResponse,
  withSecurityHeaders,
} from './middleware/security.js';
import {
  ensureSchema,
  getDueScheduledScans,
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
} from './services/db.js';

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
  '/api/scan-scripts',
  '/api/scan-cookies',
  '/api/pageview',
  '/api/scan-site',
  '/api/scan-pending',
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
      response = await handleConsent(request, env); break;
    case '/api/scan-scripts':
      response = await handleScanScripts(request, env); break;
    case '/api/scan-cookies':
      response = await handleScanCookies(request, env); break;
    case '/api/pageview':
      response = await handlePageview(request, env); break;
    case '/api/scan-site':
      response = await handleScanSite(request, env, ctx); break;
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

    // — Onboarding
    case '/api/onboarding/first-setup':
      response = await handleOnboardingFirstSetup(request, env, ctx); break;

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

    // — Consent logs
    case '/api/consent-logs':
      response = await handleConsentLogs(request, env); break;

    // — Billing / payments
    case '/api/validate-promo':
      response = await handleValidatePromo(request, env); break;
    case '/api/create-checkout-session':
      response = await handleCreateCheckoutSession(request, env); break;
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
    case '/api/subscriptions/cancel':
      response = await handleCancelSubscription(request, env); break;

    // — Webhooks (own auth mechanism — Stripe signature)
    case '/api/webhooks/stripe':
      response = await handleStripeWebhook(request, env, ctx); break;

    // — Debug (should be disabled in production via env guard inside the handler)
    case '/api/debug/schema':
      response = await handleDebugSchema(request, env); break;

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

async function executeScheduledScans(env) {
  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);
  try {
    const now = new Date().toISOString();
    const scheduledScans = await getDueScheduledScans(db);
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
            console.log(`[Cron] Skipping scheduled scan ${scheduledScan.id} — scan limit reached for site (${scanUsage.scanCount}/${scansLimit})`);
            executed.push({ id: scheduledScan.id, status: 'skipped', reason: 'scan_limit_reached' });
            continue;
          }
        }

        const scanRequest = new Request('https://internal/scan-site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: scheduledScan.siteId }),
        });
        await handleScanSite(scanRequest, env);
        if (scheduledScan.frequency === 'once') {
          await deactivateScheduledScan(db, scheduledScan.id, now);
          executed.push({ id: scheduledScan.id, status: 'completed', deactivated: true });
        } else {
          const nextRunAt = calculateNextRunAt(scheduledScan.scheduledAt, scheduledScan.frequency, scheduledScan.nextRunAt);
          await updateScheduledScanAfterRun(db, scheduledScan.id, now, nextRunAt);
          executed.push({ id: scheduledScan.id, status: 'completed' });
        }
      } catch (err) {
        console.error(`[Cron] Failed to execute scheduled scan ${scheduledScan.id}:`, err);
        executed.push({ id: scheduledScan.id, status: 'failed', error: err.message });
      }
    }
    console.log(`[Cron] Executed ${executed.length} scheduled scans`);
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
  console.log('[Cron] subscription queue:', pending.length, 'pending');
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
        console.log('[Cron] Created subscription', data.id, 'licenseKey', licenseKey);
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
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        executeScheduledScans(env),
        processSubscriptionQueue(env),
        reportStripeMeteredUsage(env),
      ])
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
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

    // ── Only continue for /api/ routes ────────────────────────────────────
    if (!pathname.startsWith('/api/')) {
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
      isPublic = false;
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
