// ClickUp integration — creates a task when a new customer completes checkout.
//
// Required env vars:
//   CLICKUP_API_KEY          — ClickUp personal API token (Settings → Apps → API Token)
//   CLICKUP_LIST_WEBFLOW     — List ID for Webflow customers
//   CLICKUP_LIST_FRAMER      — List ID for Framer customers
//   CLICKUP_LIST_WEBSITE     — List ID for Website / other customers
//
// Optional — custom field IDs (UUIDs from the list's field config).
// If not set, those fields are skipped and data goes into the task description only.
// Fetch them by calling: GET https://api.clickup.com/api/v2/list/{listId}/field
// with Authorization: <your pk_... token>
//   CLICKUP_FIELD_PAYMENT_EMAIL   — "Payment Email" field UUID
//   CLICKUP_FIELD_CUSTOMER_NAME   — "Customer Name" field UUID
//   CLICKUP_FIELD_DATE_CREATED    — "Date Created" field UUID
//   CLICKUP_FIELD_STAGING_EMAIL   — "Staging Email" field UUID (optional)

function resolveListId(env, platform) {
  const p = (platform || '').toLowerCase().trim();
  if (p === 'webflow') return env.CLICKUP_LIST_WEBFLOW || null;
  if (p === 'framer')  return env.CLICKUP_LIST_FRAMER  || null;
  return env.CLICKUP_LIST_WEBSITE || null;
}

function formatAmount(amountCents, currency) {
  if (amountCents == null) return '';
  const sym = (currency || 'usd').toUpperCase() === 'USD' ? '$' : (currency || 'USD').toUpperCase() + ' ';
  return `${sym}${(amountCents / 100).toFixed(2)}`;
}

function buildCustomFields(env, { email, name }) {
  const fields = [];

  if (env.CLICKUP_FIELD_PAYMENT_EMAIL && email) {
    fields.push({ id: env.CLICKUP_FIELD_PAYMENT_EMAIL, value: email });
  }
  if (env.CLICKUP_FIELD_CUSTOMER_NAME && name) {
    fields.push({ id: env.CLICKUP_FIELD_CUSTOMER_NAME, value: name });
  }
  if (env.CLICKUP_FIELD_DATE_CREATED) {
    // ClickUp date fields expect Unix timestamp in milliseconds
    fields.push({ id: env.CLICKUP_FIELD_DATE_CREATED, value: Date.now() });
  }
  if (env.CLICKUP_FIELD_STAGING_EMAIL && email) {
    fields.push({ id: env.CLICKUP_FIELD_STAGING_EMAIL, value: email });
  }

  return fields;
}

export async function addCustomerToClickUp(env, {
  email,
  name,
  platform,
  plan,
  interval,
  domain,
  amountCents,
  currency,
  subscriptionId,
  customerId,
  isFirstPurchase,
}) {
  const apiKey = env.CLICKUP_API_KEY;
  if (!apiKey) {
    console.warn('[ClickUp] CLICKUP_API_KEY not set — skipping');
    return false;
  }

  const listId = resolveListId(env, platform);
  if (!listId) {
    console.warn('[ClickUp] No list ID configured for platform:', platform, '— skipping');
    return false;
  }

  const platformLabel = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Website';
  const taskName = email || 'Unknown';

  const descLines = [
    `**Email:** ${email || '—'}`,
    `**Name:** ${name || '—'}`,
    `**Platform:** ${platformLabel}`,
    `**Plan:** ${plan || '—'}`,
    `**Billing:** ${interval || '—'}`,
    `**Amount:** ${formatAmount(amountCents, currency) || '—'}`,
    `**Domain:** ${domain || '—'}`,
    `**Stripe Customer:** ${customerId || '—'}`,
    `**Stripe Subscription:** ${subscriptionId || '—'}`,
    `**First Purchase:** ${isFirstPurchase ? 'Yes' : 'No'}`,
    `**Date:** ${new Date().toISOString().split('T')[0]}`,
  ];

  const customFields = buildCustomFields(env, { email, name });

  const body = {
    name: taskName,
    description: descLines.join('\n'),
    ...(customFields.length > 0 ? { custom_fields: customFields } : {}),
  };

  try {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('[ClickUp] task creation failed — status:', res.status, '| error:', data?.err || JSON.stringify(data));
      return false;
    }
    console.log('[ClickUp] task created — id:', data.id, '| list:', listId, '| platform:', platformLabel);
    return true;
  } catch (e) {
    console.error('[ClickUp] task creation exception:', e?.message);
    return false;
  }
}

// ── Once-only dedup ──────────────────────────────────────────────────────────
// A subscriber can arrive via multiple Stripe events (checkout.session.completed,
// customer.subscription.updated) and via the direct custom-checkout flow. To add
// each subscriber to ClickUp exactly once, we stamp a flag in the CHECKOUT_TOKENS
// KV keyed by the Stripe subscription id after a successful add, and check it before
// adding again. Best-effort: if KV is unavailable we fall back to "not yet added".
const CLICKUP_DEDUP_PREFIX = 'clickup-added:';

export async function wasClickUpTaskCreated(env, subscriptionId) {
  if (!subscriptionId || !env?.CHECKOUT_TOKENS) return false;
  try {
    return (await env.CHECKOUT_TOKENS.get(CLICKUP_DEDUP_PREFIX + subscriptionId)) != null;
  } catch (e) {
    console.warn('[ClickUp] dedup read failed (treating as not-added):', e?.message);
    return false;
  }
}

export async function markClickUpTaskCreated(env, subscriptionId) {
  if (!subscriptionId || !env?.CHECKOUT_TOKENS) return;
  try {
    await env.CHECKOUT_TOKENS.put(CLICKUP_DEDUP_PREFIX + subscriptionId, new Date().toISOString());
  } catch (e) {
    console.warn('[ClickUp] dedup write failed:', e?.message);
  }
}

// Call this once (via a test route or curl) to print all custom field IDs for a list.
// curl -H "Authorization: pk_..." "https://api.clickup.com/api/v2/list/LIST_ID/field"
export async function fetchListFieldIds(apiKey, listId) {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/field`, {
    headers: { Authorization: apiKey },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`ClickUp field fetch failed: ${JSON.stringify(data)}`);
  return (data.fields || []).map(f => ({ id: f.id, name: f.name, type: f.type }));
}
