// handlers/bannerTemplates.js
//
// Saved banner templates — a named snapshot of a site's *visual* banner settings that
// can be replayed onto another site, so a new site doesn't have to be styled by hand.
//
// Scope is deliberately narrow: COLORS + LAYOUT only. Text content, the privacy-policy
// URL and the banner/regulation type are per-site and are never carried across (see
// TEMPLATE_* below). A template is stored as a single JSON blob rather than mirrored
// columns, so a new banner field rides along without a second migration.
//
// This handler owns its own table and never calls ensureSchema — the banner save path
// deliberately avoids it, and templates must not be able to slow or break that path.
import {
  getSessionById,
  getOrganizationsForUser,
  getBannerCustomization,
  getEffectivePlanForOrganization,
} from '../services/db.js';
import { handleBannerCustomization } from './bannerCustomization.js';

// Ceiling on one apply request. Each site costs a D1 read, a D1 write and — for Webflow
// sites — a Webflow API call, so an unbounded list would run into the worker CPU limit
// partway through and leave the batch half applied with no record of where it stopped.
const MAX_SITES_PER_APPLY = 25;

// Banner templates are a Growth-only entitlement. The webapp hides the controls below
// Growth, but this endpoint is callable directly, so writes are re-checked here.
const TEMPLATE_PLANS = ['growth'];

/**
 * True when the org may create or apply templates. Returns null when plan resolution
 * itself failed — callers must treat that as "unknown" and let the write through rather
 * than locking a paying customer out of their own templates on a transient D1 error.
 * Same convention as the gates in handlers/bannerCustomization.js.
 */
async function orgCanUseTemplates(db, env, organizationId) {
  try {
    const result = await getEffectivePlanForOrganization(db, organizationId, env);
    const planId = String(result?.planId || 'free').toLowerCase();
    return TEMPLATE_PLANS.includes(planId);
  } catch (err) {
    console.warn('[BannerTemplates] Plan resolution failed:', err?.message);
    return null;
  }
}

// Two slots for now. Enforced here, not just in the UI — this endpoint is callable
// directly and unbounded rows per org would be a cheap way to bloat D1.
const MAX_TEMPLATES_PER_ORG = 2;

// ── What a template carries ────────────────────────────────────────────────
// Colors tab. Every paint surface on the banner and the preference panel.
const TEMPLATE_COLOR_FIELDS = [
  'backgroundColor',
  'textColor',
  'headingColor',
  'acceptButtonBg',
  'acceptButtonText',
  'rejectButtonBg',
  'rejectButtonText',
  'customiseButtonBg',
  'customiseButtonText',
  'saveButtonBg',
  'saveButtonText',
  'backButtonBg',
  'backButtonText',
  'doNotSellButtonBg',
  'doNotSellButtonText',
];

// Layout tab. Shape, placement and motion — nothing that reads as content.
const TEMPLATE_LAYOUT_FIELDS = [
  'position',
  'bannerBorderRadius',
  'buttonBorderRadius',
  'preferencePosition',
  'centerAnimationDirection',
  'animationEnabled',
  'stopScroll',
];

// Layout values that live in the translations blob rather than a column. `config` is
// the block cdnM.js checks first, so it is the copy that actually takes effect.
const TEMPLATE_CONFIG_KEYS = ['bannerLayoutVisual', 'bannerEntranceAnimation'];

// Content tab — the banner's copy, carried inside translations.en.
//
// languageSelected is in this list on purpose: the strings below *are* a language, and the
// runtime picks its built-in section labels from languageSelected, so copying the copy
// without the language would render a half-translated banner.
const TEMPLATE_CONTENT_KEYS = [
  'languageSelected',
  'title',
  'description',
  'ccpaDescription',
  'acceptAll',
  'rejectAll',
  'customise',
  'doNotSell',
  'cookiePreferences',
  'managePreferences',
  'optOutPreference',
  'ccpaOptOutPreferenceIntro',
  'cancel',
  'saveMyPreferences',
  'ccpaSaveMyPreferences',
  'privacyPolicy',
  'closeButtonEnabled',
  'rejectButtonEnabled',
  'customizeButtonEnabled',
  'essential',
  'essentialDescription',
  'analytics',
  'analyticsDescription',
  'marketing',
  'marketingDescription',
  'preferences',
  'preferencesDescription',
  'alwaysActive',
];

