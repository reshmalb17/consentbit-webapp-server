// src/services/team.js
//
// Team members: the account owner (or an Admin) invites someone by email, picks a
// role and the sites they may see; the invitee accepts with their own login and
// from then on sees only those sites.
//
// ─── WHY A SEPARATE TABLE, NOT OrganizationMember ───────────────────────────
// OrganizationMember already means "owns this account": ~25 places resolve the
// owner with `JOIN OrganizationMember ... LIMIT 1` and no role filter (Stripe
// webhook billingEmail writes, PostHog identity, scan/consent owner emails).
// Putting invitees there would let those lookups pick a member instead of the
// owner. So members live in TeamMember + TeamMemberSite, and nothing that reads
// OrganizationMember changes. Being in OrganizationMember is still "owner".
//
// ─── ROLES ──────────────────────────────────────────────────────────────────
//   owner  — OrganizationMember of the site's org. Everything.
//   admin  — acts for the owner on assigned sites: banner, scan, consent logs,
//            policies, site name/URL, members, upgrades/plan changes (not down to
//            Basic/Free), billing for those sites, adding sites to the owner's account.
//            Receives the owner's notification emails. Not: Stripe portal, card
//            update, downgrade to Basic/Free, cancel, transfer of ownership.
//   member — assigned sites: banner, scan, consent logs, policies. (Was "editor";
//            old rows are rewritten to 'member' when the tables are initialised.)
// Access only exists while the site is on Essential/Growth (siteHasTeamPlanSql).
//
// ─── TABLES ─────────────────────────────────────────────────────────────────
// Created lazily here (same pattern as bannerTemplates.js / consentRetention.js)
// because ensureSchema's DDL never runs on a DB already stamped at SCHEMA_VERSION.

/**
 * Seats per site, by the site's plan and role. Counts pending + active. The account
 * owner is never counted. Free and Basic have no team feature at all.
 */
export const TEAM_SEAT_CAPS = {
  free: { admin: 0, member: 0 },
  basic: { admin: 0, member: 0 },
  essential: { admin: 1, member: 4 },
  growth: { admin: 1, member: Infinity },
};

export const TEAM_ROLES = ['admin', 'member'];

/** Invite links stay valid this long. Resend issues a fresh one. */
export const INVITE_TTL_DAYS = 7;

/** { admin, member } seat caps for a plan id; unknown plans get Free's (none). */
export function capsForPlan(planId) {
  return TEAM_SEAT_CAPS[String(planId || '').toLowerCase()] || TEAM_SEAT_CAPS.free;
}

/**
 * SQL condition: the site (column `siteCol`) is on a plan that includes team members
 * — its own Essential/Growth subscription, active/trialing, or cancelled but still
 * inside the paid period (same rule as the Team tab's seat check).
 *
 * Every "does this Admin/Member reach this site" query ANDs this in, so when a site
 * drops to Basic/Free its team is SUSPENDED: access stops everywhere, but the
 * TeamMember/TeamMemberSite rows stay, and access returns by itself if the site goes
 * back to Essential/Growth. Owners are never affected (they don't go through here).
 */
export function siteHasTeamPlanSql(siteCol) {
  // Judge the site's CURRENT subscription only — the same pick as
  // getSubscriptionsBySiteIds (dashboard + Team tab): newest active/trialing, else a
  // cancelled one still inside its paid period. Checking "any Essential/Growth row"
  // let an old cancelled Essential keep the team in after a switch to Basic.
  return `(SELECT lower(tp.planId) FROM Subscription tp
    WHERE tp.siteId = ${siteCol}
      AND (tp.status IN ('active', 'trialing')
           OR (tp.status = 'canceled' AND tp.currentPeriodEnd > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    ORDER BY CASE WHEN tp.status IN ('active', 'trialing') THEN 0 ELSE 1 END, tp.updatedAt DESC
    LIMIT 1) IN ('essential', 'growth')`;
}

/** 'editor' was the old name for 'member'. Anything unrecognised → null. */
export function normalizeRole(role) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'editor') return 'member';
  return TEAM_ROLES.includes(r) ? r : null;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const _tablesReady = new WeakSet();

