// src/handlers/consentRetentionSettings.js
//
// GET  /api/consent-retention?siteId=…   → the site's retention period and what its plan allows
// POST /api/consent-retention { siteId, days }  → save the customer's pick (days: null = plan default)
//
// Authenticated and site-scoped: the caller's session must belong to the
// organization that owns the site. Not in PUBLIC_PATHS, so POST keeps the CSRF check.
//
// Saving a period changes nothing on its own — deletion only runs when
// CONSENT_RETENTION_MODE is enabled (see services/consentRetention.js). The response
// reports that mode so the dashboard can say whether deletion is active yet.

import { getSessionById } from '../services/db.js';
import { resolveEffectivePlanId } from './bannerCustomization.js';
import { userCanAccessSite } from '../services/team.js';
import {
  getPlanRetentionLimits,
  resolveRetentionDays,
  retentionChoicesForPlan,
  retentionMode,
  readSiteRetentionDays,
  writeSiteRetentionDays,
} from '../services/consentRetention.js';

function sidFromCookie(request) {
  const cookie = request.headers.get('Cookie') || request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? m[1].trim() : null;
}

// Same check as middleware/consentAccess.js sessionOwnsSite: owner of the site's
// org, or an active team member granted the site.
async function sessionOwnsSite(db, request, siteId) {
  if (!db || !siteId) return false;
  const sid = sidFromCookie(request);
  if (!sid) return false;
  const session = await getSessionById(db, sid);
  const userId = session?.userId ?? session?.user_id;
  if (!userId) return false;
  return userCanAccessSite(db, userId, siteId);
}

async function describe(db, env, siteId) {
  const planId = await resolveEffectivePlanId(db, env, siteId);
  // null = plan resolution failed. Show free's range for display, but flag it so
  // the dashboard can refuse to save until the plan is known.
  const planForLimits = planId ?? 'free';
  const limits = getPlanRetentionLimits(planForLimits);
  const chosenDays = await readSiteRetentionDays(db, siteId);
  return {
    success: true,
    siteId,
    planId,
    planKnown: planId !== null,
    limits,
    choices: retentionChoicesForPlan(planForLimits),
    chosenDays,
    effectiveDays: resolveRetentionDays(planForLimits, chosenDays),
    mode: retentionMode(env),
  };
}

export async function handleConsentRetentionSettings(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const siteId = url.searchParams.get('siteId');
    if (!siteId) return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    if (!(await sessionOwnsSite(db, request, siteId))) {
      return Response.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }
    try {
      return Response.json(await describe(db, env, siteId));
    } catch (err) {
      console.warn('[ConsentRetention][GET] failed:', err?.message);
      return Response.json({ success: false, error: 'Could not load retention settings.' }, { status: 500 });
    }
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });

    const siteId = body.siteId ? String(body.siteId) : '';
    if (!siteId) return Response.json({ success: false, error: 'siteId is required' }, { status: 400 });
    if (!(await sessionOwnsSite(db, request, siteId))) {
      return Response.json({ success: false, error: 'Authentication required.' }, { status: 401 });
    }

    try {
      const planId = await resolveEffectivePlanId(db, env, siteId);
      if (planId === null) {
        // Never validate against a guessed plan — a paying site could be clamped to free.
        return Response.json(
          { success: false, error: 'Could not verify your plan. Please try again.' },
          { status: 503 },
        );
      }

      let days = null;
      if (body.days !== null && body.days !== undefined && body.days !== '') {
        days = Math.round(Number(body.days));
        const { minDays, maxDays } = getPlanRetentionLimits(planId);
        if (!Number.isFinite(days) || days < minDays || days > maxDays) {
          return Response.json(
            {
              success: false,
              error: `Your plan allows ${minDays}–${maxDays} days.`,
              code: 'OUT_OF_PLAN_RANGE',
              limits: { minDays, maxDays },
            },
            { status: 400 },
          );
        }
      }

      await writeSiteRetentionDays(db, siteId, days);
      return Response.json(await describe(db, env, siteId));
    } catch (err) {
      console.warn('[ConsentRetention][POST] failed:', err?.message);
      return Response.json({ success: false, error: 'Could not save retention settings.' }, { status: 500 });
    }
  }

  return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
}