// Deliberately NOT carried across, each for a different reason:
//   privacyPolicyUrl       — per-site URL; copying points site B at site A's policy.
//   cookiePolicyLinkEnabled — would switch on a link whose URL is the per-site value
//                            above and therefore may not exist on the target site.
//   compliance/region_mode — a legal choice about a site's audience, and geo-gated.
//   isIab / isGoogleAc     — per-site registration plus a paid entitlement.
//   font (Type tab)        — not in the agreed scope; add 'bannerFontFamily',
//                            'bannerFontMode', 'bannerFontEnabled', 'bannerFontWeight'
//                            and 'bannerTextAlign' to TEMPLATE_CONFIG_KEYS to include it.
//   hideBranding           — a Growth entitlement rather than a style choice.

/**
 * Reduce an arbitrary customization object to just the fields a template may carry.
 * Applied on write (so nothing unexpected is ever stored) and again on read (so rows
 * written by an older, wider version of this file can't leak content into a site).
 */
function sanitizeTemplatePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const out = {};
  for (const key of [...TEMPLATE_COLOR_FIELDS, ...TEMPLATE_LAYOUT_FIELDS]) {
    if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
  }

  const translations = {};

  const rawConfig = raw?.translations?.config;
  if (rawConfig && typeof rawConfig === 'object') {
    const config = {};
    for (const key of TEMPLATE_CONFIG_KEYS) {
      if (rawConfig[key] !== undefined && rawConfig[key] !== null) config[key] = rawConfig[key];
    }
    if (Object.keys(config).length > 0) translations.config = config;
  }

  const rawEn = raw?.translations?.en;
  if (rawEn && typeof rawEn === 'object') {
    const en = {};
    for (const key of TEMPLATE_CONTENT_KEYS) {
      if (rawEn[key] !== undefined && rawEn[key] !== null) en[key] = rawEn[key];
    }
    if (Object.keys(en).length > 0) translations.en = en;
  }

  // Only attach translations when there is something in it, so an empty object never
  // reaches the save endpoint and spreads over a site's real translations blob.
  if (Object.keys(translations).length > 0) out.translations = translations;

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Create the table on demand. Guarded and swallowed: a template feature failing to
 * initialise must never take down the request, and callers treat a missing table the
 * same as "no templates yet".
 */
async function ensureBannerTemplateTable(db) {
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS BannerTemplate (
          id             TEXT PRIMARY KEY,
          organizationId TEXT NOT NULL,
          name           TEXT NOT NULL,
          payload        TEXT NOT NULL,
          createdAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt      DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
      )
      .run();
    await db
      .prepare(
        'CREATE INDEX IF NOT EXISTS idx_bannertemplate_org ON BannerTemplate (organizationId)',
      )
      .run();
    return true;
  } catch (err) {
    console.warn('[BannerTemplates] Table init failed:', err?.message);
    return false;
  }
}

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

/**
 * Authenticate, then confirm the caller actually belongs to the organization they are
 * asking about. Without the membership check any logged-in user could read or overwrite
 * another org's templates just by passing its id.
 */
async function resolveOrganizationId(db, request, requestedOrgId) {
  const sid = getSessionIdFromCookie(request);
  if (!sid) return { error: 'Not authenticated', status: 401 };

  const session = await getSessionById(db, sid);
  if (!session) return { error: 'Not authenticated', status: 401 };

  const userId = session.userId ?? session.user_id;
  if (!userId) return { error: 'Not authenticated', status: 401 };

  const orgs = await getOrganizationsForUser(db, userId);
  if (!orgs.length) return { error: 'No organization for this user', status: 403 };

  if (requestedOrgId) {
    const match = orgs.find((o) => String(o.id) === String(requestedOrgId));
    if (!match) return { error: 'Organization not found for this user', status: 403 };
    return { organizationId: String(match.id) };
  }

  // No org supplied — fall back to the user's first (oldest) org, which is the one the
  // dashboard treats as active for single-org accounts.
  return { organizationId: String(orgs[0].id) };
}

/**
 * Overlay a template onto an existing customization row.
 *
 * The site's own row is the base and only allow-listed keys are written over it, so
 * translations.en — all banner text, plus languageSelected and the IAB flags — survives
 * untouched. That is what makes applying a template non-destructive to content, and it is
 * why this merges key-by-key instead of spreading the payload over the row.
 */
