// src/handlers/adminMicheleClickup.js
// One-off: delete + recreate ClickUp tasks for a single bulk-purchase customer
// (michele@mtcweb.co) in a specific list, sourced from the consentbit-licenses DB.
//
// POST /api/admin/michele-clickup
// Headers: X-Admin-Key: <ADMIN_SECRET>
// Query params:
//   ?email=michele@mtcweb.co   — customer email (default: michele@mtcweb.co)
//   ?list=901613232768         — target ClickUp list ID (default: 901613232768)
//   ?dryRun=true               — report what would happen without writing to ClickUp
//
// Behaviour: reads every license for the email from LEGACY_DB (consentbit-licenses),
// deletes the customer's existing tasks in the list, then creates one task per license
// (named by domain, license key + bulk-purchase note in the description).

import { checkAdminAuth } from '../utils/adminAuth.js';

const CLICKUP_BASE = 'https://api.clickup.com/api/v2';

function normalizeName(s) {
  return (s || '').toLowerCase().trim();
}

// Pull all of the customer's licenses from the legacy DB.
async function fetchLicenses(env, email) {
  const { results } = await env.LEGACY_DB
    .prepare(
      `SELECT license_key, used_site_domain, platform, status, billing_period
         FROM licenses
        WHERE user_email = ?1
        ORDER BY (used_site_domain IS NULL), used_site_domain`
    )
    .bind(email)
    .all();
  return results || [];
}

// Fetch every task in a list (paginated).
async function fetchListTasks(apiKey, listId) {
  const all = [];
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`${CLICKUP_BASE}/list/${listId}/task?page=${page}&include_closed=true`, {
      headers: { Authorization: apiKey },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`list tasks fetch failed (${res.status}): ${data?.err || JSON.stringify(data)}`);
    const tasks = data.tasks || [];
    all.push(...tasks);
    if (data.last_page || tasks.length === 0) break;
  }
  return all;
}

async function deleteTask(apiKey, taskId) {
  const res = await fetch(`${CLICKUP_BASE}/task/${taskId}`, {
    method: 'DELETE',
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`delete ${taskId} failed (${res.status}): ${data?.err || JSON.stringify(data)}`);
  }
}

async function createTask(apiKey, listId, { name, description }) {
  const res = await fetch(`${CLICKUP_BASE}/list/${listId}/task`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`create "${name}" failed (${res.status}): ${data?.err || JSON.stringify(data)}`);
  return data.id;
}

export async function handleAdminMicheleClickup(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const apiKey = env.CLICKUP_API_KEY;
  if (!apiKey) {
    return Response.json({ success: false, error: 'CLICKUP_API_KEY not configured' }, { status: 503 });
  }
  if (!env.LEGACY_DB) {
    return Response.json({ success: false, error: 'LEGACY_DB binding not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || 'michele@mtcweb.co').trim();
  const listId = (url.searchParams.get('list') || '901613232768').trim();
  const dryRun = url.searchParams.get('dryRun') === 'true';

  // 1. Source of truth: the customer's licenses.
  let licenses;
  try {
    licenses = await fetchLicenses(env, email);
  } catch (err) {
    return Response.json({ success: false, error: `DB query failed: ${err.message}` }, { status: 502 });
  }
  if (licenses.length === 0) {
    return Response.json({ success: false, error: `No licenses found for ${email}` }, { status: 404 });
  }

  // 2. Identify the customer's existing tasks in the list (by domain or email match).
  const domainSet = new Set(licenses.map(l => normalizeName(l.used_site_domain)).filter(Boolean));
  const emailNorm = normalizeName(email);

  let existing;
  try {
    existing = await fetchListTasks(apiKey, listId);
  } catch (err) {
    return Response.json({ success: false, error: `ClickUp list fetch failed: ${err.message}` }, { status: 502 });
  }

  const toDelete = existing.filter(t => {
    const n = normalizeName(t.name);
    return n === emailNorm || n.startsWith(emailNorm) || domainSet.has(n);
  });

  // 3. Build the new task payloads (one per license).
  const newTasks = licenses.map(l => {
    const domain = l.used_site_domain || null;
    const name = domain || `${email} — pending (${l.license_key})`;
    const description = [
      `**Email:** ${email}`,
      `**Domain:** ${domain || '— (unassigned / pending)'}`,
      `**License Key:** ${l.license_key}`,
      `**Platform:** ${l.platform || 'webflow'}`,
      `**Billing:** ${l.billing_period || '—'}`,
      `**Status:** ${l.status || '—'}`,
      `**Source:** Bulk purchase (backfilled from consentbit-licenses)`,
    ].join('\n');
    return { name, description, license_key: l.license_key, domain };
  });

  if (dryRun) {
    return Response.json({
      success: true,
      dryRun: true,
      email,
      listId,
      existingMatched: toDelete.map(t => ({ id: t.id, name: t.name })),
      wouldDelete: toDelete.length,
      wouldCreate: newTasks.map(t => ({ name: t.name, license_key: t.license_key })),
      message: `Dry run: would delete ${toDelete.length} existing task(s) and create ${newTasks.length}.`,
    });
  }

  // 4a. Delete existing.
  const deleted = [];
  const deleteErrors = [];
  for (const t of toDelete) {
    try {
      await deleteTask(apiKey, t.id);
      deleted.push({ id: t.id, name: t.name });
    } catch (err) {
      deleteErrors.push({ id: t.id, name: t.name, error: err.message });
    }
  }

  // 4b. Create fresh.
  const created = [];
  const createErrors = [];
  for (const t of newTasks) {
    try {
      const id = await createTask(apiKey, listId, t);
      created.push({ id, name: t.name, license_key: t.license_key });
    } catch (err) {
      createErrors.push({ name: t.name, license_key: t.license_key, error: err.message });
    }
  }

  return Response.json({
    success: createErrors.length === 0 && deleteErrors.length === 0,
    email,
    listId,
    licensesFound: licenses.length,
    deleted: deleted.length,
    created: created.length,
    deletedTasks: deleted,
    createdTasks: created,
    deleteErrors: deleteErrors.length ? deleteErrors : null,
    createErrors: createErrors.length ? createErrors : null,
    message: `Deleted ${deleted.length}, created ${created.length} for ${email}.`,
  });
}
