// Billing APIs: summary, portal, invoices, usage
// All require auth and organizationId (user must belong to org).

import {
  ensureSchema,
  getSessionById,
  getUserById,
  getSubscriptionByOrganization,
  getSubscriptionsByOrganization,
  getPageviewUsageForOrganization,
  getScanUsageForOrganization,
  getSitesCountByOrganization,
  getPlanById,
  getEffectivePlanForOrganization,
  getOrganizationMember,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

async function requireAuth(request, env) {
  const db = env.CONSENT_WEBAPP;
  const sid = getSessionIdFromCookie(request);
  if (!sid) return { ok: false, status: 401, body: { error: 'Login required' } };
  const session = await getSessionById(db, sid);
  if (!session) return { ok: false, status: 401, body: { error: 'Login required' } };
  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) return { ok: false, status: 401, body: { error: 'Login required' } };
  return { ok: true, user, db };
}

async function requireOrgAccess(db, userId, organizationId) {
  if (!organizationId) return { allowed: false };
  const member = await getOrganizationMember(db, userId, organizationId);
  return { allowed: !!member };
}

function planDisplayName(planType, planId) {
  if (planId && ['basic', 'essential', 'growth'].includes(planId)) {
    return planId.charAt(0).toUpperCase() + planId.slice(1);
  }
  const map = { single: 'Pro Single', quantity: 'Pro Quantity', bulk: 'Pro Bulk', tier: 'Pro' };
  return map[planType] || planType || 'Free';
}

