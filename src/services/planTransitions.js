// src/services/planTransitions.js
//
// Durable log of every plan change, so conversions can be reported on over time.
//
// WHY THIS TABLE EXISTS
// --------------------
// Nothing else in the schema records a plan CHANGE. Subscription rows are
// upserted in place by saveSubscription(), so an upgrade from basic → growth
// overwrites planId and the previous value is gone. PaymentEvent stores only
// `{ status, cancel_at_period_end }` for customer.subscription.updated, which
// says nothing about which plan was involved. The upgrade/downgrade comparison
// already existed in stripeWebhook.js but was only ever sent to PostHog, which
// is external and cannot be joined to anything here.
//
// Consequence: transitions are recorded from the moment this ships, and there is
// deliberately NO backfill. Deriving history from existing Subscription rows was
// considered and rejected: it would have produced one free→paid per subscription
// ROW (497) rather than per customer (188 orgs), attributed to each one's CURRENT
// tier rather than the tier first bought, with every trial appearing as a direct
// purchase and no churn at all despite 243 being cancelled. Every headline would
// have read better than the truth. What was not observed is not reported.
//
// KINDS
//   signup_paid      free → paid, no trial in between
//   trial_started    free → trialing
//   trial_converted  trialing → paid  (the conversion that matters most)
//   trial_abandoned  trialing → cancelled without ever paying
//   upgrade          paid → more expensive tier
//   downgrade        paid → cheaper tier
//   interval_change  same tier, monthly ↔ yearly
//   cancelled        paid → none
//   reactivated      cancelled → paid again
//
// Writes are best-effort: reporting must never break the billing path.

let ensured = false;

/** Tier order, used to tell an upgrade from a downgrade. */
const TIER_RANK = { free: 0, basic: 1, essential: 2, growth: 3 };

export async function ensurePlanTransitionTable(db) {
  if (ensured || !db) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS PlanTransition (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        fromPlan TEXT,
        toPlan TEXT,
        fromInterval TEXT,
        toInterval TEXT,
        organizationId TEXT,
        siteId TEXT,
        domain TEXT,
        userEmail TEXT,
        subscriptionId TEXT,
        stripeSubscriptionId TEXT,
        amountCents INTEGER,
        currency TEXT,
        mrrDeltaCents INTEGER,
        source TEXT,
        detail TEXT,
        dedupeKey TEXT UNIQUE,
        occurredAt DATETIME NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_plantr_occurredAt ON PlanTransition (occurredAt DESC)`)
    .run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_plantr_kind ON PlanTransition (kind)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_plantr_org ON PlanTransition (organizationId)`).run();
  ensured = true;
}

/**
 * Kinds that can only happen once in a subscription's life. They are keyed on the
 * SUBSCRIPTION rather than the Stripe event, because two different events can
 * legitimately describe the same milestone — `customer.subscription.created`
 * (status active) and a following `customer.subscription.updated` that arrives
 * before our row was written both look like a first purchase. Different event
 * ids, same fact; a subscription-scoped key collapses them to one row.
 *
 * Upgrades, downgrades and interval changes are NOT in this set: they can happen
 * repeatedly, so they stay keyed on the event.
 */
const ONCE_PER_SUBSCRIPTION = new Set([
  'signup_paid', 'trial_started', 'trial_converted', 'trial_abandoned', 'cancelled',
]);

export function transitionDedupeKey(kind, stripeSubscriptionId, stripeEventId) {
  const sub = stripeSubscriptionId || 'nosub';
  return ONCE_PER_SUBSCRIPTION.has(kind)
    ? `plt:${kind}:${sub}`
    : `plt:${kind}:${stripeEventId || sub}`;
}

/** Amount normalised to a month, so yearly and monthly plans are comparable. */
export function monthlyCents(amountCents, interval) {
  if (amountCents == null) return null;
  return /^(year|annual)/i.test(String(interval || '')) ? Math.round(amountCents / 12) : amountCents;
}

/**
 * Classify a plan change. Returns null when nothing meaningful changed, so
 * callers can fire on every subscription webhook without filtering first.
 */
export function classifyTransition({ fromPlan, toPlan, fromInterval, toInterval, fromStatus, toStatus }) {
  const a = String(fromPlan || 'free').toLowerCase();
  const b = String(toPlan || 'free').toLowerCase();
  const wasTrial = String(fromStatus || '').toLowerCase() === 'trialing';
  const isTrial = String(toStatus || '').toLowerCase() === 'trialing';
  const ended = ['canceled', 'cancelled', 'unpaid'].includes(String(toStatus || '').toLowerCase());
  const hadPlan = a !== 'free' && a !== '';
  const hasPlan = b !== 'free' && b !== '';

  if (ended) return wasTrial ? 'trial_abandoned' : hadPlan ? 'cancelled' : null;
  if (isTrial && !wasTrial) return 'trial_started';
  if (wasTrial && !isTrial && hasPlan) return 'trial_converted';
  if (!hadPlan && hasPlan) return 'signup_paid';

  if (hadPlan && hasPlan) {
    if (a !== b) {
      return (TIER_RANK[b] ?? 0) > (TIER_RANK[a] ?? 0) ? 'upgrade' : 'downgrade';
    }
    const ia = String(fromInterval || '').toLowerCase();
    const ib = String(toInterval || '').toLowerCase();
    if (ia && ib && ia !== ib) return 'interval_change';
  }
  return null;
}

