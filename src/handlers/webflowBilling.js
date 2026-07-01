// src/handlers/webflowBilling.js
//
// Authless, siteId-keyed billing for the Webflow Designer Extension (mirrors the
// authless model of /api/webflow/oauth/status and /api/payment/subscription).
// Resolves the subscription from a Webflow siteId (platformSiteId) or internal
// webapp siteId, then talks to Stripe.
//
//   GET  /api/webflow/billing?siteId=<id>     → plan + status + real Stripe invoices
//   POST /api/webflow/cancel-subscription     body { siteId } → cancel at period end

const TAG = '[webflow-billing]';

// Resolve the internal Site row from a wfSiteId (platformSiteId) OR internal site id.
async function resolveSite(db, siteId) {
  if (!siteId) return null;
  return db
    .prepare('SELECT id, organizationId FROM Site WHERE id = ?1 OR platformSiteId = ?1 ORDER BY createdAt ASC LIMIT 1')
    .bind(siteId)
    .first()
    .catch(() => null);
}

// The subscription for a site → fall back to the org's active/trialing subscription.
async function resolveSubscription(db, site) {
  if (!site) return null;
  const cols =
    'id, organizationId, siteId, planId, planType, status, stripeSubscriptionId, stripeCustomerId, interval, currentPeriodEnd, cancelAtPeriodEnd';
  let sub = await db
    .prepare(`SELECT ${cols} FROM Subscription WHERE siteId = ?1 LIMIT 1`)
    .bind(site.id)
    .first()
    .catch(() => null);
  if (!sub && site.organizationId) {
    sub = await db
      .prepare(
        `SELECT ${cols} FROM Subscription WHERE organizationId = ?1 AND lower(status) IN ('active','trialing') ORDER BY createdAt DESC LIMIT 1`,
      )
      .bind(site.organizationId)
      .first()
      .catch(() => null);
  }
  return sub;
}

function pick(sub, camel, snake) {
  return sub?.[camel] ?? sub?.[snake] ?? null;
}

// GET /api/webflow/billing?siteId=<wfSiteId | webappSiteId>
export async function handleWebflowBilling(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });

  const url = new URL(request.url);
  const siteId = (url.searchParams.get('siteId') || '').trim();
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  const site = await resolveSite(db, siteId);
  const sub = await resolveSubscription(db, site);
  if (!sub) {
    return Response.json({ success: true, plan: 'free', status: null, invoices: [], stripeSubscriptionId: null });
  }

  const stripeSubscriptionId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  const stripeCustomerId = pick(sub, 'stripeCustomerId', 'stripecustomerid');
  const planId = pick(sub, 'planId', 'planid');
  const cancelRaw = pick(sub, 'cancelAtPeriodEnd', 'cancelatperiodend');

  let invoices = [];
  if (stripeCustomerId && env.STRIPE_SECRET_KEY) {
    try {
      const res = await fetch(
        `https://api.stripe.com/v1/invoices?customer=${stripeCustomerId}&limit=20`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      const data = await res.json();
      invoices = (data.data || []).map((inv) => ({
        id: inv.id,
        number: inv.number || null,
        status: inv.status || null,
        amountPaid: inv.amount_paid ?? 0,
        amountDue: inv.amount_due ?? 0,
        currency: (inv.currency || 'usd').toUpperCase(),
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        hostedInvoiceUrl: inv.hosted_invoice_url || null,
        invoicePdf: inv.invoice_pdf || null,
      }));
    } catch (e) {
      console.warn(`${TAG} invoice fetch failed`, e?.message);
    }
  }

  return Response.json({
    success: true,
    plan: planId || 'free',
    status: pick(sub, 'status', 'status'),
    interval: pick(sub, 'interval', 'interval'),
    currentPeriodEnd: pick(sub, 'currentPeriodEnd', 'currentperiodend'),
    cancelAtPeriodEnd: cancelRaw === 1 || cancelRaw === true || cancelRaw === '1',
    stripeSubscriptionId,
    invoices,
  });
}

// POST /api/webflow/cancel-subscription   body: { siteId }
// Cancels at period end (keeps access until the paid period ends).
export async function handleWebflowCancelSubscription(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }
  const db = env.CONSENT_WEBAPP;
  if (!db) return Response.json({ success: false, error: 'Database unavailable' }, { status: 503 });
  if (!env.STRIPE_SECRET_KEY) return Response.json({ success: false, error: 'Stripe not configured' }, { status: 503 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }); }
  const siteId = (body.siteId || '').trim();
  if (!siteId) return Response.json({ success: false, error: 'siteId required' }, { status: 400 });

  const site = await resolveSite(db, siteId);
  const sub = await resolveSubscription(db, site);
  const stripeSubscriptionId = pick(sub, 'stripeSubscriptionId', 'stripesubscriptionid');
  if (!stripeSubscriptionId) {
    return Response.json({ success: false, error: 'No active subscription found for this site.' }, { status: 400 });
  }

  const params = new URLSearchParams();
  params.set('cancel_at_period_end', 'true');
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubscriptionId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (data.error) {
    console.error(`${TAG} Stripe cancel error`, data.error?.message);
    return Response.json({ success: false, error: data.error.message || 'Stripe error' }, { status: 502 });
  }

  try {
    await db
      .prepare('UPDATE Subscription SET cancelAtPeriodEnd = 1, updatedAt = ?1 WHERE stripeSubscriptionId = ?2')
      .bind(new Date().toISOString(), stripeSubscriptionId)
      .run();
  } catch (e) {
    console.warn(`${TAG} D1 update failed (non-fatal)`, e?.message);
  }

  return Response.json({
    success: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: data.current_period_end ? new Date(data.current_period_end * 1000).toISOString() : null,
  });
}