export async function ensureTeamTables(db) {
  if (!db) return false;
  if (_tablesReady.has(db)) return true;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS TeamMember (
          id               TEXT PRIMARY KEY,
          organizationId   TEXT NOT NULL,
          email            TEXT NOT NULL,
          userId           TEXT,
          role             TEXT NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending',
          invitedByUserId  TEXT,
          inviteTokenHash  TEXT,
          inviteExpiresAt  TEXT,
          createdAt        TEXT NOT NULL,
          updatedAt        TEXT NOT NULL,
          acceptedAt       TEXT,
          UNIQUE (organizationId, email)
        )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS TeamMemberSite (
          memberId  TEXT NOT NULL,
          siteId    TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          PRIMARY KEY (memberId, siteId)
        )`,
      )
      .run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_teammember_user ON TeamMember (userId)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_teammember_email ON TeamMember (email)').run();
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_teammembersite_site ON TeamMemberSite (siteId)').run();
    // Editor → Member rename. Idempotent; if it fails, normalizeRole still reads old
    // rows as 'member', so it must not block table init.
    await db.prepare(`UPDATE TeamMember SET role = 'member' WHERE role = 'editor'`).run().catch(() => {});
    _tablesReady.add(db);
    return true;
  } catch (err) {
    console.warn('[Team] table init failed:', err?.message);
    return false;
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sidFromCookie(request) {
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? m[1].trim() : null;
}

function placeholders(list, offset = 0) {
  return list.map((_, i) => `?${i + 1 + offset}`).join(', ');
}

// ─── Access resolution ───────────────────────────────────────────────────────

/**
 * The caller's role on one site: 'owner' | 'admin' | 'member' | null.
 * Owner = OrganizationMember of the site's org (the check every guarded route
 * already used). Otherwise an ACTIVE TeamMember granted this site in that org.
 * Team tables missing → owner check only, so nothing regresses before first use.
 *
 * A failed OWNER query throws rather than reading as "no access", so each caller
 * picks its own failure mode (consent data fails closed, the dashboard gate open).
 */
export async function getSiteRole(db, userId, siteId) {
  if (!db || !userId || !siteId) return null;

  const owner = await db
    .prepare(
      `SELECT 1 FROM Site s
       JOIN OrganizationMember om ON om.organizationId = s.organizationId
       WHERE s.id = ?1 AND om.userId = ?2 LIMIT 1`,
    )
    .bind(siteId, userId)
    .first();
  if (owner) return 'owner';

  const member = await db
    .prepare(
      `SELECT tm.role FROM TeamMemberSite ts
       JOIN TeamMember tm ON tm.id = ts.memberId
       JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId AND ${siteHasTeamPlanSql('s.id')}
       WHERE ts.siteId = ?1 AND tm.userId = ?2 AND tm.status = 'active'
       LIMIT 1`,
    )
    .bind(siteId, userId)
    .first()
    .catch(() => null);
  return normalizeRole(member?.role);
}

/** True for any role on the site (owner, admin or member). Errors read as false. */
export async function userCanAccessSite(db, userId, siteId) {
  try {
    return (await getSiteRole(db, userId, siteId)) !== null;
  } catch (_) {
    return false;
  }
}

/** True for owner or admin — edit site name/URL, manage members. Errors read as false. */
export async function userCanAdminSite(db, userId, siteId) {
  try {
    const role = await getSiteRole(db, userId, siteId);
    return role === 'owner' || role === 'admin';
  } catch (_) {
    return false;
  }
}

/**
 * Sites in one account (org) that the user is an active Admin of. Used where an Admin
 * acts for the owner (billing, invoices, upgrades) but only for their own sites.
 * Errors / no tables → [].
 */
export async function listAdminSiteIds(db, userId, organizationId) {
  if (!db || !userId || !organizationId) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT ts.siteId FROM TeamMember tm
         JOIN TeamMemberSite ts ON ts.memberId = tm.id
         JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId AND ${siteHasTeamPlanSql('s.id')}
         WHERE tm.userId = ?1 AND tm.organizationId = ?2 AND tm.status = 'active' AND tm.role = 'admin'`,
      )
      .bind(userId, String(organizationId))
      .all();
    return (results || []).map((r) => String(r.siteId));
  } catch (_) {
    return [];
  }
}

/**
 * Who is acting on an account's billing: { owner, admin, ownerEmail, ownerName }.
 *   owner — the caller is in OrganizationMember for the org.
 *   admin — not the owner, but an active Admin of `siteId` in that org (or, with no
 *           siteId — e.g. a brand-new site — an Admin of any site in it).
 * ownerEmail is the owner's billing email (billingEmail, else login email), so an
 * Admin's checkout bills the owner's Stripe customer rather than creating one for
 * the Admin. Errors → neither.
 */
