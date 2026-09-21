// src/handlers/team.js
//
// Team members API (web-app Profile → Team). Session-authenticated; none of these
// are in PUBLIC_PATHS, so POSTs keep the CSRF check and responses are encoded.
//
//   GET  /api/team?organizationId=        members + assignable sites + per-site caps
//   POST /api/team/invite                 { organizationId?, email, role, siteIds[], appOrigin? }
//   POST /api/team/update                 { memberId, role?, siteIds? }
//   POST /api/team/remove                 { memberId }
//   POST /api/team/resend                 { memberId, appOrigin? }
//   GET  /api/team/invite-info?token=     what the invite is for (no session needed)
//   POST /api/team/accept                 { token }  — session email must match the invite
//
// Who may manage: the account owner (OrganizationMember) for every site in the org,
// or an active Admin for the sites they were granted. See services/team.js.

import {
  getSessionById,
  getUserById,
  getOrganizationsForUser,
  listSites,
  getOrgOwnerEmail,
  getSubscriptionsBySiteIds,
  inferTierPlanIdFromStripePriceId,
} from '../services/db.js';
import { sendTeamInviteEmail, sendTeamActivityEmail } from '../services/email.js';
import {
  TEAM_ROLES,
  INVITE_TTL_DAYS,
  capsForPlan,
  normalizeRole,
  ensureTeamTables,
  normalizeEmail,
  isValidEmail,
  sidFromCookie,
  listTeamMembers,
  countSeatsPerSite,
  getTeamMemberById,
  getTeamMemberByOrgEmail,
  getMemberSiteIds,
  createTeamInvite,
  refreshInviteToken,
  resolveInviteToken,
  activateTeamMember,
  updateTeamMember,
  deleteTeamMember,
  listSiteAdminRecipients,
  siteHasTeamPlanSql,
} from '../services/team.js';

const json = (body, status = 200) => Response.json(body, { status });

async function requireUser(db, request) {
  const sid = sidFromCookie(request);
  if (!sid) return null;
  const session = await getSessionById(db, sid);
  const userId = session?.userId ?? session?.user_id;
  if (!userId) return null;
  return getUserById(db, userId);
}

