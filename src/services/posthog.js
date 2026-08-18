import { captureGa4Event } from './ga4.js';

// Platforms a user can only arrive on by installing/logging in through a plugin.
// These are attribution facts about the person, not about a single event.
const PLUGIN_PLATFORMS = new Set(['webflow', 'framer']);

/**
 * Keep the `platform` PERSON property pinned to where the user actually came from.
 *
 * A user who installed or first logged in through the Webflow/Framer plugin keeps
 * platform=webflow/framer forever. Everything they later do through the webapp still
 * emits webapp-side events, and those events carry `$set: { platform: 'webapp' }` —
 * which used to overwrite the plugin attribution on the PostHog person.
 *
 * Rule applied here, at the single send chokepoint so every caller inherits it:
 *   • platform 'webflow' / 'framer'  → stays in `$set`      (authoritative, always wins)
 *   • platform 'webapp' / anything else → moved to `$set_once` (only fills a blank person)
 *
 * The event-level `platform` property is left untouched — that correctly describes where
 * THIS event happened, and only the person-level property is an attribution claim.
 */
function pinPlatformPersonProperty(properties = {}) {
  const set = properties.$set;
  if (!set || typeof set !== 'object') return properties;

  const platform = set.platform;
  if (platform === undefined || platform === null || platform === '') return properties;
  if (PLUGIN_PLATFORMS.has(String(platform).toLowerCase())) return properties;

  // Non-plugin platform (webapp): demote to $set_once so it never overwrites webflow/framer.
  const { platform: _demoted, ...restSet } = set;
  const next = { ...properties, $set_once: { platform, ...(properties.$set_once || {}) } };
  if (Object.keys(restSet).length > 0) next.$set = restSet;
  else delete next.$set;
  return next;
}

export async function capturePostHogEvent(env, distinctId, eventName, properties = {}) {
  properties = pinPlatformPersonProperty(properties);
  const apiKey = env.POSTHOG_API_KEY;
  // [PostHog DEBUG] temporary diagnostics — remove once tracking is confirmed.
  if (!apiKey) { console.warn(`[PostHog DEBUG] SKIP "${eventName}" — POSTHOG_API_KEY is NOT set on this env`); return; }
  if (!distinctId) { console.warn(`[PostHog DEBUG] SKIP "${eventName}" — no distinct_id (owner email did not resolve)`); return; }
  try {
    console.log(`[PostHog DEBUG] → sending "${eventName}" distinct_id=${distinctId} props=${JSON.stringify(properties)}`);
    const res = await fetch('https://us.i.posthog.com/capture/', {
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
    const bodyText = await res.text().catch(() => '');
    console.log(`[PostHog DEBUG] ← "${eventName}" HTTP ${res.status} ${bodyText}`);
  } catch (e) {
    console.warn(`[PostHog DEBUG] capture FAILED for "${eventName}":`, e?.message);
  }
}

export async function identifyPostHogPerson(env, distinctId, properties = {}) {
  return capturePostHogEvent(env, distinctId, '$identify', { $set: properties });
}

// Step 7 — fires installation_verified once, when the ConsentBit tag is first detected
// live on a site's domain (manual verify or the scheduled scan cron). Keyed by the owner's
// email so it merges into the same person as the client-side funnel events.
export async function captureInstallationVerified(env, db, siteId, domain) {
  // GA4 can be enabled independently of PostHog, so only bail when neither is configured.
  if ((!env.POSTHOG_API_KEY && !env.GA4_API_SECRET) || !siteId || !db) return;
  try {
    const row = await db.prepare(
      `SELECT u.email AS email, s.platform AS platform FROM User u
         JOIN OrganizationMember om ON om.userId = u.id
         JOIN Site s ON s.organizationId = om.organizationId
        WHERE s.id = ?1 LIMIT 1`
    ).bind(siteId).first();
    const email = row?.email || null;
    if (!email) return;
    // Site.platform is the plugin attribution ('webflow'/'framer'); null means webapp.
    const platform = row?.platform || 'webapp';
    await capturePostHogEvent(env, email, 'installation_verified', {
      site_id: String(siteId),
      domain: domain || null,
      source: 'backend_detect',
      $groups: { site: String(siteId) },
    });
    await captureGa4Event(env, email, 'installation_verified', {
      site_id: String(siteId),
      domain: domain || null,
      source: 'backend_detect',
      platform,
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
