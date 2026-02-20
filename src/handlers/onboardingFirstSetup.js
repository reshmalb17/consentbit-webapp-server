// src/handlers/onboardingFirstSetup.js
import {
  getSessionById,
  getUserById,
  createOrganization,
  addOrganizationMember,
  createSite,
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

  if (!organizationName || !websiteUrl) {
    return Response.json(
      { success: false, error: 'organizationName and websiteUrl are required' },
      { status: 400 },
    );
  }

  // Use websiteUrl as domain, and generate a clean name from it
  const domain = websiteUrl;
  // Generate site name from URL (remove protocol, www, etc.)
  // Keep the full domain/subdomain as the name (e.g., "valuable-tenets-951054.framer.app")
  const siteName = websiteUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

  const org = await createOrganization(db, {
    ownerUserId: user.id,
    name: organizationName,
  });

  await addOrganizationMember(db, {
    organizationId: org.id,
    userId: user.id,
    role: 'owner',
  });

  const url = new URL(request.url);
  const site = await createSite(db, {
    organizationId: org.id,
    name: siteName,
    domain,
    origin: url.origin,
    bannerType: 'gdpr',
    regionMode: 'gdpr',
  });

  return Response.json(
    {
      success: true,
      organization: org,
      site,
    },
    { status: 200 }
  );
}