function mergeTemplateIntoCustomization(base, payload) {
  const out = { ...(base || {}) };
  if (!payload) return out;

  for (const key of [...TEMPLATE_COLOR_FIELDS, ...TEMPLATE_LAYOUT_FIELDS]) {
    if (payload[key] !== undefined && payload[key] !== null) out[key] = payload[key];
  }

  // The stored row keeps translations as a JSON string; the save endpoint expects an
  // object. Parse defensively — a malformed blob must not abort the whole apply.
  let baseTranslations = base?.translations ?? {};
  if (typeof baseTranslations === 'string') {
    try {
      baseTranslations = JSON.parse(baseTranslations);
    } catch (_) {
      baseTranslations = {};
    }
  }

  const incomingConfig = payload?.translations?.config;
  const incomingEn = payload?.translations?.en;

  if (incomingConfig || incomingEn) {
    const nextTranslations = { ...baseTranslations };

    if (incomingConfig) {
      const config = { ...(baseTranslations?.config || {}) };
      for (const key of TEMPLATE_CONFIG_KEYS) {
        if (incomingConfig[key] !== undefined && incomingConfig[key] !== null) {
          config[key] = incomingConfig[key];
        }
      }
      nextTranslations.config = config;
    }

    if (incomingEn) {
      // Key-by-key even though content is copied now: the en block also holds isIab,
      // isGoogleAc and cookiePolicyLinkEnabled, which are per-site and must survive.
      const en = { ...(baseTranslations?.en || {}) };
      for (const key of TEMPLATE_CONTENT_KEYS) {
        if (incomingEn[key] !== undefined && incomingEn[key] !== null) {
          en[key] = incomingEn[key];
        }
      }
      nextTranslations.en = en;
    }

    out.translations = nextTranslations;
  } else {
    out.translations = baseTranslations;
  }

  return out;
}

/**
 * Apply one template to a list of sites.
 *
 * Each site is written by calling handleBannerCustomization with a synthetic Request
 * rather than by touching D1 directly. That endpoint does far more than write the row —
 * Webflow KV sync, version='v2' stamping, the plan gates, script injection, PostHog — and
 * reimplementing any of it here would be a second copy free to drift from the real save.
 * This is a direct function call, not a fetch: a worker cannot fetch its own origin
 * (522 loop), but invoking the handler in-process is just a function call.
 *
 * `compliance` is deliberately never passed, because the worker only rewrites
 * banner_type/region_mode when it is present. Omitting it is what keeps the regulation
 * type per-site while colors and layout are overwritten.
 */
async function applyTemplateToSites(request, env, db, organizationId, payload, siteIds) {
  const results = [];

  for (const rawSiteId of siteIds) {
    const siteId = String(rawSiteId);

    try {
      // Ownership check per site. Without it, any authenticated user could restyle
      // another org's banners just by passing their site ids.
      const owned = await db
        .prepare('SELECT id FROM Site WHERE id = ?1 AND organizationId = ?2 LIMIT 1')
        .bind(siteId, organizationId)
        .first();
      if (!owned) {
        results.push({ siteId, ok: false, error: 'Site not found in this organization' });
        continue;
      }

      const existing = await getBannerCustomization(db, siteId);
      const merged = mergeTemplateIntoCustomization(existing, payload);

      // Carry the caller's cookies so the save path sees the same authenticated user it
      // would on a normal save from the editor.
      const synthetic = new Request(new URL('/api/banner-customization', request.url), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: request.headers.get('Cookie') || '',
        },
        body: JSON.stringify({ siteId, customization: merged }),
      });

      const res = await handleBannerCustomization(synthetic, env);
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success !== false) {
        results.push({ siteId, ok: true });
      } else {
        results.push({ siteId, ok: false, error: data?.error || `Save failed (${res.status})` });
      }
    } catch (err) {
      console.warn(`[BannerTemplates][apply] Site ${siteId} failed:`, err?.message);
      results.push({ siteId, ok: false, error: 'Save failed' });
    }
  }

  return results;
}