function resolveAppOrigin(request, env, suppliedOrigin) {
  const candidate = String(suppliedOrigin || '').trim();
  if (candidate) {
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch (_) { /* fall through */ }
  }
  const configured = String(env.WEBAPP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  // Same fallback as every other emailed link (services/email.js). The request origin is
  // this Worker (the webapp proxies server-side), so it would link to manager.consentbit.com.
  return 'https://accounts.consentbit.com';
}

function siteLabel(site) {
  return site?.name && site?.domain && site.name !== site.domain
    ? `${site.name} (${site.domain})`
    : site?.domain || site?.name || 'Site';
}

/**
 * Organizations this user may manage a team for, owner orgs first:
 * [{ organizationId, name, role: 'owner' | 'admin' }]
 */
async function listManageableOrganizations(db, userId) {
  const out = [];
  const seen = new Set();
  for (const org of await getOrganizationsForUser(db, userId)) {
    if (seen.has(String(org.id))) continue;
    seen.add(String(org.id));
    out.push({ organizationId: String(org.id), name: org.name || null, role: 'owner' });
  }
  const { results } = await db
    .prepare(
      `SELECT DISTINCT tm.organizationId, o.name
       FROM TeamMember tm JOIN Organization o ON o.id = tm.organizationId
       WHERE tm.userId = ?1 AND tm.status = 'active' AND tm.role = 'admin'
         AND EXISTS (SELECT 1 FROM TeamMemberSite ts
                     JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId
                     WHERE ts.memberId = tm.id AND ${siteHasTeamPlanSql('s.id')})`,
    )
    .bind(userId)
    .all()
    .catch(() => ({ results: [] }));
  for (const r of results || []) {
    if (seen.has(String(r.organizationId))) continue;
    seen.add(String(r.organizationId));
    out.push({ organizationId: String(r.organizationId), name: r.name || null, role: 'admin' });
  }
  return out;
}

/**
 * The caller's management context for one org: their role there and the sites they
 * may grant. Owner → every site in the org. Admin → only their own granted sites.
 * Returns { error, status } when the caller cannot manage that org.
 */
async function resolveContext(db, user, requestedOrgId) {
  const orgs = await listManageableOrganizations(db, user.id);
  if (orgs.length === 0) {
    // An Admin whose sites all dropped to Basic/Free is suspended, not a stranger —
    // say so, so they know what to ask the owner for.
    const suspendedAdmin = await db
      .prepare(`SELECT 1 FROM TeamMember WHERE userId = ?1 AND status = 'active' AND role = 'admin' LIMIT 1`)
      .bind(user.id)
      .first()
      .catch(() => null);
    if (suspendedAdmin) {
      return {
        error: 'Your team access is paused: the sites you were given are on the Basic or Free plan, which has no team members. It comes back automatically when the account owner moves a site to Essential or Growth.',
        status: 403,
        code: 'TEAM_SUSPENDED',
      };
    }
    return { error: 'You do not have permission to manage a team.', status: 403 };
  }

  const org = requestedOrgId
    ? orgs.find((o) => o.organizationId === String(requestedOrgId))
    : orgs[0];
  if (!org) return { error: 'You do not have permission to manage this team.', status: 403 };

  let sites = await listSites(db, { organizationId: org.organizationId });
  if (org.role === 'admin') {
    const { results } = await db
      .prepare(
        `SELECT ts.siteId FROM TeamMember tm JOIN TeamMemberSite ts ON ts.memberId = tm.id
         JOIN Site s ON s.id = ts.siteId AND s.organizationId = tm.organizationId AND ${siteHasTeamPlanSql('s.id')}
         WHERE tm.userId = ?1 AND tm.organizationId = ?2 AND tm.status = 'active' AND tm.role = 'admin'`,
      )
      .bind(user.id, org.organizationId)
      .all();
    const granted = new Set((results || []).map((r) => String(r.siteId)));
    sites = sites.filter((s) => granted.has(String(s.id)));
  }

  return {
    organizationId: org.organizationId,
    organizationName: org.name,
    viewerRole: org.role,
    organizations: orgs,
    sites,
    siteIds: new Set(sites.map((s) => String(s.id))),
  };
}

const roleName = (role) => (role === 'admin' ? 'Admin' : 'Member');

/**
 * Email the account owner and the Admins of `siteIds` that someone was invited or
 * joined. Skips the person who did it and the member themselves. Fire-and-forget:
 * a failed lookup or send never affects the API response.
 */
function notifyTeamActivity(env, db, workerCtx, { request, appOrigin, organizationId, siteIds, event, memberEmail, role, actor }) {
  const job = (async () => {
    const skip = new Set([normalizeEmail(memberEmail), normalizeEmail(actor?.email)].filter(Boolean));
    const recipients = new Map();
    const owner = await getOrgOwnerEmail(db, organizationId).catch(() => null);
    if (owner?.email) recipients.set(normalizeEmail(owner.email), owner.name || null);
    for (const siteId of siteIds) {
      for (const a of await listSiteAdminRecipients(db, siteId)) {
        if (!recipients.has(a.email)) recipients.set(a.email, a.name);
      }
    }
    for (const email of skip) recipients.delete(email);
    if (recipients.size === 0) return;

    const { results } = siteIds.length
      ? await db
          .prepare(`SELECT name, domain FROM Site WHERE id IN (${siteIds.map((_, i) => `?${i + 1}`).join(', ')})`)
          .bind(...siteIds)
          .all()
          .catch(() => ({ results: [] }))
      : { results: [] };
    const siteLabels = (results || []).map(siteLabel);
    const teamUrl = `${resolveAppOrigin(request, env, appOrigin)}/dashboard/profile`;

    for (const [to, name] of recipients) {
      sendTeamActivityEmail(env, workerCtx, {
        to,
        name,
        event,
        memberEmail,
        role,
        siteLabels,
        actorName: actor?.name || null,
        actorEmail: actor?.email || null,
        teamUrl,
      });
    }
  })().catch((err) => console.warn('[Team] activity email failed:', err?.message));
  if (workerCtx?.waitUntil) workerCtx.waitUntil(job);
}

const PAID_TIERS = ['basic', 'essential', 'growth'];

/**
 * Each site's OWN plan: { siteId: 'free'|'basic'|'essential'|'growth' }, or null when
 * the lookup failed (callers treat that as unknown). Same rule as dashboard-init, so
 * the Team tab matches the plan shown in the header. Deliberately NOT
 * resolveEffectivePlanId: that falls back to the account-wide plan, so a new Free site
 * next to an Essential one read as Essential and got Essential seats.
 */
async function resolveSitePlans(db, env, siteIds) {
  if (siteIds.length === 0) return {};
  try {
    const subs = await getSubscriptionsBySiteIds(db, siteIds);
    const out = {};
    for (const id of siteIds) {
      const sub = subs[id] || null;
      let planId = String(sub?.planId ?? sub?.planid ?? '').toLowerCase();
      if (sub && !PAID_TIERS.includes(planId)) {
        planId = inferTierPlanIdFromStripePriceId(env, sub.stripePriceId ?? sub.stripepriceid ?? null) || planId;
      }
      out[id] = PAID_TIERS.includes(planId) ? planId : 'free';
    }
    return out;
  } catch (err) {
    console.warn('[Team] site plan lookup failed:', err?.message);
    return null;
  }
}

/**
 * Plan, per-role seat caps and seats taken for each site.
 * caps/used are { admin, member }; a null cap means unlimited. teamEnabled is false
 * on plans with no team feature (Free, Basic).
 */
async function describeSites(db, env, sites, excludeMemberId = null) {
  const ids = sites.map((s) => String(s.id));
  const [counts, plans] = await Promise.all([
    countSeatsPerSite(db, ids, excludeMemberId),
    resolveSitePlans(db, env, ids),
  ]);
  const out = [];
  for (const s of sites) {
    const planId = plans ? plans[String(s.id)] ?? 'free' : null;
    const caps = capsForPlan(planId ?? 'free');
    out.push({
      id: String(s.id),
      name: s.name || null,
      domain: s.domain || null,
      planId,
      teamEnabled: caps.admin > 0 || caps.member > 0,
      caps: {
        admin: Number.isFinite(caps.admin) ? caps.admin : null,
        member: Number.isFinite(caps.member) ? caps.member : null,
      },
      used: counts[String(s.id)] || { admin: 0, member: 0 },
    });
  }
  return out;
}

/**
 * Sites in `siteIds` with no free `role` seat. `excludeMemberId` is the member being
 * edited, so their own seat doesn't count against them.
 */
async function sitesOverCap(db, env, ctx, siteIds, role, excludeMemberId = null) {
  if (siteIds.length === 0) return { over: [] };
  const sites = ctx.sites.filter((s) => siteIds.includes(String(s.id)));
  const described = await describeSites(db, env, sites, excludeMemberId);
  if (described.some((d) => d.planId === null)) {
    return { unknownPlan: true, over: [] };
  }
  return { over: described.filter((d) => d.caps[role] !== null && d.used[role] >= d.caps[role]) };
}

function capError(over, role) {
  const disabled = over.filter((d) => !d.teamEnabled);
  if (disabled.length === over.length) {
    const names = disabled.map((d) => d.domain || d.name);
    return json(
      {
        success: false,
        error: `Team members are available on the Essential and Growth plans. Upgrade ${names.join(', ')} to invite people.`,
        code: 'TEAM_NOT_AVAILABLE',
        sites: over,
      },
      403,
    );
  }
  const names = over.map((d) => {
    const cap = d.caps[role];
    return `${d.domain || d.name} (${d.planId} plan: ${cap} ${roleName(role)}${cap === 1 ? '' : 's'})`;
  });
  return json(
    {
      success: false,
      error: `${roleName(role)} limit reached for ${names.join(', ')}. Upgrade the plan or remove someone first.`,
      code: 'TEAM_LIMIT_REACHED',
      sites: over,
    },
    403,
  );
}

function parseSiteIds(raw) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map((v) => String(v || '').trim()).filter(Boolean))];
}

