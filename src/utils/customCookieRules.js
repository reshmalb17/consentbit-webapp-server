/**
 * Published CustomCookieRule matching shared by scanSite (browser/fetch) and scanCookies (client POST).
 */

/** Lowercase, trim, strip leading dot, strip leading www. for host comparison */
export function normCookieHost(d) {
  if (d == null) return '';
  let s = String(d).trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('.')) s = s.slice(1);
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

/**
 * Hostnames to match rules when a cookie has no domain attribute — derived from Site.domain (URL or bare host).
 */
export function hostHintsFromSiteDomain(siteDomain) {
  if (siteDomain == null) return [];
  const raw = String(siteDomain).trim();
  if (!raw) return [];
  try {
    if (/^https?:\/\//i.test(raw)) {
      const h = new URL(raw).hostname;
      return h ? [h] : [];
    }
  } catch {
    /* fall through */
  }
  const host = raw
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .trim();
  return host ? [host] : [];
}

function normalizeCustomRuleRow(r) {
  if (!r || typeof r !== 'object') return null;
  const name = r.name ?? r.NAME;
  const domain = r.domain ?? r.DOMAIN ?? '';
  const category = r.category ?? r.CATEGORY ?? 'uncategorized';
  const provider = r.provider ?? r.PROVIDER ?? null;
  const description = r.description ?? r.DESCRIPTION ?? null;
  const scriptUrlPattern = r.scriptUrlPattern ?? r.scripturlpattern ?? null;
  if (name == null || String(name).trim() === '') return null;
  return {
    name: String(name).trim(),
    domain: String(domain ?? '').trim(),
    scriptUrlPattern,
    category: String(category || 'uncategorized').trim(),
    provider: provider ? String(provider).trim() : null,
    description,
  };
}

/** Ensure table exists before SELECT (GET /cookies may run before any rule was saved). */
export async function ensureCustomCookieRuleTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS CustomCookieRule (
        id TEXT PRIMARY KEY,
        siteId TEXT NOT NULL,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        scriptUrlPattern TEXT,
        category TEXT NOT NULL DEFAULT 'uncategorized',
        description TEXT,
        duration TEXT,
        published INTEGER NOT NULL DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (siteId) REFERENCES Site(id) ON DELETE CASCADE,
        UNIQUE(siteId, name, domain)
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ccr_site_name_domain ON CustomCookieRule(siteId, name, domain)`,
    )
    .run();
}

/**
 * Match a cookie name + domain against published CustomCookieRule rows (in-memory).
 * @param siteHints - hostnames from the site record (when cookie domain is empty, rules can still match the site host).
 */
export function matchPublishedCustomRule(customRules, name, domain, siteHints = []) {
  if (!customRules?.length || !name) return null;
  const nameLow = String(name).toLowerCase().trim();
  const cookieHost = normCookieHost(domain);
  const hintHosts = new Set((siteHints || []).map((h) => normCookieHost(h)).filter(Boolean));

  const candidates = customRules.filter(
    (r) => r && r.name && String(r.name).toLowerCase().trim() === nameLow,
  );
  if (!candidates.length) return null;

  const scored = [];
  for (const r of candidates) {
    const ruleDomRaw = String(r.domain ?? '').trim();
    const ruleHost = normCookieHost(ruleDomRaw);
    if (!ruleHost) {
      scored.push({ r, score: 1 });
      continue;
    }

    const hostsToCheck = new Set();
    if (cookieHost) hostsToCheck.add(cookieHost);
    for (const h of hintHosts) hostsToCheck.add(h);

    let subScore = 0;
    for (const host of hostsToCheck) {
      if (!host) continue;
      if (host === ruleHost) subScore = Math.max(subScore, 4);
      else if (host.endsWith('.' + ruleHost)) subScore = Math.max(subScore, 3);
    }
    if (subScore > 0) scored.push({ r, score: subScore });
  }

  if (scored.length) {
    scored.sort((a, b) => b.score - a.score);
    const x = scored[0].r;
    return {
      category: x.category,
      provider: x.domain,
      description: x.description,
    };
  }

  const wild = candidates.find((r) => !String(r.domain ?? '').trim());
  if (wild) {
    return {
      category: wild.category,
      provider: wild.domain || null,
      description: wild.description,
    };
  }
  return null;
}

/**
 * Merge published CustomCookieRule into cookie rows for API responses (list + grouping).
 */
export function applyPublishedRulesToCookieRows(customRules, cookies, siteHints = []) {
  if (!cookies?.length) return cookies || [];
  if (!customRules?.length) return cookies;
  return cookies.map((c) => {
    const m = matchPublishedCustomRule(customRules, c.name, c.domain, siteHints);
    if (!m) return c;
    const category = String(m.category || c.category || 'uncategorized')
      .toLowerCase()
      .trim();
    const provider =
      m.provider != null && String(m.provider).trim() !== '' ? m.provider : c.provider;
    return {
      ...c,
      category,
      provider,
      description: m.description != null ? m.description : c.description,
    };
  });
}

export async function loadPublishedCustomCookieRules(db, siteId) {
  if (!siteId) return [];
  try {
    await ensureCustomCookieRuleTable(db);
    const { results } = await db
      .prepare(
        `SELECT name, domain, scriptUrlPattern, category, provider, description
         FROM CustomCookieRule
         WHERE siteId = ?1 AND COALESCE(published, 0) = 1`,
      )
      .bind(siteId)
      .all();
    return (results || []).map(normalizeCustomRuleRow).filter(Boolean);
  } catch (e) {
    console.error('[customCookieRules] loadPublishedCustomCookieRules:', e?.message || e);
    return [];
  }
}

/**
 * CustomCookieRule first, then legacy Cookie rows with isExpected = 1.
 */
export async function resolveUserDefinedCookieRule(db, siteId, name, domain, customRules, siteHints = []) {
  if (!siteId || !name) return null;

  const fromCustom = matchPublishedCustomRule(customRules, name, domain, siteHints);
  if (fromCustom) return fromCustom;

  const domLow = domain ? String(domain).trim().toLowerCase() : '';

  const exact = await db
    .prepare(
      `SELECT category, provider, description
       FROM Cookie
       WHERE siteId = ?1
         AND isExpected = 1
         AND lower(name) = lower(?2)
         AND lower(domain) = lower(?3)
       ORDER BY lastSeenAt DESC
       LIMIT 1`,
    )
    .bind(siteId, name, domLow)
    .first();
  if (exact) return exact;

  const fallback = await db
    .prepare(
      `SELECT category, provider, description
       FROM Cookie
       WHERE siteId = ?1
         AND isExpected = 1
         AND lower(name) = lower(?2)
         AND trim(domain) = ''
       ORDER BY lastSeenAt DESC
       LIMIT 1`,
    )
    .bind(siteId, name)
    .first();
  return fallback || null;
}