export async function resolveBillingActor(db, userId, organizationId, siteId = null) {
  const none = { owner: false, admin: false, ownerEmail: null, ownerName: null };
  if (!db || !userId || !organizationId) return none;
  try {
    const own = await db
      .prepare('SELECT 1 FROM OrganizationMember WHERE organizationId = ?1 AND userId = ?2 LIMIT 1')
      .bind(String(organizationId), userId)
      .first();
    if (own) return { ...none, owner: true };

    const adminSites = await listAdminSiteIds(db, userId, organizationId);
    const isAdmin = siteId ? adminSites.includes(String(siteId)) : adminSites.length > 0;
    if (!isAdmin) return none;

    const owner = await db
      .prepare(
        `SELECT u.email, u.billingEmail, u.name FROM OrganizationMember om
         JOIN User u ON u.id = om.userId
         WHERE om.organizationId = ?1 LIMIT 1`,
      )
      .bind(String(organizationId))
      .first();
    const ownerEmail = normalizeEmail(owner?.billingEmail || owner?.email);
    return { owner: false, admin: true, ownerEmail: isValidEmail(ownerEmail) ? ownerEmail : null, ownerName: owner?.name || null };
  } catch (_) {
    return none;
  }
}

/**
 * Give an Admin access to a site they just added to the owner's account, so it shows
 * up for them straight away. No-op unless they're an active Admin in that org.
 */
export async function grantAdminNewSite(db, userId, organizationId, siteId) {
  if (!db || !userId || !organizationId || !siteId) return false;
  try {
    const row = await db
      .prepare(
        `SELECT id FROM TeamMember
         WHERE userId = ?1 AND organizationId = ?2 AND status = 'active' AND role = 'admin' LIMIT 1`,
      )
      .bind(userId, String(organizationId))
      .first();
    if (!row?.id) return false;
    await db
      .prepare('INSERT OR IGNORE INTO TeamMemberSite (memberId, siteId, createdAt) VALUES (?1, ?2, ?3)')
      .bind(row.id, String(siteId), new Date().toISOString())
      .run();
    return true;
  } catch (err) {
    console.warn('[Team] grant new site to admin failed:', err?.message);
    return false;
  }
}

/**
 * Every site the user reaches as a team member (not as owner), with its role.
 * [{ siteId, organizationId, role, memberId }]
 */
export async function listMemberSiteGrants(db, userId) {
  if (!db || !userId) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT ts.siteId, tm.organizationId, tm.role, tm.id AS memberId
         FROM TeamMember tm
         JOIN TeamMemberSite ts ON ts.memberId = tm.id
         JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId AND ${siteHasTeamPlanSql('s.id')}
         WHERE tm.userId = ?1 AND tm.status = 'active'`,
      )
      .bind(userId)
      .all();
    return (results || [])
      .map((r) => ({ ...r, role: normalizeRole(r.role) }))
      .filter((r) => r.role);
  } catch (_) {
    return []; // tables not created yet
  }
}

/**
 * Active Admins of a site, to copy on the site's notification emails.
 * [{ email, name }]. Errors (tables missing) → [].
 */
export async function listSiteAdminRecipients(db, siteId) {
  if (!db || !siteId) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT tm.email, u.name
         FROM TeamMemberSite ts
         JOIN TeamMember tm ON tm.id = ts.memberId
         JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId AND ${siteHasTeamPlanSql('s.id')}
         LEFT JOIN User u ON u.id = tm.userId
         WHERE ts.siteId = ?1 AND tm.status = 'active' AND tm.role = 'admin'`,
      )
      .bind(String(siteId))
      .all();
    return (results || [])
      .filter((r) => isValidEmail(r.email))
      .map((r) => ({ email: normalizeEmail(r.email), name: r.name || null }));
  } catch (_) {
    return [];
  }
}

/** True when an invite is waiting for this email (used to hold off auto-creating an org). */
export async function hasPendingInviteForEmail(db, email) {
  const e = normalizeEmail(email);
  if (!db || !e) return false;
  try {
    const row = await db
      .prepare(`SELECT 1 FROM TeamMember WHERE email = ?1 AND status = 'pending' LIMIT 1`)
      .bind(e)
      .first();
    return !!row;
  } catch (_) {
    return false;
  }
}

/**
 * Admins to copy on an email about one site, or — when only the account is known
 * (org-level subscription) — Admins of any site in that account. Deduped.
 */