// ─── GET /api/team ───────────────────────────────────────────────────────────

async function handleList(request, env, db, user) {
  const url = new URL(request.url);
  const ctx = await resolveContext(db, user, url.searchParams.get('organizationId'));
  if (ctx.error) return json({ success: false, error: ctx.error, ...(ctx.code ? { code: ctx.code } : {}) }, ctx.status);

  const [owner, allMembers, sites] = await Promise.all([
    getOrgOwnerEmail(db, ctx.organizationId).catch(() => null),
    listTeamMembers(db, ctx.organizationId),
    describeSites(db, env, ctx.sites),
  ]);

  // Sites on Basic/Free have no team feature: people granted only those are suspended
  // (kept, not deleted — they come back if the site returns to Essential/Growth).
  const teamSiteIds = new Set(sites.filter((s) => s.teamEnabled).map((s) => s.id));
  const withSuspension = (m) => {
    const suspendedSiteIds = m.siteIds.filter((id) => !teamSiteIds.has(id));
    return { ...m, suspendedSiteIds, suspended: m.siteIds.length > 0 && suspendedSiteIds.length === m.siteIds.length };
  };

  // Admins see only members who share at least one of their sites.
  const members = (ctx.viewerRole === 'owner'
    ? allMembers
    : allMembers.filter((m) => m.siteIds.some((id) => ctx.siteIds.has(id)))
  ).map((m) => {
    const isSelf = !!m.email && normalizeEmail(m.email) === normalizeEmail(user.email);
    const outsideViewer = m.siteIds.filter((id) => !ctx.siteIds.has(id));
    return {
      ...m,
      // Admins don't learn about sites they can't see.
      siteIds: ctx.viewerRole === 'owner' ? m.siteIds : m.siteIds.filter((id) => ctx.siteIds.has(id)),
      hasOtherSites: ctx.viewerRole !== 'owner' && outsideViewer.length > 0,
      isSelf,
      canEdit: !isSelf,
      canRemove: !isSelf,
    };
  }).map(withSuspension);

  return json({
    success: true,
    organizationId: ctx.organizationId,
    organizationName: ctx.organizationName,
    viewerRole: ctx.viewerRole,
    owner: owner ? { email: owner.email, name: owner.name || null } : null,
    organizations: ctx.organizations,
    sites,
    members,
    roles: TEAM_ROLES,
  });
}

