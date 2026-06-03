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
    return;
  }

  const listId = resolveListId(env, platform);
  if (!listId) {
    console.warn('[ClickUp] No list ID configured for platform:', platform, '— skipping');
    return;
  }

  const platformLabel = platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Website';
  const taskName = `${email || 'Unknown'} — ${plan || 'Paid'} (${platformLabel})`;

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
    } else {
      console.log('[ClickUp] task created — id:', data.id, '| list:', listId, '| platform:', platformLabel);
    }
  } catch (e) {
    console.error('[ClickUp] task creation exception:', e?.message);
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
