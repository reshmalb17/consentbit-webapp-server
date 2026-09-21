// src/services/cardPinFollow.js
//
// Keep subscription card pins in step with cards changed OUTSIDE our app.
//
// WHY
// A subscription's `default_payment_method` cannot be cleared (see stripeCardPin.js), so a
// pinned subscription keeps charging its pinned card even after the customer changes their
// default card in Stripe's billing portal (opened from our billing page, billing.js) or an
// admin changes it in the Stripe dashboard. Those change only the customer default.
//
// EVENTS (subscribed on the Stripe endpoint 2026-09-17)
//   customer.updated         — the customer's default card changed
//   payment_method.detached  — a card was removed; subscriptions pinned to it will fail
//
// RULES — decided per event by planCardFollow (pure, fully tested)
//   Old default known (pm_old → pm_new)    move subscriptions pinned to pm_old onto pm_new
//   No previous default, all on ONE card   move those onto pm_new
//   No previous default, DIFFERENT cards   leave all alone — ambiguous (e.g. an agency
//                                          paying each client's site with that client's card)
//   Default card removed                   do nothing
//   Already on pm_new                      skip
//   Only renewing subscriptions are considered: active, trialing, past_due. past_due is
//   the important one — re-pinning it lets Stripe's next retry use the new card.
//
// OUR OWN WRITES ARE IGNORED
// Checkout and our billing page set the customer default themselves, stamping
// CARD_DEFAULT_MARKER in the same request. Following those would move a customer's OTHER
// sites onto a card chosen for one site. The billing page re-pins its own subscription.
//
// MODE — env CARD_PIN_FOLLOW_MODE, same convention as CANCEL_INVOICE_VOID_MODE:
//   unset / 'off'  → do nothing
//   'dry-run'      → decide and record what WOULD move; change nothing
//   'on'           → re-pin
//
// Re-pinning fires customer.subscription.updated, never customer.updated, so this cannot
// loop. Never throws. Every genuine card change evaluated is recorded to PaymentEvent.

import { savePaymentEvent } from './db.js';
import { CARD_DEFAULT_MARKER } from './stripeCardPin.js';
import { flowLog } from '../utils/flowLog.js';

/** One log line per evaluated outcome. Card ids only — never card details. */
function logOutcome(env, summary) {
  flowLog(env, 'cardPin', `${summary.kind}.${summary.error ? 'error' : summary.action || 'none'}`, {
    mode: summary.mode,
    stripeEventId: summary.stripeEventId,
    customerId: summary.customerId,
    oldCard: summary.oldCard,
    newCard: summary.newCard,
    reason: summary.reason,
    targets: summary.targets,
    moved: summary.moved,
    failed: summary.failed,
    error: summary.error || null,
  });
}

const STRIPE = 'https://api.stripe.com/v1';
const RENEWING_STATUSES = new Set(['active', 'trialing', 'past_due']);
/** Fallback window for recognising our own write when metadata is absent from previous_attributes. */
const OWN_WRITE_WINDOW_MS = 30_000;

function idOf(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id ?? null;
}

