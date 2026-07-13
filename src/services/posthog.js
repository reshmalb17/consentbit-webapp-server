export async function capturePostHogEvent(env, distinctId, eventName, properties = {}) {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey) return;
  if (!distinctId) return;
  try {
    await fetch('https://us.i.posthog.com/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: eventName,
        distinct_id: String(distinctId),
        properties,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn('[PostHog] capture failed:', e?.message);
  }
}

export async function identifyPostHogPerson(env, distinctId, properties = {}) {
  return capturePostHogEvent(env, distinctId, '$identify', { $set: properties });
}

// Step 7 — fires installation_verified once, when the ConsentBit tag is first detected
// live on a site's domain (manual verify or the scheduled scan cron). Keyed by the owner's
// email so it merges into the same person as the client-side funnel events.
export async function captureInstallationVerified(env, db, siteId, domain) {
  if (!env.POSTHOG_API_KEY || !siteId || !db) return;
  try {
    const row = await db.prepare(
      `SELECT u.email AS email FROM User u
         JOIN OrganizationMember om ON om.userId = u.id
         JOIN Site s ON s.organizationId = om.organizationId
        WHERE s.id = ?1 LIMIT 1`
    ).bind(siteId).first();
    const email = row?.email || null;
    if (!email) return;
    await capturePostHogEvent(env, email, 'installation_verified', {
      site_id: String(siteId),
      domain: domain || null,
      source: 'backend_detect',
      $groups: { site: String(siteId) },
    });
  } catch (e) {
    console.warn('[PostHog] installation_verified failed:', e?.message);
  }
}

// Identify a site group — one row per site regardless of how many users own it
export async function identifyPostHogSite(env, distinctId, siteId, groupProperties = {}) {
  const apiKey = env.POSTHOG_API_KEY;
  if (!apiKey || !siteId) return;
  try {
    await fetch('https://us.i.posthog.com/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: '$groupidentify',
        distinct_id: String(distinctId),
        properties: {
          $group_type: 'site',
          $group_key: String(siteId),
          $group_set: groupProperties,
        },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn('[PostHog] group identify failed:', e?.message);
  }
}