// ─── POST /api/team/invite ───────────────────────────────────────────────────

async function handleInvite(request, env, db, user, workerCtx) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ success: false, error: 'Invalid JSON body' }, 400);

  const ctx = await resolveContext(db, user, body.organizationId);
  if (ctx.error) return json({ success: false, error: ctx.error, ...(ctx.code ? { code: ctx.code } : {}) }, ctx.status);

  const email = normalizeEmail(body.email);
  const role = normalizeRole(body.role);
  const siteIds = parseSiteIds(body.siteIds);

  if (!isValidEmail(email)) return json({ success: false, error: 'Enter a valid email address.', code: 'INVALID_EMAIL' }, 400);
  if (!role) return json({ success: false, error: 'Choose a role: Admin or Member.', code: 'INVALID_ROLE' }, 400);
  if (!siteIds || siteIds.length === 0) return json({ success: false, error: 'Select at least one site.', code: 'NO_SITES' }, 400);
  if (siteIds.some((id) => !ctx.siteIds.has(id))) {
    return json({ success: false, error: 'You can only give access to sites you manage.', code: 'SITE_NOT_ALLOWED' }, 403);
  }
  if (email === normalizeEmail(user.email)) {
    return json({ success: false, error: 'You cannot invite yourself.', code: 'SELF_INVITE' }, 400);
  }

  const owner = await getOrgOwnerEmail(db, ctx.organizationId).catch(() => null);
  if (owner?.email && normalizeEmail(owner.email) === email) {
    return json({ success: false, error: 'That email is the account owner.', code: 'IS_OWNER' }, 400);
  }
  const ownerMember = await db
    .prepare(
      `SELECT 1 FROM OrganizationMember om JOIN User u ON u.id = om.userId
       WHERE om.organizationId = ?1 AND lower(u.email) = ?2 LIMIT 1`,
    )
    .bind(ctx.organizationId, email)
    .first()
    .catch(() => null);
  if (ownerMember) return json({ success: false, error: 'That email already owns this account.', code: 'IS_OWNER' }, 400);

  const existing = await getTeamMemberByOrgEmail(db, ctx.organizationId, email);
  if (existing) {
    return json(
      {
        success: false,
        error: existing.status === 'pending'
          ? 'This person already has a pending invitation. Resend it from the member list.'
          : 'This person is already a team member. Edit their access from the member list.',
        code: existing.status === 'pending' ? 'ALREADY_INVITED' : 'ALREADY_MEMBER',
        memberId: existing.id,
      },
      409,
    );
  }

  const cap = await sitesOverCap(db, env, ctx, siteIds, role);
  if (cap.unknownPlan) return json({ success: false, error: 'Could not verify the site plan. Please try again.' }, 503);
  if (cap.over.length) return capError(cap.over, role);

  let created;
  try {
    created = await createTeamInvite(db, {
      organizationId: ctx.organizationId,
      email,
      role,
      siteIds,
      invitedByUserId: user.id,
    });
  } catch (err) {
    if (/UNIQUE/i.test(err?.message || '')) {
      return json({ success: false, error: 'This person was just invited.', code: 'ALREADY_INVITED' }, 409);
    }
    throw err;
  }

  const link = `${resolveAppOrigin(request, env, body.appOrigin)}/team/accept?token=${encodeURIComponent(created.token)}`;
  const siteLabels = ctx.sites.filter((s) => siteIds.includes(String(s.id))).map(siteLabel);
  sendTeamInviteEmail(env, workerCtx, {
    to: email,
    inviterName: user.name || null,
    inviterEmail: user.email,
    role,
    siteLabels,
    link,
    ttlDays: INVITE_TTL_DAYS,
  });
  notifyTeamActivity(env, db, workerCtx, {
    request,
    appOrigin: body.appOrigin,
    organizationId: ctx.organizationId,
    siteIds,
    event: 'invited',
    memberEmail: email,
    role,
    actor: { name: user.name || null, email: user.email },
  });

  return json({
    success: true,
    member: { id: created.member.id, email, role, status: 'pending', siteIds },
    // Local dev without Brevo has no way to receive the email.
    ...(env.BREVO_API_KEY ? {} : { inviteLink: link }),
  });
}

