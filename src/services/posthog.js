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
