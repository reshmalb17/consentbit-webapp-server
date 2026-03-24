// src/handlers/onboardingFirstSetup.js
import {
  getSessionById,
  getUserById,
  getOrCreateOrganizationForUser,
  createSite,
  canonicalEmbedOrigin,
  buildEmbedScriptUrl,
} from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleOnboardingFirstSetup(request, env) {
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

  // Use websiteUrl as domain, and generate a clean name from it
  const domain = websiteUrl;
  // Generate site name from URL (remove protocol, www, etc.)
  // Keep the full domain/subdomain as the name (e.g., "valuable-tenets-951054.framer.app")
  const siteName = websiteUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  const defaultOrgName = organizationName || (user?.name ? `${user.name}'s Organization` : 'My Organization');
  const org = await getOrCreateOrganizationForUser(db, { userId: user.id, organizationName: defaultOrgName });
  if (!org?.id) {
    return Response.json({ success: false, error: 'Failed to initialize organization' }, { status: 500 });
  }

  const embedOrigin = canonicalEmbedOrigin(request, env);
  const site = await createSite(db, {
    organizationId: org.id,
    name: siteName,
    domain,
    origin: embedOrigin || new URL(request.url).origin,
    bannerType: 'gdpr',
    // Default: GDPR only until user customizes
    regionMode: 'gdpr',
  });

  // Same absolute URL forever (Site.embedScriptUrl); fallback for legacy code paths
  const scriptUrl =
    site.embedScriptUrl ||
    buildEmbedScriptUrl(embedOrigin || new URL(request.url).origin, site.cdnScriptId) ||
    `${new URL(request.url).origin}/consentbit/${site.cdnScriptId}/script.js`;
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
