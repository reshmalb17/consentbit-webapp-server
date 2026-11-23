// src/handlers/dpaRequest.js
//
// Profile → DPA Request. A logged-in customer asks for a signed Data Processing
// Agreement (GDPR Art. 28). We store the request in D1 and email the support inbox
// plus a confirmation to the signatory. Nothing is signed automatically — support
// prepares the agreement and sends it out by email.
//
//   GET  /api/dpa-request  → the caller's own requests (newest first)
//   POST /api/dpa-request  → submit a new request
import { getSessionById, getUserById, getSubscriptionsBySiteIds } from '../services/db.js';
import { sendBrevoEmail } from '../services/email.js';

// Accounts (login email, lowercase) allowed to request a signed DPA for Essential-plan
// sites as well as Growth. Keep in sync with DpaRequestPage.tsx in both webapps.
const DPA_ESSENTIAL_ALLOWED = ['rafee.niloy@strativ.se'];

const EMAIL_REGEX =/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMPANY_SIZES = ['0-10', '11-50', '51-100', '101-500', '500+'];
const REGIONS = ['EU / EEA', 'United Kingdom', 'Switzerland', 'United States', 'Brazil', 'Canada', 'APAC', 'Elsewhere'];
const AGREEMENT_TYPES = ['standard', 'customer_template'];
const MAX_REQUESTS_PER_DAY = 5;

let tableReady = false;

async function ensureDpaTable(db) {
  if (tableReady) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS DpaRequest (
       id TEXT PRIMARY KEY,
       userId TEXT NOT NULL,
       accountEmail TEXT,
       companyName TEXT NOT NULL,
       addressLine TEXT NOT NULL,
       city TEXT NOT NULL,
       postalCode TEXT,
       country TEXT NOT NULL,
       registrationNumber TEXT,
       vatNumber TEXT,
       companySize TEXT,
       website TEXT NOT NULL,
       siteIds TEXT,
       signatoryName TEXT NOT NULL,
       signatoryTitle TEXT NOT NULL,
       signatoryEmail TEXT NOT NULL,
       privacyContactName TEXT,
       privacyContactEmail TEXT,
       representative TEXT,
       agreementType TEXT,
       regions TEXT,
       neededBy TEXT,
       notes TEXT,
       privacyAckAt TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'received',
       createdAt TEXT NOT NULL
     )`
  ).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_dparequest_user ON DpaRequest(userId, createdAt)`).run();
  tableReady = true;
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

function strList(v, allowed, max = 20) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = String(item ?? '').trim();
    if (!s || out.includes(s)) continue;
    if (allowed && !allowed.includes(s)) continue;
    out.push(s.slice(0, 100));
    if (out.length >= max) break;
  }
  return out;
}

// Returns { data } or { error }.
function validate(body) {
  const d = {
    companyName: str(body.companyName, 200),
    addressLine: str(body.addressLine, 300),
    city: str(body.city, 120),
    postalCode: str(body.postalCode, 40),
    country: str(body.country, 120),
    registrationNumber: str(body.registrationNumber, 100),
    vatNumber: str(body.vatNumber, 100),
    companySize: str(body.companySize, 20),
    website: str(body.website, 300),
    siteIds: strList(body.siteIds, null, 200),
    signatoryName: str(body.signatoryName, 160),
    signatoryTitle: str(body.signatoryTitle, 160),
    signatoryEmail: str(body.signatoryEmail, 254).toLowerCase(),
    privacyContactName: str(body.privacyContactName, 160),
    privacyContactEmail: str(body.privacyContactEmail, 254).toLowerCase(),
    representative: str(body.representative, 300),
    agreementType: str(body.agreementType, 30) || 'standard',
    regions: strList(body.regions, REGIONS),
    neededBy: str(body.neededBy, 10),
    notes: str(body.notes, 3000),
  };
  const required = [
    ['companyName', 'Company legal name'],
    ['addressLine', 'Registered address'],
    ['city', 'City'],
    ['country', 'Country'],
    ['website', 'Website'],
    ['signatoryName', 'Signatory name'],
    ['signatoryTitle', 'Signatory job title'],
    ['signatoryEmail', 'Signatory email'],
  ];
  for (const [key, label] of required) {
    if (!d[key]) return { error: `${label} is required` };
  }
  if (!EMAIL_REGEX.test(d.signatoryEmail)) return { error: 'Signatory email is not valid' };
  if (d.privacyContactEmail && !EMAIL_REGEX.test(d.privacyContactEmail)) return { error: 'Privacy contact email is not valid' };
  if (d.companySize && !COMPANY_SIZES.includes(d.companySize)) return { error: 'Company size is not valid' };
  if (!AGREEMENT_TYPES.includes(d.agreementType)) return { error: 'Agreement type is not valid' };
  if (!d.regions.length) return { error: 'Select at least one region where you collect consent' };
  if (d.neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(d.neededBy)) return { error: 'Needed-by date is not valid' };
  if (body.privacyAck !== true) return { error: 'Please confirm you are authorised to sign and acknowledge the Privacy Policy' };
  return { data: d };
}

