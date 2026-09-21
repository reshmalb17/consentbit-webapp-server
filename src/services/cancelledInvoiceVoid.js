// src/services/cancelledInvoiceVoid.js
//
// Void the still-payable invoices of a cancelled subscription.
//
// WHY
// When Stripe exhausts its retries and cancels a subscription, the unpaid invoice is NOT
// closed. It stays `open` and permanently payable through its hosted_invoice_url. A customer
// can pay it, see "Paid", and receive nothing — the subscription it belonged to no longer
// exists and cannot be revived. Unity Gym paid $9 this way on 2026-08-27, two days after
// cancellation. See consent-manager/docs/SUBSCRIPTION_SYNC_WORKFLOW.md §3b.
//
// Marking an invoice `uncollectible` is not enough: an uncollectible invoice can still be
// paid. Only `void` makes it unpayable. Stripe allows voiding from `open` or `uncollectible`.
//
// TRADE-OFF
// Voiding forgoes collecting that amount. That is the intended behaviour — a payment that
// cannot restore service should not be takeable — but the dry-run report includes
// `amount_remaining` so the revenue involved is visible before switching this on.
//
// MODE — env CANCEL_INVOICE_VOID_MODE, same convention as CONSENT_RETENTION_MODE:
//   unset / 'off'  → do nothing
//   'dry-run'      → find the invoices and record what WOULD be voided; change nothing
//   'on'           → void them
//
// Never throws. Every outcome — including skips and errors — is written to PaymentEvent so it
// is queryable. A console.warn inside ctx.waitUntil is invisible unless someone is tailing,
// which is exactly how the legacy-sync failure went unnoticed.

import { savePaymentEvent } from './db.js';
import { flowLog } from '../utils/flowLog.js';

const VOIDABLE_STATUSES = new Set(['open', 'uncollectible']);

/** Normalised mode from env. Anything unrecognised is treated as off. */
export function resolveVoidMode(env, override = null) {
  const raw = String(override ?? env?.CANCEL_INVOICE_VOID_MODE ?? '').trim().toLowerCase();
  if (raw === 'on' || raw === 'dry-run') return raw;
  return 'off';
}

async function stripeRequest(env, method, path, body = null) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && !json?.error, status: res.status, body: json };
}

/**
 * Find (and, in 'on' mode, void) every payable invoice for one cancelled subscription.
 *
 * @param {object} env
 * @param {object} db    D1 binding, for recording outcomes
 * @param {object} opts
 * @param {string} opts.stripeSubscriptionId  required
 * @param {string} [opts.subscriptionId]      our D1 Subscription.id, for the audit row
 * @param {string} [opts.organizationId]
 * @param {'off'|'dry-run'|'on'} [opts.mode]   defaults to env CANCEL_INVOICE_VOID_MODE
 * @param {string} [opts.source]              'webhook' | 'backfill', for the audit row
 * @returns {Promise<{mode, stripeSubscriptionId, found, voided, failed, invoices, skipped?, error?}>}
 */
export async function voidOpenInvoicesForCancelledSubscription(env, db, opts = {}) {
  const {
    stripeSubscriptionId,
    subscriptionId = null,
    organizationId = null,
    source = 'webhook',
  } = opts;
  const mode = resolveVoidMode(env, opts.mode);
  const summary = { mode, stripeSubscriptionId, found: 0, voided: 0, failed: 0, invoices: [] };

  if (mode === 'off') return { ...summary, skipped: 'mode-off' };
  if (!stripeSubscriptionId) {
    flowLog(env, 'invoiceVoid', 'skipped', { reason: 'no-stripe-subscription-id', source, subscriptionId });
    return { ...summary, skipped: 'no-stripe-subscription-id' };
  }
  if (!env?.STRIPE_SECRET_KEY) {
    flowLog(env, 'invoiceVoid', 'skipped', { reason: 'no-stripe-key', source, stripeSubscriptionId });
    return { ...summary, skipped: 'no-stripe-key' };
  }

  try {
    // No `status` filter: Stripe's list accepts a single status, and both `open` and
    // `uncollectible` are payable. Filter locally instead.
    const list = await stripeRequest(
      env,
      'GET',
      `/invoices?subscription=${encodeURIComponent(stripeSubscriptionId)}&limit=100`,
    );
    if (!list.ok) {
      summary.error = list.body?.error?.message || `invoice list failed (HTTP ${list.status})`;
      await record(db, summary, { subscriptionId, organizationId, source });
      return summary;
    }

    const payable = (list.body?.data || []).filter((inv) => VOIDABLE_STATUSES.has(inv.status));
    summary.found = payable.length;

    for (const inv of payable) {
      const entry = {
        id: inv.id,
        number: inv.number ?? null,
        status: inv.status,
        amountRemaining: inv.amount_remaining ?? null,
        currency: inv.currency ?? null,
        created: inv.created ?? null,
      };

      if (mode === 'dry-run') {
        entry.action = 'would-void';
        summary.invoices.push(entry);
        continue;
      }

      const res = await stripeRequest(env, 'POST', `/invoices/${encodeURIComponent(inv.id)}/void`, '');
      if (res.ok) {
        entry.action = 'voided';
        summary.voided++;
      } else {
        // e.g. a payment is mid-processing — Stripe refuses to void. Leave it and report.
        entry.action = 'void-failed';
        entry.error = res.body?.error?.message || `HTTP ${res.status}`;
        summary.failed++;
      }
      summary.invoices.push(entry);
    }
  } catch (e) {
    summary.error = e?.message || String(e);
  }

  await record(db, summary, { subscriptionId, organizationId, source });
  flowLog(env, 'invoiceVoid', summary.error ? 'error' : mode === 'dry-run' ? 'dry-run' : 'done', {
    source,
    stripeSubscriptionId,
    subscriptionId,
    found: summary.found,
    voided: summary.voided,
    failed: summary.failed,
    amountRemaining: summary.invoices.reduce((n, i) => n + (Number(i.amountRemaining) || 0), 0),
    invoices: summary.invoices.map((i) => ({ id: i.id, status: i.status, action: i.action })),
    error: summary.error || null,
  });
  return summary;
}

/** Audit row. Written for every run that got past the mode check, including zero finds. */
async function record(db, summary, { subscriptionId, organizationId, source }) {
  if (!db) return;
  try {
    const total = summary.invoices.reduce((n, i) => n + (Number(i.amountRemaining) || 0), 0);
    await savePaymentEvent(db, {
      eventType: summary.mode === 'dry-run' ? 'invoice.void_on_cancel.dry_run' : 'invoice.void_on_cancel',
      subscriptionId,
      organizationId,
      amountCents: total || null,
      failureReason: summary.error || (summary.failed ? `${summary.failed} invoice(s) could not be voided` : null),
      rawPayload: {
        source,
        stripeSubscriptionId: summary.stripeSubscriptionId,
        found: summary.found,
        voided: summary.voided,
        failed: summary.failed,
        invoices: summary.invoices,
      },
    });
  } catch (e) {
    // Last resort only — the audit write itself failed.
    console.warn('[InvoiceVoid] could not record outcome:', e?.message);
  }
}