export async function handleBannerTemplates(request, env) {
  const db = env.CONSENT_WEBAPP;
  const url = new URL(request.url);

  // ── GET — list this org's templates ──────────────────────────────────────
  if (request.method === 'GET') {
    const auth = await resolveOrganizationId(db, request, url.searchParams.get('organizationId'));
    if (auth.error) return Response.json({ success: false, error: auth.error }, { status: auth.status });

    const ready = await ensureBannerTemplateTable(db);
    if (!ready) return Response.json({ success: true, templates: [], maxTemplates: MAX_TEMPLATES_PER_ORG });

    try {
      const { results } = await db
        .prepare(
          `SELECT id, name, payload, createdAt, updatedAt
           FROM BannerTemplate WHERE organizationId = ?1 ORDER BY createdAt ASC`,
        )
        .bind(auth.organizationId)
        .all();

      const templates = (results || []).map((row) => {
        let payload = null;
        try {
          payload = sanitizeTemplatePayload(JSON.parse(row.payload));
        } catch (_) {}
        return { id: row.id, name: row.name, payload, createdAt: row.createdAt, updatedAt: row.updatedAt };
      });

      return Response.json({ success: true, templates, maxTemplates: MAX_TEMPLATES_PER_ORG });
    } catch (err) {
      console.warn('[BannerTemplates][GET] Read failed:', err?.message);
      return Response.json({ success: true, templates: [], maxTemplates: MAX_TEMPLATES_PER_ORG });
    }
  }

  // ── POST — create a template, or overwrite an existing one ───────────────
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body) return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });

    const auth = await resolveOrganizationId(db, request, body.organizationId);
    if (auth.error) return Response.json({ success: false, error: auth.error }, { status: auth.status });

    const name = String(body.name ?? '').trim().slice(0, 60);
    if (!name) return Response.json({ success: false, error: 'name is required' }, { status: 400 });

    const payload = sanitizeTemplatePayload(body.payload);
    if (!payload) {
      return Response.json(
        { success: false, error: 'payload contains no template fields' },
        { status: 400 },
      );
    }

    // Growth gate. Unlike the hideBranding gate — which downgrades the flag and lets the
    // rest of the save through — there is nothing partial to persist here, so this
    // rejects outright.
    const allowed = await orgCanUseTemplates(db, env, auth.organizationId);
    if (allowed === false) {
      return Response.json(
        {
          success: false,
          error: 'Banner templates are available on the Growth plan.',
          code: 'TEMPLATE_PLAN_REQUIRED',
        },
        { status: 403 },
      );
    }

    const ready = await ensureBannerTemplateTable(db);
    if (!ready) {
      return Response.json({ success: false, error: 'Templates are unavailable right now' }, { status: 503 });
    }

    const now = new Date().toISOString();
    const serialized = JSON.stringify(payload);

    try {
      // Overwrite path — the id must belong to this org, so a caller can't stomp on
      // another org's row by guessing an id.
      if (body.id) {
        const existing = await db
          .prepare('SELECT id FROM BannerTemplate WHERE id = ?1 AND organizationId = ?2')
          .bind(String(body.id), auth.organizationId)
          .first();
        if (!existing) {
          return Response.json({ success: false, error: 'Template not found' }, { status: 404 });
        }
        await db
          .prepare('UPDATE BannerTemplate SET name = ?1, payload = ?2, updatedAt = ?3 WHERE id = ?4')
          .bind(name, serialized, now, String(body.id))
          .run();
        return Response.json({ success: true, id: String(body.id), name, payload });
      }

      // Create path — enforce the slot cap.
      const countRow = await db
        .prepare('SELECT COUNT(*) AS n FROM BannerTemplate WHERE organizationId = ?1')
        .bind(auth.organizationId)
        .first();
      if ((countRow?.n ?? 0) >= MAX_TEMPLATES_PER_ORG) {
        return Response.json(
          {
            success: false,
            error: `You can save up to ${MAX_TEMPLATES_PER_ORG} templates. Overwrite or delete one first.`,
            code: 'TEMPLATE_LIMIT_REACHED',
          },
          { status: 409 },
        );
      }

      const id = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO BannerTemplate (id, organizationId, name, payload, createdAt, updatedAt)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(id, auth.organizationId, name, serialized, now, now)
        .run();

      return Response.json({ success: true, id, name, payload });
    } catch (err) {
      console.warn('[BannerTemplates][POST] Write failed:', err?.message);
      return Response.json({ success: false, error: 'Failed to save template' }, { status: 500 });
    }
  }

  // ── DELETE — free a slot ─────────────────────────────────────────────────
  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ success: false, error: 'id is required' }, { status: 400 });

    const auth = await resolveOrganizationId(db, request, url.searchParams.get('organizationId'));
    if (auth.error) return Response.json({ success: false, error: auth.error }, { status: auth.status });

    try {
      await db
        .prepare('DELETE FROM BannerTemplate WHERE id = ?1 AND organizationId = ?2')
        .bind(String(id), auth.organizationId)
        .run();
      return Response.json({ success: true });
    } catch (err) {
      console.warn('[BannerTemplates][DELETE] Delete failed:', err?.message);
      return Response.json({ success: false, error: 'Failed to delete template' }, { status: 500 });
    }
  }

  return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
}
