// src/handlers/onboardingFirstSetup.js
import {
  getSessionById,
  getUserById,
  getOrCreateOrganizationForUser,
  createSite,
  canonicalEmbedOrigin,
  buildEmbedScriptUrl,
  normalizeDomain,
} from '../services/db.js';
import { sendFreePlanEmail } from '../services/email.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleOnboardingFirstSetup(request, env, ctx) {
  const db = env.CONSENT_WEBAPP;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
 

  const sid = getSessionIdFromCookie(request);
  
  if (!sid) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const session = await getSessionById(db, sid);
  if (!session) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  const userId = session.userId ?? session.user_id;
  const user = await getUserById(db, userId);
  if (!user) {
    return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const organizationName = (body.organizationName || '').trim();
  const websiteUrl = (body.websiteUrl || '').trim();

  if (!websiteUrl) {
    return Response.json(
      { success: false, error: 'websiteUrl is required' },
      { status: 400 },
    );
  }

  const domain = normalizeDomain(websiteUrl);
  const siteName = domain || websiteUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  const defaultOrgName = organizationName || (user?.name ? `${user.name}'s Organization` : 'My Organization');
  const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: defaultOrgName });
  if (!org?.id) {
    return Response.json({ success: false, error: 'Failed to initialize organization' }, { status: 500 });
  }

  const embedOrigin = canonicalEmbedOrigin(request, env);
  let site;
  try {
    site = await createSite(db, {
      organizationId: org.id,
      name: siteName,
      domain,
      origin: embedOrigin || new URL(request.url).origin,
      bannerType: 'gdpr',
      // Default: GDPR only until user customizes
      regionMode: 'gdpr',
    });
  } catch (e) {
    if (e?.code === 'DOMAIN_EXISTS' || e?.status === 409) {
      // The domain is owned by a different org — check if this user is a member of that org.
      // This can happen when the setup flow is retried or there is a race condition that
      // created two organizations for the same user.
      const existingSite = await db
        .prepare('SELECT * FROM Site WHERE domain = ?1')
        .bind(domain)
        .first();
      if (existingSite?.organizationId) {
        const membership = await db
          .prepare(
            'SELECT 1 FROM OrganizationMember WHERE organizationId = ?1 AND userId = ?2 LIMIT 1',
          )
          .bind(existingSite.organizationId, user.id)
          .first();
        if (membership) {
          // User owns this site — return it as a successful setup response.
          const resolvedOrigin = embedOrigin || new URL(request.url).origin;
          const scriptUrl =
            existingSite.embedScriptUrl ||
            buildEmbedScriptUrl(resolvedOrigin, existingSite.cdnScriptId) ||
            `${resolvedOrigin}/consentbit/${existingSite.cdnScriptId}/script.js`;
          return Response.json(
            {
              success: true,
              organization: org,
              organizationId: existingSite.organizationId,
              site: existingSite,
              scriptUrl,
            },
            { status: 200 },
          );
        }
      }
      return Response.json(
        { success: false, error: 'This domain already exists. Please open it from your dashboard instead.', code: 'DOMAIN_EXISTS' },
        { status: 409 },
      );
    }
    throw e;
  }

  // Same absolute URL forever (Site.embedScriptUrl); fallback for legacy code paths
  const scriptUrl =
    site.embedScriptUrl ||
    buildEmbedScriptUrl(embedOrigin || new URL(request.url).origin, site.cdnScriptId) ||
    `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;

  // Send free-plan confirmation email in the background
  sendFreePlanEmail(env, ctx, {
    to:        user.email,
    name:      user.name || '',
    domain:    site.domain,
    scriptUrl,
  });

  return Response.json(
    {
      success: true,
      organization: org,
      organizationId: org.id,
      site,
      scriptUrl,
    },
    { status: 200 }
  );
}
