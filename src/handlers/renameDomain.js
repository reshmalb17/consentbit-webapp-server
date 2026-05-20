// src/handlers/renameDomain.js
// POST /api/sites/rename-domain
//
// Body: { websiteUrl, excludeSiteId }   ← same shape as /api/sites/check-domain
//
// Flow:
//   1. Auth + ownership check (excludeSiteId must belong to the caller's org).
//   2. Run the same domain-conflict checks as checkDomainAvailability.
//   3. If no conflict: fetch the live HTML at the new domain and detect platform.
//        - Webflow: <html ... data-wf-site="..."> → platform='webflow', platformSiteId=data-wf-site
//        - Framer:  <script src="https://events.framer.com/script..." data-fid="..."> → platform='framer', platformSiteId=data-fid
//        - Otherwise (HTML fetched but no marker): platform='' and platformSiteId=''
//        - HTML fetch failed (network error / blocked): leave existing platform fields untouched
//   4. UPDATE Site with the new domain (and platform fields when detection ran).

import {
  ensureSchema,
  getSessionById,
  getUserById,
  getSubscriptionByOrganization,
  getOrganizationsForUser,
  normalizeDomain,
  getSiteById,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

function isActiveSubscription(sub) {
  const status = sub ? String(sub.status || '').toLowerCase() : '';
  return status === 'active' || status === 'trialing';
}

async function fetchSiteHtml(domain) {
  const candidates = [`https://${domain}`, `http://${domain}`];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!resp.ok) continue;
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('text/html') && !ct.includes('text/plain') && ct !== '') continue;
      return await resp.text();
    } catch (_) {
      // try next candidate
    }
  }
  return '';
}