function hasOwn(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

export function resolveCardFollowMode(env, override = null) {
  const raw = String(override ?? env?.CARD_PIN_FOLLOW_MODE ?? '').trim().toLowerCase();
  if (raw === 'on' || raw === 'dry-run') return raw;
  return 'off';
}

/**
 * True when this customer.updated was caused by OUR code setting the default card.
 * Primary signal: the marker key changed in this same event. Fallback (only when the event
 * carries no metadata changes at all): marker stamped within 30s of the event.
 */
export function isOwnDefaultCardWrite(event) {
  const prev = event?.data?.previous_attributes;
  const prevMeta = prev?.metadata;
  if (hasOwn(prevMeta, CARD_DEFAULT_MARKER)) return true;
  if (prevMeta) return false; // metadata changed, but not our marker
  const stamped = Date.parse(event?.data?.object?.metadata?.[CARD_DEFAULT_MARKER] || '');
  const created = Number(event?.created || 0) * 1000;
  return Number.isFinite(stamped) && created > 0 && Math.abs(created - stamped) <= OWN_WRITE_WINDOW_MS;
}

/**
 * Decide which subscriptions to move. Pure — no I/O.
 * @param {{ newCard: string|null, oldCard: string|null, subscriptions: Array<{id, status, default_payment_method}> }}
 * @returns {{ action: 'move'|'none'|'ambiguous', fromCard: string|null, targets: string[], reason: string }}
 */
export function planCardFollow({ newCard, oldCard, subscriptions }) {
  if (!newCard) return { action: 'none', fromCard: null, targets: [], reason: 'default card removed' };

  const pinned = (subscriptions || [])
    .filter((s) => RENEWING_STATUSES.has(String(s?.status || '').toLowerCase()))
    .map((s) => ({ id: s.id, card: idOf(s.default_payment_method) }))
    .filter((s) => s.card && s.card !== newCard);

  if (oldCard) {
    const targets = pinned.filter((s) => s.card === oldCard).map((s) => s.id);
    return targets.length
      ? { action: 'move', fromCard: oldCard, targets, reason: 'replacing previous default card' }
      : { action: 'none', fromCard: oldCard, targets: [], reason: 'no renewing subscription on the replaced card' };
  }

  const distinct = [...new Set(pinned.map((s) => s.card))];
  if (distinct.length === 0) {
    return { action: 'none', fromCard: null, targets: [], reason: 'no renewing subscription pinned to another card' };
  }
  if (distinct.length === 1) {
    return {
      action: 'move',
      fromCard: distinct[0],
      targets: pinned.map((s) => s.id),
      reason: 'no previous default; customer uses a single card',
    };
  }
  return {
    action: 'ambiguous',
    fromCard: null,
    targets: [],
    reason: `no previous default; subscriptions use ${distinct.length} different cards — left unchanged`,
  };
}

async function stripeRequest(env, method, path, body = null) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body != null ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body != null ? { body } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && !json?.error, status: res.status, body: json };
}

async function listSubscriptions(env, customerId) {
  const r = await stripeRequest(env, 'GET', `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`);
  if (!r.ok) throw new Error(r.body?.error?.message || `subscription list failed (HTTP ${r.status})`);
  return r.body?.data || [];
}

async function repinAll(env, summary, card) {
  for (const subId of summary.targets) {
    const r = await stripeRequest(
      env,
      'POST',
      `/subscriptions/${encodeURIComponent(subId)}`,
      new URLSearchParams({ default_payment_method: card }).toString(),
    );
    if (r.ok) summary.moved.push(subId);
    else summary.failed.push({ subscription: subId, error: r.body?.error?.message || `HTTP ${r.status}` });
  }
}

async function record(db, summary) {
  if (!db) return;
  try {
    let organizationId = null;
    try {
      const row = await db
        .prepare('SELECT organizationId FROM Subscription WHERE stripeCustomerId = ?1 ORDER BY updatedAt DESC LIMIT 1')
        .bind(summary.customerId)
        .first();
      organizationId = row?.organizationId ?? row?.organizationid ?? null;
    } catch { /* attribution only */ }

    await savePaymentEvent(db, {
      eventType: `card_pin.${summary.kind}${summary.mode === 'dry-run' ? '.dry_run' : ''}`,
      stripeEventId: summary.stripeEventId || null,
      organizationId,
      failureReason: summary.error
        || (summary.failed.length ? `${summary.failed.length} subscription(s) could not be re-pinned` : null)
        || (summary.action === 'ambiguous' || summary.action === 'no-replacement' ? summary.reason : null),
      rawPayload: summary,
    });
  } catch (e) {
    console.warn('[CardPinFollow] could not record outcome:', e?.message);
  }
}