function supportEmail(env, row) {
  const lines = [
    ['Request ID', row.id],
    ['Account', row.accountEmail],
    ['Company', row.companyName],
    ['Address', [row.addressLine, row.city, row.postalCode, row.country].filter(Boolean).join(', ')],
    ['Registration no.', row.registrationNumber || '-'],
    ['VAT / Tax ID', row.vatNumber || '-'],
    ['Company size', row.companySize || '-'],
    ['Website', row.website],
    ['Sites covered', row.siteLabels.join(', ') || '-'],
    ['Signatory', `${row.signatoryName} (${row.signatoryTitle}) <${row.signatoryEmail}>`],
    ['Privacy contact / DPO', row.privacyContactName || row.privacyContactEmail ? `${row.privacyContactName || '-'} <${row.privacyContactEmail || '-'}>` : '-'],
    ['EU / UK representative', row.representative || '-'],
    ['Agreement', row.agreementType === 'customer_template' ? 'Customer wants us to sign THEIR DPA (expect it by email)' : 'ConsentBit standard DPA'],
    ['Consent collected in', row.regions.join(', ')],
    ['Needed by', row.neededBy || '-'],
    ['Notes', row.notes || '-'],
  ];
  const html = `<h2>New DPA request</h2><table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">${lines
    .map(([k, v]) => `<tr><td style="color:#6b7280;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v).replace(/\n/g, '<br>')}</td></tr>`)
    .join('')}</table>`;
  const text = `New DPA request\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  return sendBrevoEmail(env, {
    to: env.DPA_REQUEST_NOTIFY_EMAIL || env.BREVO_REPLY_TO || 'web@consentbit.com',
    subject: `DPA request — ${row.companyName}`,
    html,
    text,
  });
}

function confirmationEmail(env, row) {
  const name = escapeHtml(row.signatoryName);
  const company = escapeHtml(row.companyName);
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827;line-height:1.6">
<p>Hi ${name},</p>
<p>We've received the request for a Data Processing Agreement between <strong>${company}</strong> and ConsentBit (Seattle New Media, LLC). Our team will review the details and email the agreement to this address for signature.</p>
<p>Reference: ${escapeHtml(row.id)}</p>
<p>If any of the details are wrong, just reply to this email.</p>
<p>— The ConsentBit team</p>
</div>`;
  const text = `Hi ${row.signatoryName},\n\nWe've received the request for a Data Processing Agreement between ${row.companyName} and ConsentBit (Seattle New Media, LLC). Our team will review the details and email the agreement to this address for signature.\n\nReference: ${row.id}\n\nIf any of the details are wrong, just reply to this email.\n\n— The ConsentBit team`;
  return sendBrevoEmail(env, {
    to: row.signatoryEmail,
    name: row.signatoryName,
    subject: 'We received your DPA request',
    html,
    text,
  });
}