function detectOldScript(html) {
  if (!html) return false;
  const scriptTagRe = /<script\b[^>]*>/gi;
  let m;
  while ((m = scriptTagRe.exec(html)) !== null) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const src = srcMatch[1].trim();
    if (/(^|\/\/)api\.consentbit\.com\/consent\.js(\?|$|["'])/i.test(src)) return true;
    if (/(^|\/\/)api\.consentbit\.com\/consentbit\.js(\?|$|["'])/i.test(src)) return true;
    if (/(^|\/\/)consentbit-public\.pages\.dev\/consentbit\.js(\?|$|["'])/i.test(src)) return true;
  }
  return false;
}

function detectPlatform(html) {
  if (!html) return { platform: '', platformSiteId: '' };

  // Webflow: opening <html> tag carries data-wf-site
  const htmlOpen = html.match(/<html\b[^>]*>/i);
  if (htmlOpen) {
    const wf = htmlOpen[0].match(/\bdata-wf-site\s*=\s*["']([^"']+)["']/i);
    if (wf && wf[1]) {
      return { platform: 'webflow', platformSiteId: wf[1].trim() };
    }
  }

  // Framer: script tag pointing to events.framer.com/script with data-fid="..."
  // Attribute order can vary, so find the framer script tag, then pull data-fid out of it.
  const scriptTagRe = /<script\b[^>]*>/gi;
  let m;
  while ((m = scriptTagRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/events\.framer\.com\/script/i.test(tag)) continue;
    const fid = tag.match(/\bdata-fid\s*=\s*["']([^"']+)["']/i);
    if (fid && fid[1]) {
      return { platform: 'framer', platformSiteId: fid[1].trim() };
    }
  }

  return { platform: '', platformSiteId: '' };
}

export async function handleRenameDomain(request, env) {
  const db = env.CONSENT_WEBAPP;
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const sid = getSessionIdFromCookie(request);
  if (!sid) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const [session, body] = await Promise.all([
    getSessionById(db, sid),
    request.json().catch(() => null),
  ]);
  if (!session) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (!body) {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const websiteUrl = String(body.websiteUrl || '').trim();
  const domain = normalizeDomain(websiteUrl);
  if (!domain) {
    return Response.json({ success: false, error: 'websiteUrl is required' }, { status: 400 });
  }

  const excludeSiteId = String(body.excludeSiteId ?? '').trim() || null;
  if (!excludeSiteId) {
    return Response.json(
      { success: false, error: 'excludeSiteId is required (the site to rename)' },
      { status: 400 },
    );
  }

  await ensureSchema(db);

  // Ownership: the target site must belong to one of the caller's orgs.
  const targetSite = await getSiteById(db, excludeSiteId);
  if (!targetSite) {
    console.warn('[RenameDomain] site not found', { excludeSiteId, userId: user.id });
    return Response.json({ success: false, error: 'Site not found' }, { status: 404 });
  }
  const userOrgs = await getOrganizationsForUser(db, user.id);
  const allowedOrgIds = new Set(userOrgs.map((o) => String(o.id ?? o.ID ?? '')).filter(Boolean));
  const targetOrgId = String(targetSite.organizationId ?? targetSite.organizationid ?? targetSite.ORGANIZATIONID ?? '');
  if (!targetOrgId || !allowedOrgIds.has(targetOrgId)) {
    console.warn('[RenameDomain] forbidden — ownership check failed', {
      excludeSiteId,
      userId: user.id,
      targetOrgId: targetOrgId || '(empty)',
      allowedOrgIds: [...allowedOrgIds],
      userOrgsCount: userOrgs.length,
      targetSiteKeys: Object.keys(targetSite || {}),
    });
    return Response.json({
      success: false,
      error: 'Forbidden',
      message: 'You do not have permission to rename this site.',
      debug: {
        targetOrgId: targetOrgId || null,
        userOrgCount: userOrgs.length,
      },
    }, { status: 403 });
  }

  // Conflict check — same logic as checkDomainAvailability, scoped to "another site owns this domain".
  const existingSite = await db
    .prepare(
      `SELECT id, organizationId, domain FROM Site WHERE LOWER(domain) = LOWER(?1) LIMIT 1`,
    )
    .bind(domain)
    .first();

  if (existingSite && String(existingSite.id) !== excludeSiteId) {
    const holderOrgId = String(existingSite.organizationId ?? existingSite.organizationid ?? '');
    const sameAccount = holderOrgId && allowedOrgIds.has(holderOrgId);

    let holderSub = null;
    try {
      holderSub = holderOrgId ? await getSubscriptionByOrganization(db, holderOrgId) : null;
    } catch {
      holderSub = null;
    }
    const holderActive = isActiveSubscription(holderSub);

    if (!sameAccount && holderActive) {
      return Response.json(
        {
          success: false,
          available: false,
          domain,
          code: 'DOMAIN_IN_USE_ACTIVE',
          message: 'This domain is already in use by another account.',
        },
        { status: 200 },
      );
    }

    return Response.json(
      {
        success: false,
        available: false,
        domain,
        code: sameAccount ? 'DOMAIN_IN_USE_SAME_ACCOUNT' : 'DOMAIN_IN_USE_OTHER_ACCOUNT',
        message: sameAccount
          ? 'This website URL is already used by another site in your account.'
          : 'This website URL is already registered to another ConsentBit account.',
      },
      { status: 200 },
    );
  }
//commit
  // Conflict-free. Detect platform from the live HTML.
  const html = await fetchSiteHtml(domain);
  const detection = html ? detectPlatform(html) : null;
  const isOldScript = html ? detectOldScript(html) : false;

  // Always update domain + updatedAt. Update platform fields only when we actually fetched HTML
  // — a transient fetch failure shouldn't wipe valid existing platform data.
  const sets = ['domain = ?1', 'updatedAt = ?2'];
  const binds = [domain, new Date().toISOString()];
  if (detection) {
    sets.push(`platform = ?${binds.length + 1}`);
    binds.push(detection.platform);
    sets.push(`platformSiteId = ?${binds.length + 1}`);
    binds.push(detection.platformSiteId);
  }
  binds.push(excludeSiteId);
  await db
    .prepare(`UPDATE Site SET ${sets.join(', ')} WHERE id = ?${binds.length}`)
    .bind(...binds)
    .run();

  return Response.json(
    {
      success: true,
      available: true,
      domain,
      platform: detection ? detection.platform : (targetSite.platform ?? ''),
      platformSiteId: detection ? detection.platformSiteId : (targetSite.platformSiteId ?? targetSite.platformsiteid ?? ''),
      detected: !!detection,
      code: detection
        ? (detection.platform ? 'PLATFORM_DETECTED' : 'PLATFORM_UNKNOWN')
        : 'PLATFORM_FETCH_FAILED',
      isOldScript,
    },
    { status: 200 },
  );
}
