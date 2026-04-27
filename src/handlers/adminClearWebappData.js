// src/handlers/adminClearWebappData.js
// Clears all user/site data from CONSENT_WEBAPP D1.
// PROTECTED tables (never touched): Plan, PromoCode.
import { checkAdminAuth } from '../utils/adminAuth.js';

const TABLES_TO_CLEAR = [
  'Consent',
  'Cookie',
  'Script',
  'ScanHistory',
  'ScanUsage',
  'ScheduledScan',
  'PageviewUsage',
  'BannerCustomization',
  'CustomCookieRule',
  'Feedback',
  'LicenseActivation',
  'OrganizationMember',
  'Session',
  'EmailVerificationCode',
  'Subscription',
  'PaymentEvent',
  'ProcessedPaymentIntent',
  'SubscriptionQueue',
  'Site',
  'Organization',
  'User',
];

export async function handleAdminClearWebappData(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  const results = [];
  for (const table of TABLES_TO_CLEAR) {
    try {
      if (!dryRun) {
        await db.prepare(`DELETE FROM ${table}`).run();
      }
      results.push({ table, status: dryRun ? 'dry-run' : 'cleared' });
    } catch (err) {
      // Table may not exist yet — non-fatal
      results.push({ table, status: 'skipped', reason: err?.message });
    }
  }

  return Response.json({ success: true, dryRun, results });
}