// ─── Loading a member the caller may act on ──────────────────────────────────

async function loadManagedMember(db, user, memberId) {
  const member = await getTeamMemberById(db, memberId);
  if (!member) return { error: 'Team member not found.', status: 404 };
  const ctx = await resolveContext(db, user, member.organizationId);
  if (ctx.error) return { error: 'Team member not found.', status: 404 };
  const siteIds = await getMemberSiteIds(db, member.id);
  if (ctx.viewerRole === 'admin' && !siteIds.some((id) => ctx.siteIds.has(id))) {
    return { error: 'Team member not found.', status: 404 };
  }
  if (member.userId && String(member.userId) === String(user.id)) {
    return { error: 'You cannot change your own access.', status: 403 };
  }
  return { member, ctx, siteIds };
}

// ─── POST /api/team/update ───────────────────────────────────────────────────

async function handleUpdate(request, env, db, user) {
  const body = await request.json().catch(() => null);
  if (!body?.memberId) return json({ success: false, error: 'memberId is required' }, 400);

  const loaded = await loadManagedMember(db, user, String(body.memberId));
  if (loaded.error) return json({ success: false, error: loaded.error }, loaded.status);
  const { member, ctx, siteIds: currentIds } = loaded;

  const currentRole = normalizeRole(member.role) || 'member';
  let role;
  if (body.role !== undefined) {
    role = normalizeRole(body.role);
    if (!role) return json({ success: false, error: 'Choose a role: Admin or Member.', code: 'INVALID_ROLE' }, 400);
  }
  const roleChanged = !!role && role !== currentRole;
  // A role applies to every site the person holds. An Admin can't see the sites
  // outside their slice, so they can't check (or vouch for) seats there.
  if (roleChanged && ctx.viewerRole === 'admin' && currentIds.some((id) => !ctx.siteIds.has(id))) {
    return json(
      {
        success: false,
        error: 'This person also has access to sites you don\'t manage. Ask the account owner to change their role.',
        code: 'ROLE_CHANGE_NOT_ALLOWED',
      },
      403,
    );
  }

  let nextIds = currentIds;
  let siteIdsToWrite;
  if (body.siteIds !== undefined) {
    const requested = parseSiteIds(body.siteIds);
    if (!requested) return json({ success: false, error: 'siteIds must be a list' }, 400);
    if (requested.some((id) => !ctx.siteIds.has(id))) {
      return json({ success: false, error: 'You can only give access to sites you manage.', code: 'SITE_NOT_ALLOWED' }, 403);
    }
    // An admin edits only their own slice; grants on sites they can't see are kept.
    const kept = currentIds.filter((id) => !ctx.siteIds.has(id));
    nextIds = [...new Set([...kept, ...requested])];
    if (nextIds.length === 0) {
      return json({ success: false, error: 'A member needs at least one site. Remove them instead.', code: 'NO_SITES' }, 400);
    }
    siteIdsToWrite = nextIds;
  }

  // Seats to check: every site under a new role, otherwise only newly added sites.
  const effectiveRole = role || currentRole;
  const held = new Set(currentIds);
  const toCheck = roleChanged ? nextIds : nextIds.filter((id) => !held.has(id));
  const cap = await sitesOverCap(db, env, ctx, toCheck, effectiveRole, member.id);
  if (cap.unknownPlan) return json({ success: false, error: 'Could not verify the site plan. Please try again.' }, 503);
  if (cap.over.length) return capError(cap.over, effectiveRole);

  await updateTeamMember(db, member.id, { role, siteIds: siteIdsToWrite });
  return json({ success: true, memberId: member.id });
}

