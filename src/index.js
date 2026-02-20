// src/index.js
import { handleSites } from './handlers/sites.js';
import { handleCDNScript } from './handlers/cdn.js';
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
import { handleLicenses } from './handlers/licenses.js';
import { handleActivateLicense } from './handlers/activateLicense.js';
import { handleCancelSubscription } from './handlers/cancelSubscription.js';

import { handleAuthLogin } from './handlers/authLogin.js';
import { handleAuthSignup } from './handlers/authSignup.js';
import { handleAuthMe } from './handlers/authMe.js';
import { handleOnboardingFirstSetup } from './handlers/onboardingFirstSetup.js';

import { handleOptions, withCors, withPublicCors } from './utils/cors.js';
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
} from './services/db.js';

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
    
    // Find all scheduled scans that are due
    const scheduledScans = await getDueScheduledScans(db);

    const executed = [];
    
    for (const scheduledScan of scheduledScans) {
      try {
        // Execute the scan by calling handleScanSite
        const scanRequest = new Request('https://internal/scan-site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: scheduledScan.siteId }),
        });
        
        await handleScanSite(scanRequest, env);
        
        // Update scheduled scan based on frequency
        if (scheduledScan.frequency === 'once') {
          // Deactivate one-time scans after running
          await deactivateScheduledScan(db, scheduledScan.id, now);
          executed.push({ id: scheduledScan.id, status: 'completed', deactivated: true });
        } else {
          // Calculate next run time for recurring scans
          const nextRunAt = calculateNextRunAt(
            scheduledScan.scheduledAt, 
            scheduledScan.frequency, 
            scheduledScan.nextRunAt
          );
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
  try {
    await ensureSchema(db);
  } catch (err) {
    console.error('[Cron] processSubscriptionQueue ensureSchema failed', err);
    return;
  }
  const pending = await getPendingSubscriptionQueue(db, 4);
  console.log('[Cron] subscription queue:', pending.length, 'pending');
  if (pending.length === 0) return;
  console.log('[Cron] Processing', pending.length, 'subscription queue items');
  for (const row of pending) {
    const id = getRow(row, 'id');
    const organizationId = getRow(row, 'organizationId');
    const stripeCustomerId = getRow(row, 'stripeCustomerId');
    const licenseKey = getRow(row, 'licenseKey');
    const recurringPriceId = getRow(row, 'recurringPriceId');
    const interval = getRow(row, 'interval');
    const trialEnd = getRow(row, 'trialEnd');
    try {
      const params = new URLSearchParams();
      params.set('customer', stripeCustomerId);
      params.set('items[0][price]', recurringPriceId);
      params.set('items[0][quantity]', '1');
      params.set('trial_end', String(trialEnd));
      params.set('metadata[organizationId]', organizationId);
      params.set('metadata[planType]', 'bulk');
      params.set('metadata[license_key]', licenseKey);
      const res = await fetch('https://api.stripe.com/v1/subscriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
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
          currentPeriodEnd: toTimestamp(data.current_period_end),
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

export default {
  // Cron trigger handler - runs every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([executeScheduledScans(env), processSubscriptionQueue(env)]));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) CORS preflight for API
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return handleOptions(request);
    }

    // 2) CDN script (no CORS)
    if (url.pathname.startsWith('/client_data/')) {
      return handleCDNScript(request, env, url);
    }

    let response;

    // 3) API routes
    if (url.pathname === '/api/sites') {
      response = await handleSites(request, env);
    } else if (url.pathname === '/api/consent') {
      response = await handleConsent(request, env);
      return withPublicCors(response, request);
    } else if (url.pathname === '/api/scan-scripts') {
      response = await handleScanScripts(request, env);
      return withPublicCors(response, request); // Public endpoint - allow any origin
    } else if (url.pathname === '/api/scan-cookies') {
      response = await handleScanCookies(request, env);
      return withPublicCors(response, request); // Public endpoint - allow any origin
    } else if (url.pathname === '/api/pageview') {
      response = await handlePageview(request, env);
      return withPublicCors(response, request); // Public endpoint - allow any origin
    } else if (url.pathname === '/api/scan-history') {
      response = await handleScanHistory(request, env);
    } else if (url.pathname === '/api/cookies') {
      response = await handleCookies(request, env);
    } else if (url.pathname === '/api/mark-verified') {
      response = await handleMarkVerified(request, env);
    } else if (url.pathname === '/api/scan-site') {
      response = await handleScanSite(request, env);
    
      return withPublicCors(response, request);
    } else if (url.pathname === '/api/verify-script') {
      response = await handleVerifyScript(request, env);
    } else if (url.pathname === '/api/auth/login') {
      response = await handleAuthLogin(request, env);
      return withCors(response, request);
    } else if (url.pathname === '/api/auth/signup') {
      response = await handleAuthSignup(request, env);
      return withCors(response, request);
    } else if (url.pathname === '/api/auth/me') {
      response = await handleAuthMe(request, env);
      return withCors(response, request);
    } else if (url.pathname === '/api/onboarding/first-setup') {
      response = await handleOnboardingFirstSetup(request, env);
    } else if (url.pathname === '/api/banner-customization') {
      response = await handleBannerCustomization(request, env);
    } else if (url.pathname === '/api/scheduled-scan') {
      response = await handleScheduledScan(request, env);
    } else if (url.pathname === '/api/consent-logs') {
      response = await handleConsentLogs(request, env);
    } else if (url.pathname === '/api/validate-promo') {
      response = await handleValidatePromo(request, env);
    } else if (url.pathname === '/api/create-checkout-session') {
      response = await handleCreateCheckoutSession(request, env);
    } else if (url.pathname === '/api/licenses') {
      response = await handleLicenses(request, env);
    } else if (url.pathname === '/api/licenses/activate') {
      response = await handleActivateLicense(request, env);
    } else if (url.pathname === '/api/subscriptions/cancel') {
      response = await handleCancelSubscription(request, env);
    } else if (url.pathname === '/api/webhooks/stripe') {
      response = await handleStripeWebhook(request, env);
    }
     else {
      response = Response.json({ success: false, error: 'Not Found' }, { status: 404 });
    }


    // 4) Add CORS to all /api responses (except those already handled above)
    if (url.pathname.startsWith('/api/')) {
      return withCors(response, request);
    }

    return response;
  },
};