export async function handleDpaRequest(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;

  const sid = getSessionIdFromCookie(request);
  const session = sid ? await getSessionById(db, sid).catch(() => null) : null;
  const userId = session?.userId ?? session?.user_id ?? null;
  if (!userId) {
    return Response.json({ success: false, error: 'Login required' }, { status: 401 });
  }

  try {
    await ensureDpaTable(db);
  } catch (error) {
    console.error('[DpaRequest] table setup failed:', error);
    return Response.json({ success: false, error: 'Service unavailable, please try again' }, { status: 503 });
  }

  if (request.method === 'GET') {
    // ?document=<requestId> → the latest signed PDF ConsentBit published for that
    // request (Admin → DPA requests → Publish). Only the requester's own.
    const documentFor = new URL(request.url).searchParams.get('document');
    if (documentFor) {
      const doc = await db
        .prepare(
          `SELECT d.fileName, d.pdfBase64 FROM DpaDocument d
             JOIN DpaRequest r ON r.id = d.requestId
            WHERE d.requestId = ?1 AND r.userId = ?2 AND r.status IN ('sent', 'signed')
            ORDER BY d.createdAt DESC LIMIT 1`
        )
        .bind(documentFor, userId)
        .first()
        .catch(() => null);
      if (!doc) return Response.json({ success: false, error: 'No signed copy yet' }, { status: 404 });
      const bin = atob(doc.pdfBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${String(doc.fileName || 'ConsentBit-DPA.pdf').replace(/[^\w.-]/g, '_')}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    // publishedAt / DpaDocument come from the admin server; fall back while they
    // don't exist yet (nothing published on this database).
    const { results } = await db
      .prepare(
        `SELECT r.id, r.companyName, r.signatoryName, r.signatoryEmail, r.status, r.createdAt, r.publishedAt,
                EXISTS (SELECT 1 FROM DpaDocument d WHERE d.requestId = r.id) AS hasDocument
           FROM DpaRequest r WHERE r.userId = ?1 ORDER BY r.createdAt DESC LIMIT 50`
      )
      .bind(userId)
      .all()
      .catch(() =>
        db
          .prepare(
            `SELECT id, companyName, signatoryName, signatoryEmail, status, createdAt
             FROM DpaRequest WHERE userId = ?1 ORDER BY createdAt DESC LIMIT 50`
          )
          .bind(userId)
          .all()
      );
    const requests = (results || []).map((r) => ({
      ...r,
      hasDocument: !!r.hasDocument && (r.status === 'sent' || r.status === 'signed'),
    }));
    return Response.json({ success: true, requests });
  }

  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { data, error } = validate(body || {});
  if (error) return Response.json({ success: false, error }, { status: 400 });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = await db
    .prepare(`SELECT COUNT(*) AS n FROM DpaRequest WHERE userId = ?1 AND createdAt > ?2`)
    .bind(userId, since)
    .first();
  if (Number(recent?.n || 0) >= MAX_REQUESTS_PER_DAY) {
    return Response.json(
      { success: false, error: 'Too many DPA requests today. Please email web@consentbit.com instead.' },
      { status: 429 }
    );
  }

  // A signed DPA is offered for Growth-plan sites only. The site picked in the form
  // must be one of the caller's own sites with a live Growth plan — the same
  // entitlement rule dashboard-init uses (active/trialing, or canceled within the
  // paid period). Accounts in DPA_ESSENTIAL_ALLOWED may also use Essential-plan sites.
  const user = await getUserById(db, userId).catch(() => null);
  const dpaPlans = DPA_ESSENTIAL_ALLOWED.includes(String(user?.email || '').trim().toLowerCase())
    ? ['growth', 'essential']
    : ['growth'];
  const { results: ownSites } = await db
    .prepare(
      `SELECT s.id, s.domain, s.name FROM Site s
       JOIN OrganizationMember om ON om.organizationId = s.organizationId
       WHERE om.userId = ?1`
    )
    .bind(userId)
    .all()
    .catch(() => ({ results: [] }));
  const subs = await getSubscriptionsBySiteIds(db, (ownSites || []).map((s) => s.id)).catch(() => ({}));
  const growthSites = (ownSites || []).filter((s) => {
    const sub = subs[String(s.id)];
    return dpaPlans.includes(String(sub?.planId ?? sub?.planType ?? '').toLowerCase());
  });
  const picked = growthSites.find((s) => data.siteIds.includes(String(s.id)));
  if (!picked) {
    return Response.json(
      { success: false, error: 'A signed DPA is available for websites on the Growth plan. Select one of your Growth-plan websites.' },
      { status: 400 }
    );
  }
  const siteIds = [String(picked.id)];
  const siteLabels = [picked.domain || picked.name || String(picked.id)];
  data.website = picked.domain || data.website;

  const now = new Date().toISOString();
  const row = {
    ...data,
    id: crypto.randomUUID(),
    userId,
    accountEmail: user?.email || '',
    siteIds,
    siteLabels,
    privacyAckAt: now,
    createdAt: now,
  };

  try {
    await db
      .prepare(
        `INSERT INTO DpaRequest (id, userId, accountEmail, companyName, addressLine, city, postalCode, country,
           registrationNumber, vatNumber, companySize, website, siteIds, signatoryName, signatoryTitle, signatoryEmail,
           privacyContactName, privacyContactEmail, representative, agreementType, regions, neededBy, notes, privacyAckAt, status, createdAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, 'received', ?25)`
      )
      .bind(
        row.id, row.userId, row.accountEmail, row.companyName, row.addressLine, row.city, row.postalCode || null, row.country,
        row.registrationNumber || null, row.vatNumber || null, row.companySize || null, row.website, JSON.stringify(row.siteIds),
        row.signatoryName, row.signatoryTitle, row.signatoryEmail, row.privacyContactName || null, row.privacyContactEmail || null,
        row.representative || null, row.agreementType,
        JSON.stringify(row.regions), row.neededBy || null, row.notes || null, row.privacyAckAt, row.createdAt
      )
      .run();
  } catch (error) {
    console.error('[DpaRequest] insert failed:', error);
    return Response.json({ success: false, error: 'Failed to save your request' }, { status: 500 });
  }

  // Emails never block or fail the request — it's already saved.
  const emails = Promise.allSettled([supportEmail(env, row), confirmationEmail(env, row)]).then((rs) => {
    for (const r of rs) if (r.status === 'rejected') console.error('[DpaRequest] email failed:', r.reason);
  });
  if (ctx?.waitUntil) ctx.waitUntil(emails);
  else await emails;

  return Response.json(
    { success: true, request: { id: row.id, companyName: row.companyName, signatoryName: row.signatoryName, signatoryEmail: row.signatoryEmail, status: 'received', createdAt: row.createdAt } },
    { status: 201 }
  );
}