// ─── POST /api/team/remove ───────────────────────────────────────────────────

async function handleRemove(request, env, db, user) {
  const body = await request.json().catch(() => null);
  if (!body?.memberId) return json({ success: false, error: 'memberId is required' }, 400);

  const loaded = await loadManagedMember(db, user, String(body.memberId));
  if (loaded.error) return json({ success: false, error: loaded.error }, loaded.status);
  const { member, ctx, siteIds } = loaded;

  // An admin who shares only some of the member's sites removes just those.
  const remaining = siteIds.filter((id) => !ctx.siteIds.has(id));
  if (ctx.viewerRole === 'admin' && remaining.length > 0) {
    await updateTeamMember(db, member.id, { siteIds: remaining });
    return json({ success: true, memberId: member.id, removed: 'sites' });
  }

  await deleteTeamMember(db, member.id);
  return json({ success: true, memberId: member.id, removed: 'member' });
}

// ─── POST /api/team/resend ───────────────────────────────────────────────────

async function handleResend(request, env, db, user, workerCtx) {
  const body = await request.json().catch(() => null);
  if (!body?.memberId) return json({ success: false, error: 'memberId is required' }, 400);

  const loaded = await loadManagedMember(db, user, String(body.memberId));
  if (loaded.error) return json({ success: false, error: loaded.error }, loaded.status);
  const { member, ctx, siteIds } = loaded;
  if (member.status !== 'pending') {
    return json({ success: false, error: 'This member has already accepted.', code: 'ALREADY_ACCEPTED' }, 400);
  }

  const token = await refreshInviteToken(db, member.id);
  const link = `${resolveAppOrigin(request, env, body.appOrigin)}/team/accept?token=${encodeURIComponent(token)}`;
  const siteLabels = ctx.sites.filter((s) => siteIds.includes(String(s.id))).map(siteLabel);
  sendTeamInviteEmail(env, workerCtx, {
    to: member.email,
    inviterName: user.name || null,
    inviterEmail: user.email,
    role: member.role,
    siteLabels,
    link,
    ttlDays: INVITE_TTL_DAYS,
  });

  return json({ success: true, memberId: member.id, ...(env.BREVO_API_KEY ? {} : { inviteLink: link }) });
}

// ─── GET /api/team/invite-info ───────────────────────────────────────────────

async function describeInvite(db, member) {
  const [owner, siteRows] = await Promise.all([
    getOrgOwnerEmail(db, member.organizationId).catch(() => null),
    db
      .prepare(
        `SELECT s.name, s.domain FROM TeamMemberSite ts JOIN Site s ON s.id = ts.siteId
         WHERE ts.memberId = ?1`,
      )
      .bind(member.id)
      .all()
      .catch(() => ({ results: [] })),
  ]);
  const inviter = member.invitedByUserId ? await getUserById(db, member.invitedByUserId).catch(() => null) : null;
  return {
    email: member.email,
    role: normalizeRole(member.role) || member.role,
    status: member.status,
    ownerEmail: owner?.email || null,
    inviterEmail: inviter?.email || owner?.email || null,
    inviterName: inviter?.name || owner?.name || null,
    sites: (siteRows.results || []).map((s) => ({ name: s.name || null, domain: s.domain || null })),
  };
}