// GET /api/billing/summary?organizationId=xxx
export async function handleBillingSummary(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const auth = await requireAuth(request, env);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });
  const { db } = auth;
  const url = new URL(request.url);
  const organizationId = (url.searchParams.get('organizationId') || '').trim();
  if (!organizationId) {
    return Response.json({ error: 'organizationId required' }, { status: 400 });
  }
  const access = await requireOrgAccess(db, auth.user.id, organizationId);
  if (!access.allowed) {
    return Response.json({ error: 'Not allowed for this organization' }, { status: 403 });
  }

  await ensureSchema(db);
  const sub = await getSubscriptionByOrganization(db, organizationId);
  if (!sub) {
    const { plan } = await getEffectivePlanForOrganization(db, organizationId);
    return Response.json({
      planName: 'Free',
      planId: 'free',
      planType: 'free',
      interval: null,
      licenseCount: 0,
      nextBillingDate: null,
      amountCents: null,
      cancelAtPeriodEnd: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      paymentMethod: null,
      domainsLimit: plan ? (plan.domainsIncluded ?? plan.domainsincluded ?? 1) : 1,
    });
  }

  const stripeSubId = sub.stripeSubscriptionId ?? sub.stripesubscriptionid ?? null;
  const stripeCustomerId = sub.stripeCustomerId ?? sub.stripecustomerid ?? null;
  const planType = String(sub.planType ?? sub.plantype ?? 'single').toLowerCase();
  const planId = sub.planId ?? sub.planid ?? null;
  const interval = sub.interval ?? 'monthly';
  const cancelAtPeriodEnd = !!(sub.cancelAtPeriodEnd ?? sub.cancelatperiodend);
  const currentPeriodEnd = sub.currentPeriodEnd ?? sub.currentperiodend ?? null;

  let nextBillingDate = currentPeriodEnd;
  let amountCents = sub.amountCents ?? null;
  let paymentMethod = null;

  if (env.STRIPE_SECRET_KEY && stripeSubId) {
    try {
      const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const subData = await subRes.json();
      if (!subData.error && subData.current_period_end) {
        nextBillingDate = new Date(subData.current_period_end * 1000).toISOString();
      }
      if (subData.default_payment_method) {
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods/${subData.default_payment_method}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const pm = await pmRes.json();
        if (!pm.error && pm.card) {
          paymentMethod = {
            brand: pm.card.brand || 'card',
            last4: pm.card.last4 || '',
            exp_month: pm.card.exp_month,
            exp_year: pm.card.exp_year,
          };
        }
      }
      const upRes = await fetch(`https://api.stripe.com/v1/invoices/upcoming?subscription=${stripeSubId}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const upData = await upRes.json();
      if (!upData.error && upData.amount_due != null) {
        amountCents = upData.amount_due;
      }
    } catch (e) {
      console.warn('[Billing] summary Stripe fetch failed', e.message);
    }
  }

  const subs = await getSubscriptionsByOrganization(db, organizationId);
  let licenseCount = 0;
  for (const s of subs) {
    const pt = String(s.planType ?? s.plantype ?? 'single').toLowerCase();
    if (pt === 'quantity') licenseCount += (s.quantity ?? s.Quantity ?? 0) || 0;
    else if (s.licenseKey ?? s.licensekey) licenseCount += 1;
    else if (s.licensekeys) {
      try {
        const keys = typeof s.licensekeys === 'string' ? JSON.parse(s.licensekeys) : s.licensekeys;
        licenseCount += Array.isArray(keys) ? keys.length : 0;
      } catch (_) {}
    }
  }
  if (licenseCount === 0 && sub) licenseCount = 1;

  const { plan } = await getEffectivePlanForOrganization(db, organizationId);
  const domainsLimit = plan ? (plan.domainsIncluded ?? plan.domainsincluded ?? 1) : 1;
  return Response.json({
    planName: planDisplayName(planType, planId),
    planId: planId || null,
    planType,
    interval,
    licenseCount,
    nextBillingDate,
    amountCents,
    cancelAtPeriodEnd,
    stripeCustomerId,
    stripeSubscriptionId: stripeSubId,
    paymentMethod,
    domainsLimit,
  });
}

// POST /api/billing/portal - body: { organizationId, returnUrl }
export async function handleBillingPortal(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const auth = await requireAuth(request, env);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });
  const { db } = auth;
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const organizationId = (body.organizationId || '').trim();
  const returnUrl = (body.returnUrl || body.return_url || '').trim() || request.url.replace(/\/api\/.*$/, '/');
  if (!organizationId) {
    return Response.json({ error: 'organizationId required' }, { status: 400 });
  }
  const access = await requireOrgAccess(db, auth.user.id, organizationId);
  if (!access.allowed) {
    return Response.json({ error: 'Not allowed for this organization' }, { status: 403 });
  }

  const sub = await getSubscriptionByOrganization(db, organizationId);
  const stripeCustomerId = sub && (sub.stripeCustomerId ?? sub.stripecustomerid);
  if (!stripeCustomerId || !env.STRIPE_SECRET_KEY) {
    return Response.json({ error: 'No billing customer for this organization' }, { status: 400 });
  }

  const params = new URLSearchParams();
  params.set('customer', stripeCustomerId);
  params.set('return_url', returnUrl);
  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (data.error) {
    return Response.json({ error: data.error.message || 'Stripe error' }, { status: 400 });
  }
  if (!data.url) {
    return Response.json({ error: 'No portal URL returned' }, { status: 502 });
  }
  return Response.json({ url: data.url });
}

// GET /api/billing/invoices?organizationId=xxx&limit=20
export async function handleBillingInvoices(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const auth = await requireAuth(request, env);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });
  const { db } = auth;
  const url = new URL(request.url);
  const organizationId = (url.searchParams.get('organizationId') || '').trim();
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
  if (!organizationId) {
    return Response.json({ error: 'organizationId required' }, { status: 400 });
  }
  const access = await requireOrgAccess(db, auth.user.id, organizationId);
  if (!access.allowed) {
    return Response.json({ error: 'Not allowed for this organization' }, { status: 403 });
  }

  const sub = await getSubscriptionByOrganization(db, organizationId);
  const stripeCustomerId = sub && (sub.stripeCustomerId ?? sub.stripecustomerid);
  if (!stripeCustomerId || !env.STRIPE_SECRET_KEY) {
    return Response.json({ invoices: [] });
  }

  const res = await fetch(
    `https://api.stripe.com/v1/invoices?customer=${stripeCustomerId}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  const data = await res.json();
  const list = data.data || [];
  const invoices = list.map((inv) => ({
    id: inv.id,
    number: inv.number || null,
    status: inv.status || null,
    amountDue: inv.amount_due ?? 0,
    amountPaid: inv.amount_paid ?? 0,
    created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
    hostedInvoiceUrl: inv.hosted_invoice_url || null,
    invoicePdf: inv.invoice_pdf || null,
  }));
  return Response.json({ invoices });
}

// GET /api/billing/usage?organizationId=xxx
export async function handleBillingUsage(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  const auth = await requireAuth(request, env);
  if (!auth.ok) return Response.json(auth.body, { status: auth.status });
  const { db } = auth;
  const url = new URL(request.url);
  const organizationId = (url.searchParams.get('organizationId') || '').trim();
  if (!organizationId) {
    return Response.json({ error: 'organizationId required' }, { status: 400 });
  }
  const access = await requireOrgAccess(db, auth.user.id, organizationId);
  if (!access.allowed) {
    return Response.json({ error: 'Not allowed for this organization' }, { status: 403 });
  }

  await ensureSchema(db);
  const usage = await getPageviewUsageForOrganization(db, organizationId);
  const scanUsage = await getScanUsageForOrganization(db, organizationId);
  const sitesCount = await getSitesCountByOrganization(db, organizationId);
  const { planId, plan } = await getEffectivePlanForOrganization(db, organizationId);
  const pageviewsIncluded = plan ? (plan.pageviewsIncluded ?? plan.pageviewsincluded ?? 0) : 7500;
  const scansIncluded = plan ? (plan.scansIncluded ?? plan.scansincluded ?? 0) : 100;
  const domainsIncluded = plan ? (plan.domainsIncluded ?? plan.domainsincluded ?? 1) : 1;

  return Response.json({
    yearMonth: usage.yearMonth,
    pageviewsUsed: usage.pageviewCount,
    pageviewsLimit: pageviewsIncluded,
    scansUsed: scanUsage.scanCount,
    scansLimit: scansIncluded,
    sitesUsed: sitesCount,
    sitesLimit: domainsIncluded,
    planId,
  });
}