export async function listAdminRecipientsFor(db, { siteId, organizationId } = {}) {
  if (siteId) return listSiteAdminRecipients(db, siteId);
  if (!db || !organizationId) return [];
  try {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT tm.email, u.name
         FROM TeamMember tm
         JOIN TeamMemberSite ts ON ts.memberId = tm.id
         JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId AND ${siteHasTeamPlanSql('s.id')}
         LEFT JOIN User u ON u.id = tm.userId
         WHERE tm.organizationId = ?1 AND tm.status = 'active' AND tm.role = 'admin'`,
      )
      .bind(String(organizationId))
      .all();
    const seen = new Set();
    const out = [];
    for (const r of results || []) {
      const email = normalizeEmail(r.email);
      if (!isValidEmail(email) || seen.has(email)) continue;
      seen.add(email);
      out.push({ email, name: r.name || null });
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * Send the same notice to the Admins of a site/account. Runs after (and apart from)
 * the owner's email: never throws, never delays the caller, and skips anyone in
 * `exclude` (the owner / billing address that already got it).
 *   send(admin) — admin = { email, name }; call the usual send*Email with to: admin.email.
 */
export function copyEmailToAdmins(db, ctx, target, exclude, send) {
  const skip = new Set((exclude || []).map(normalizeEmail).filter(Boolean));
  const job = (async () => {
    for (const admin of await listAdminRecipientsFor(db, target)) {
      if (skip.has(admin.email)) continue;
      try { send(admin); } catch (err) { console.warn('[Team] admin copy failed:', err?.message); }
    }
  })().catch((err) => console.warn('[Team] admin copy lookup failed:', err?.message));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
  return job;
}

// ─── Reads for the Team tab ──────────────────────────────────────────────────

export async function getTeamMemberById(db, memberId) {
  if (!memberId) return null;
  return db.prepare('SELECT * FROM TeamMember WHERE id = ?1').bind(memberId).first().catch(() => null);
}

export async function getTeamMemberByOrgEmail(db, organizationId, email) {
  return db
    .prepare('SELECT * FROM TeamMember WHERE organizationId = ?1 AND email = ?2')
    .bind(organizationId, normalizeEmail(email))
    .first()
    .catch(() => null);
}

export async function getMemberSiteIds(db, memberId) {
  const { results } = await db
    .prepare('SELECT siteId FROM TeamMemberSite WHERE memberId = ?1')
    .bind(memberId)
    .all();
  return (results || []).map((r) => String(r.siteId));
}

/** Members of an org with their site ids and, when accepted, their name. */
export async function listTeamMembers(db, organizationId) {
  const { results: members } = await db
    .prepare(
      `SELECT tm.id, tm.email, tm.role, tm.status, tm.userId, tm.createdAt, tm.acceptedAt,
              tm.inviteExpiresAt, u.name AS userName
       FROM TeamMember tm
       LEFT JOIN User u ON u.id = tm.userId
       WHERE tm.organizationId = ?1
       ORDER BY tm.createdAt ASC`,
    )
    .bind(organizationId)
    .all();
  const list = members || [];
  if (list.length === 0) return [];

  const ids = list.map((m) => m.id);
  const { results: grants } = await db
    .prepare(`SELECT memberId, siteId FROM TeamMemberSite WHERE memberId IN (${placeholders(ids)})`)
    .bind(...ids)
    .all();
  const byMember = new Map();
  for (const g of grants || []) {
    const k = String(g.memberId);
    if (!byMember.has(k)) byMember.set(k, []);
    byMember.get(k).push(String(g.siteId));
  }

  return list.map((m) => ({
    id: m.id,
    email: m.email,
    name: m.userName || null,
    role: normalizeRole(m.role) || m.role,
    status: m.status,
    siteIds: byMember.get(String(m.id)) || [],
    createdAt: m.createdAt,
    acceptedAt: m.acceptedAt || null,
    inviteExpired: m.status === 'pending' && !!m.inviteExpiresAt && new Date(m.inviteExpiresAt) < new Date(),
  }));
}

/**
 * Seats taken on each site, by role (pending + active):
 * { siteId: { admin: n, member: n } }. `excludeMemberId` leaves one member out so an
 * edit doesn't count the member against their own seat.
 */
export async function countSeatsPerSite(db, siteIds, excludeMemberId = null) {
  const out = {};
  if (!siteIds?.length) return out;
  for (const id of siteIds) out[String(id)] = { admin: 0, member: 0 };
  const { results } = await db
    .prepare(
      `SELECT ts.siteId, tm.role, COUNT(*) AS n
       FROM TeamMemberSite ts
       JOIN TeamMember tm ON tm.id = ts.memberId
       WHERE ts.siteId IN (${placeholders(siteIds)}) AND tm.status IN ('pending', 'active')
         AND tm.id != ?${siteIds.length + 1}
       GROUP BY ts.siteId, tm.role`,
    )
    .bind(...siteIds, excludeMemberId || '')
    .all();
  for (const r of results || []) {
    const role = normalizeRole(r.role);
    const slot = out[String(r.siteId)];
    if (role && slot) slot[role] += Number(r.n) || 0;
  }
  return out;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Create a pending invite, or re-issue one for a member who was removed earlier
 * (the UNIQUE(organizationId, email) row is deleted on removal, so this is always
 * an insert). Returns { member, token } — token is "<memberId>.<secret>".
 */
export async function createTeamInvite(db, { organizationId, email, role, siteIds, invitedByUserId }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const secret = randomSecret();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();

  const stmts = [
    db
      .prepare(
        `INSERT INTO TeamMember
           (id, organizationId, email, userId, role, status, invitedByUserId, inviteTokenHash, inviteExpiresAt, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, NULL, ?4, 'pending', ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(id, organizationId, normalizeEmail(email), role, invitedByUserId || null, await sha256Hex(secret), expiresAt, now),
    ...siteIds.map((siteId) =>
      db
        .prepare('INSERT OR IGNORE INTO TeamMemberSite (memberId, siteId, createdAt) VALUES (?1, ?2, ?3)')
        .bind(id, String(siteId), now),
    ),
  ];
  await db.batch(stmts);
  return { member: await getTeamMemberById(db, id), token: `${id}.${secret}` };
}

/** New token for a pending invite. Returns the token. */
export async function refreshInviteToken(db, memberId) {
  const secret = randomSecret();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();
  await db
    .prepare(
      `UPDATE TeamMember SET inviteTokenHash = ?1, inviteExpiresAt = ?2, updatedAt = ?3
       WHERE id = ?4 AND status = 'pending'`,
    )
    .bind(await sha256Hex(secret), expiresAt, new Date().toISOString(), memberId)
    .run();
  return `${memberId}.${secret}`;
}

/** Resolve "<memberId>.<secret>" to the pending member row, or { error }. */
export async function resolveInviteToken(db, token) {
  const raw = String(token || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0) return { error: 'Invalid invitation link.', code: 'INVALID_TOKEN' };
  const memberId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);

  const member = await getTeamMemberById(db, memberId);
  if (!member) return { error: 'This invitation is no longer valid.', code: 'INVITE_NOT_FOUND' };
  if (member.status === 'active') return { error: 'This invitation has already been accepted.', code: 'ALREADY_ACCEPTED', member };
  if (!member.inviteTokenHash || (await sha256Hex(secret)) !== member.inviteTokenHash) {
    return { error: 'This invitation link is not valid.', code: 'INVALID_TOKEN' };
  }
  if (member.inviteExpiresAt && new Date(member.inviteExpiresAt) < new Date()) {
    return { error: 'This invitation has expired. Ask for a new one.', code: 'INVITE_EXPIRED', member };
  }
  return { member };
}