function baseSummary(kind, mode, event, customerId) {
  return {
    kind, mode, stripeEventId: event?.id ?? null, customerId,
    newCard: null, oldCard: null, action: null, reason: null,
    targets: [], moved: [], failed: [],
  };
}

/** customer.updated */
export async function followCustomerDefaultCard(env, db, event, opts = {}) {
  const mode = resolveCardFollowMode(env, opts.mode);
  if (mode === 'off') return { skipped: 'mode-off' };
  if (!env?.STRIPE_SECRET_KEY) return { skipped: 'no-stripe-key' };

  const prevInvoice = event?.data?.previous_attributes?.invoice_settings;
  // Not logged: every name/email/address edit lands here, and would drown the useful lines.
  if (!hasOwn(prevInvoice, 'default_payment_method')) return { skipped: 'not-a-card-change' };
  if (isOwnDefaultCardWrite(event)) {
    flowLog(env, 'cardPin', 'follow.own-write-ignored', {
      stripeEventId: event?.id ?? null,
      customerId: event?.data?.object?.id ?? null,
      newCard: idOf(event?.data?.object?.invoice_settings?.default_payment_method),
    });
    return { skipped: 'own-write' };
  }

  const customer = event.data.object || {};
  const summary = baseSummary('follow', mode, event, customer.id ?? null);
  summary.newCard = idOf(customer.invoice_settings?.default_payment_method);
  summary.oldCard = idOf(prevInvoice.default_payment_method);

  try {
    const subscriptions = await listSubscriptions(env, summary.customerId);
    const plan = planCardFollow({ newCard: summary.newCard, oldCard: summary.oldCard, subscriptions });
    Object.assign(summary, { action: plan.action, reason: plan.reason, targets: plan.targets, fromCard: plan.fromCard });
    if (plan.action === 'move' && mode === 'on') await repinAll(env, summary, summary.newCard);
  } catch (e) {
    summary.error = e?.message || String(e);
  }

  await record(db, summary);
  logOutcome(env, summary);
  return summary;
}

/** payment_method.detached */
export async function repinAfterCardDetached(env, db, event, opts = {}) {
  const mode = resolveCardFollowMode(env, opts.mode);
  if (mode === 'off') return { skipped: 'mode-off' };
  if (!env?.STRIPE_SECRET_KEY) return { skipped: 'no-stripe-key' };

  const detachedCard = event?.data?.object?.id ?? null;
  const customerId = idOf(event?.data?.previous_attributes?.customer);
  if (!detachedCard || !customerId) return { skipped: 'no-customer' };

  const summary = baseSummary('detached', mode, event, customerId);
  summary.oldCard = detachedCard;

  try {
    const subscriptions = await listSubscriptions(env, customerId);
    summary.targets = subscriptions
      .filter((s) => RENEWING_STATUSES.has(String(s?.status || '').toLowerCase()))
      .filter((s) => idOf(s.default_payment_method) === detachedCard)
      .map((s) => s.id);

    if (!summary.targets.length) {
      flowLog(env, 'cardPin', 'detached.no-subscription-on-card', {
        stripeEventId: summary.stripeEventId, customerId, detachedCard,
      });
      return { skipped: 'no-subscription-on-card' };
    }

    const cust = await stripeRequest(env, 'GET', `/customers/${encodeURIComponent(customerId)}`);
    const def = idOf(cust.body?.invoice_settings?.default_payment_method);
    if (def && def !== detachedCard) {
      summary.newCard = def;
      summary.action = 'move';
      summary.reason = 'pinned card removed; moving to customer default';
      if (mode === 'on') await repinAll(env, summary, def);
    } else {
      summary.action = 'no-replacement';
      summary.reason = 'pinned card removed and customer has no other default card — next renewal will fail';
    }
  } catch (e) {
    summary.error = e?.message || String(e);
  }

  await record(db, summary);
  logOutcome(env, summary);
  return summary;
}
