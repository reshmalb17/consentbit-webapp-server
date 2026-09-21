// src/handlers/adminVoidCancelledInvoices.js
//
// One-off backfill: void still-payable invoices on subscriptions that were ALREADY cancelled
// before the webhook started doing it (services/cancelledInvoiceVoid.js).
//
// POST /api/admin/void-cancelled-invoices
// Headers: X-Admin-Key: <ADMIN_SECRET>
// Query:
//   ?dryRun=false   actually void. ANY other value — including omitting it — is a dry run.
//                   Deliberately the opposite default to adminBackfillStripeSubscriptions:
//                   this one mutates live Stripe invoices and cannot be undone.
//   ?limit=25       subscriptions per call (1–100). Each costs one Stripe list call plus one
//                   void per invoice, so keep batches small to stay inside subrequest limits.
//   ?offset=0       page through with the `nextOffset` returned by each call.
//
// Does not depend on CANCEL_INVOICE_VOID_MODE: dryRun here is explicit per call.
//
// Recommended use: run the whole set with dryRun (the default), review the invoices and
// `totalAmountRemaining`, then re-run with dryRun=false.

import { checkAdminAuth } from '../utils/adminAuth.js';
import { TERMINAL_SUBSCRIPTION_STATUSES } from '../utils/subscriptionStatus.js';
import { voidOpenInvoicesForCancelledSubscription } from '../services/cancelledInvoiceVoid.js';

export async function handleAdminVoidCancelledInvoices(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  if (!env.STRIPE_SECRET_KEY) {
    return Response.json({ success: false, error: 'STRIPE_SECRET_KEY not configured' }, { status: 503 });
  }
  if (!env.CONSENT_WEBAPP) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP D1 not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') !== 'false';
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10) || 25));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const db = env.CONSENT_WEBAPP;

  const placeholders = TERMINAL_SUBSCRIPTION_STATUSES.map((_, i) => `?${i + 1}`).join(', ');
  const { results = [] } = await db
    .prepare(
      `SELECT id, organizationId, stripeSubscriptionId, status
         FROM Subscription
        WHERE LOWER(status) IN (${placeholders})
          AND stripeSubscriptionId IS NOT NULL AND stripeSubscriptionId != ''
        ORDER BY createdAt, id
        LIMIT ?${TERMINAL_SUBSCRIPTION_STATUSES.length + 1}
       OFFSET ?${TERMINAL_SUBSCRIPTION_STATUSES.length + 2}`
    )
    .bind(...TERMINAL_SUBSCRIPTION_STATUSES, limit, offset)
    .all();

  const report = {
    success: true,
    dryRun,
    offset,
    limit,
    scanned: results.length,
    nextOffset: results.length === limit ? offset + limit : null,
    subscriptionsWithPayableInvoices: 0,
    invoicesFound: 0,
    invoicesVoided: 0,
    invoicesFailed: 0,
    totalAmountRemaining: 0,
    errors: [],
    details: [],
  };

  // Sequential on purpose: keeps Stripe calls and Worker subrequests predictable.
  for (const row of results) {
    const r = await voidOpenInvoicesForCancelledSubscription(env, db, {
      stripeSubscriptionId: row.stripeSubscriptionId ?? row.stripesubscriptionid,
      subscriptionId: row.id,
      organizationId: row.organizationId ?? row.organizationid ?? null,
      mode: dryRun ? 'dry-run' : 'on',
      source: 'backfill',
    });

    if (r.error) {
      report.errors.push({ stripeSubscriptionId: r.stripeSubscriptionId, error: r.error });
    }
    if (r.found > 0) {
      report.subscriptionsWithPayableInvoices++;
      report.invoicesFound += r.found;
      report.invoicesVoided += r.voided;
      report.invoicesFailed += r.failed;
      report.totalAmountRemaining += r.invoices.reduce((n, i) => n + (Number(i.amountRemaining) || 0), 0);
      report.details.push({
        subscriptionId: row.id,
        stripeSubscriptionId: r.stripeSubscriptionId,
        status: row.status,
        invoices: r.invoices,
      });
    }
  }

  return Response.json(report);
}