async function handleInviteInfo(request, env, db) {
  const token = new URL(request.url).searchParams.get('token');
  const resolved = await resolveInviteToken(db, token);
  if (resolved.error && !resolved.member) {
    return json({ success: false, error: resolved.error, code: resolved.code }, 404);
  }
  const invite = await describeInvite(db, resolved.member);
  if (resolved.error) {
    return json({ success: false, error: resolved.error, code: resolved.code, invite: { email: invite.email } }, 410);
  }
  return json({ success: true, invite });
}

// ─── POST /api/team/accept ───────────────────────────────────────────────────

async function handleAccept(request, env, db, user, workerCtx) {
  const body = await request.json().catch(() => null);
  const resolved = await resolveInviteToken(db, body?.token);
  if (resolved.error) {
    const status = resolved.code === 'ALREADY_ACCEPTED' ? 409 : resolved.code === 'INVITE_EXPIRED' ? 410 : 404;
    return json({ success: false, error: resolved.error, code: resolved.code }, status);
  }
  const { member } = resolved;

  if (normalizeEmail(user.email) !== normalizeEmail(member.email)) {
    return json(
      {
        success: false,
        error: `This invitation is for ${member.email}. Sign in with that email to accept it.`,
        code: 'EMAIL_MISMATCH',
        inviteEmail: member.email,
      },
      403,
    );
  }

  const isOwner = await db
    .prepare('SELECT 1 FROM OrganizationMember WHERE organizationId = ?1 AND userId = ?2 LIMIT 1')
    .bind(member.organizationId, user.id)
    .first()
    .catch(() => null);
  if (isOwner) {
    await deleteTeamMember(db, member.id);
    return json({ success: false, error: 'You already own this account.', code: 'IS_OWNER' }, 400);
  }

  await activateTeamMember(db, member.id, user.id);
  const siteIds = await getMemberSiteIds(db, member.id);
  notifyTeamActivity(env, db, workerCtx, {
    request,
    appOrigin: body?.appOrigin,
    organizationId: member.organizationId,
    siteIds,
    event: 'accepted',
    memberEmail: member.email,
    role: normalizeRole(member.role) || 'member',
    actor: { name: user.name || null, email: user.email },
  });
  return json({ success: true, organizationId: member.organizationId, role: normalizeRole(member.role) || member.role, siteIds });
}

// ─── Router entry ────────────────────────────────────────────────────────────

export async function handleTeam(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;
  const path = new URL(request.url).pathname;

  if (!(await ensureTeamTables(db))) {
    return json({ success: false, error: 'Team features are temporarily unavailable.' }, 503);
  }

  // Readable before sign-in so the accept page can say who invited whom.
  if (path === '/api/team/invite-info') {
    if (request.method !== 'GET') return json({ success: false, error: 'Method Not Allowed' }, 405);
    return handleInviteInfo(request, env, db);
  }

  const user = await requireUser(db, request);
  if (!user) return json({ success: false, error: 'Login required' }, 401);

  try {
    if (path === '/api/team') {
      if (request.method !== 'GET') return json({ success: false, error: 'Method Not Allowed' }, 405);
      return await handleList(request, env, db, user);
    }
    if (request.method !== 'POST') return json({ success: false, error: 'Method Not Allowed' }, 405);
    switch (path) {
      case '/api/team/invite': return await handleInvite(request, env, db, user, ctx);
      case '/api/team/update': return await handleUpdate(request, env, db, user);
      case '/api/team/remove': return await handleRemove(request, env, db, user);
      case '/api/team/resend': return await handleResend(request, env, db, user, ctx);
      case '/api/team/accept': return await handleAccept(request, env, db, user, ctx);
      default: return json({ success: false, error: 'Not Found' }, 404);
    }
  } catch (err) {
    console.error('[Team] request failed:', path, err?.message);
    return json({ success: false, error: 'Something went wrong. Please try again.' }, 500);
  }
}