/**
 * Record one transition. Returns the row id, or null when it was a duplicate
 * (same dedupeKey) or the write failed.
 */
/** Kinds after which the customer is on no paid plan at all. */
const TERMINAL_KINDS = new Set(['cancelled', 'trial_abandoned']);

export async function recordPlanTransition(db, t) {
  if (!db || !t?.kind) return null;
  try {
    await ensurePlanTransitionTable(db);
    const id = `plt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // A cancellation ends the plan, but Stripe still reports the plan and its
    // amount on the cancelling event. Taken literally that gives toPlan ==
    // fromPlan — a row reading "growth → growth" — and, worse, a monthly delta of
    // zero, so churn would never appear in the net-change figure. Terminal kinds
    // therefore land on free at zero, which is what actually happened.
    const terminal = TERMINAL_KINDS.has(t.kind);
    const toPlan = terminal ? 'free' : (t.toPlan || 'free');
    const toAmountCents = terminal ? 0 : t.toAmountCents;
    const toInterval = terminal ? null : t.toInterval;

    const toMonthly = monthlyCents(toAmountCents, toInterval);
    const fromMonthly = monthlyCents(t.fromAmountCents, t.fromInterval);
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO PlanTransition
           (id, kind, fromPlan, toPlan, fromInterval, toInterval, organizationId, siteId, domain,
            userEmail, subscriptionId, stripeSubscriptionId, amountCents, currency, mrrDeltaCents,
            source, detail, dedupeKey, occurredAt, createdAt)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`
      )
      .bind(
        id,
        t.kind,
        (t.fromPlan || 'free').toLowerCase(),
        String(toPlan).toLowerCase(),
        t.fromInterval || null,
        toInterval || null,
        t.organizationId || null,
        t.siteId || null,
        t.domain || null,
        t.userEmail || null,
        t.subscriptionId || null,
        t.stripeSubscriptionId || null,
        toAmountCents ?? null,
        t.currency ? String(t.currency).toUpperCase() : null,
        toMonthly == null && fromMonthly == null ? null : (toMonthly ?? 0) - (fromMonthly ?? 0),
        t.source || 'webhook',
        t.detail ? JSON.stringify(t.detail).slice(0, 4000) : null,
        t.dedupeKey || null,
        t.occurredAt || new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
    const changed = res?.meta?.changes ?? res?.changes ?? 1;
    return changed ? id : null;
  } catch (err) {
    console.error('[planTransitions] write failed', err?.message || err);
    return null;
  }
}

/** Transitions in a window, newest first. */
export async function listPlanTransitions(db, { kind, plan, source, search, from, to, limit } = {}) {
  await ensurePlanTransitionTable(db);

  const where = [];
  const binds = [];
  if (kind && kind !== 'all') {
    where.push('kind = ?');
    binds.push(kind);
  }
  if (plan && plan !== 'all') {
    // Either side of the move, so "growth" finds upgrades TO it and away from it.
    where.push('(LOWER(fromPlan) = ? OR LOWER(toPlan) = ?)');
    binds.push(String(plan).toLowerCase(), String(plan).toLowerCase());
  }
  if (source && source !== 'all') {
    where.push('COALESCE(source, ?) = ?');
    binds.push('webhook', source);
  }
  if (search) {
    where.push('(domain LIKE ? OR userEmail LIKE ? OR stripeSubscriptionId LIKE ? OR organizationId = ?)');
    const like = `%${search}%`;
    binds.push(like, like, like, search);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
    where.push('substr(occurredAt, 1, 10) >= ?');
    binds.push(String(from));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    where.push('substr(occurredAt, 1, 10) <= ?');
    binds.push(String(to));
  }

  const cap = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const sql =
    `SELECT * FROM PlanTransition` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY occurredAt DESC, rowid DESC LIMIT ${cap}`;

  const { results = [] } = await db.prepare(sql).bind(...binds).all();
  return results.map((r) => ({
    ...r,
    source: r.source || 'webhook',
    detail: r.detail ? safeParse(r.detail) : null,
  }));
}

/**
 * Headline counters for the same window. Computed from the returned rows rather
 * than a second query, so the totals can never disagree with the table under them.
 */
export function summarise(rows) {
  const byKind = {};
  let mrrUp = 0;
  let mrrDown = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    const d = Number(r.mrrDeltaCents) || 0;
    if (d > 0) mrrUp += d;
    else mrrDown += d;
  }
  const trialStarted = byKind.trial_started || 0;
  const trialConverted = byKind.trial_converted || 0;
  return {
    total: rows.length,
    byKind,
    newPaid: (byKind.signup_paid || 0) + trialConverted,
    upgrades: byKind.upgrade || 0,
    downgrades: byKind.downgrade || 0,
    cancelled: (byKind.cancelled || 0) + (byKind.trial_abandoned || 0),
    mrrUpCents: mrrUp,
    mrrDownCents: mrrDown,
    mrrNetCents: mrrUp + mrrDown,
    // Only meaningful when both ends of the funnel fall inside the window; the
    // page says so rather than presenting it as a headline rate.
    trialConversionRate: trialStarted ? Math.round((trialConverted / trialStarted) * 100) : null,
    trialStarted,
    trialConverted,
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return s;
  }
}