export async function activateTeamMember(db, memberId, userId) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE TeamMember
       SET userId = ?1, status = 'active', inviteTokenHash = NULL, inviteExpiresAt = NULL, acceptedAt = ?2, updatedAt = ?2
       WHERE id = ?3 AND status = 'pending'`,
    )
    .bind(userId, now, memberId)
    .run();
}

/** Replace a member's role and/or site grants. siteIds = full new list, or undefined to keep. */
export async function updateTeamMember(db, memberId, { role, siteIds }) {
  const now = new Date().toISOString();
  const stmts = [];
  if (role) {
    stmts.push(db.prepare('UPDATE TeamMember SET role = ?1, updatedAt = ?2 WHERE id = ?3').bind(role, now, memberId));
  }
  if (Array.isArray(siteIds)) {
    stmts.push(db.prepare('DELETE FROM TeamMemberSite WHERE memberId = ?1').bind(memberId));
    for (const siteId of siteIds) {
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO TeamMemberSite (memberId, siteId, createdAt) VALUES (?1, ?2, ?3)')
          .bind(memberId, String(siteId), now),
      );
    }
    stmts.push(db.prepare('UPDATE TeamMember SET updatedAt = ?1 WHERE id = ?2').bind(now, memberId));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function deleteTeamMember(db, memberId) {
  await db.batch([
    db.prepare('DELETE FROM TeamMemberSite WHERE memberId = ?1').bind(memberId),
    db.prepare('DELETE FROM TeamMember WHERE id = ?1').bind(memberId),
  ]);
}
