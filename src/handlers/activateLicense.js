// POST /api/licenses/activate
// Body: { licenseKey, siteId, organizationId }
// Links a license key to a site (activates it). Once activated, the key is no longer available for selection.

import { getSessionById, getUserById, activateLicense, getLicenseActivation, getSubscriptionsByOrganization } from '../services/db.js';

function getLicenseKeysFromRow(row) {
  let raw = row?.licensekeys ?? row?.licenseKeys ?? row?.license_keys ?? null;
  if (!raw) {
    const k = Object.keys(row || {}).find((key) => key.toLowerCase() === 'licensekeys');
    if (k) raw = row[k];
  }
  if (!raw) return [];
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch (_) {
    return [];
  }
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleActivateLicense(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'Database not available' }, { status: 503 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const licenseKey = (body.licenseKey || '').trim();
  const siteId = (body.siteId || '').trim();
  const organizationId = (body.organizationId || '').trim();

  if (!licenseKey || !siteId || !organizationId) {
    return Response.json({ success: false, error: 'licenseKey, siteId, and organizationId are required' }, { status: 400 });
  }

  const existing = await getLicenseActivation(db, licenseKey);
  if (existing) {
    return Response.json({ success: false, error: 'License key is already activated' }, { status: 400 });
  }

  const subs = await getSubscriptionsByOrganization(db, organizationId);
  const hasLicense = subs.some((s) => {
    const key = s.licenseKey ?? s.licensekey;
    if (key === licenseKey) return true;
    const keys = getLicenseKeysFromRow(s);
    return keys.includes(licenseKey);
  });
  if (!hasLicense) {
    return Response.json({ success: false, error: 'License key not found for this organization' }, { status: 404 });
  }

  const sub = subs.find((s) => {
    const key = s.licenseKey ?? s.licensekey;
    if (key === licenseKey) return true;
    return getLicenseKeysFromRow(s).includes(licenseKey);
  });
  const subscriptionId = sub?.id ?? null;

  const result = await activateLicense(db, { licenseKey, siteId, organizationId, subscriptionId });
  if (!result) {
    return Response.json({ success: false, error: 'Failed to activate license' }, { status: 500 });
  }

  return Response.json({ success: true, message: 'License activated' });
}
