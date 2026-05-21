const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ALLOWED_KEYS = ['email', 'domain', 'platform', 'platformId', 'billingEmail'];

export async function handleCheckoutToken(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const kv = env.CHECKOUT_TOKENS;

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      console.log('[checkout-token] POST: invalid JSON');
      return Response.json({ error: 'invalid JSON' }, { status: 400, headers: CORS_HEADERS });
    }

    const payload = {};
    for (const key of ALLOWED_KEYS) {
      if (body[key] && typeof body[key] === 'string') payload[key] = body[key];
    }

    const token = crypto.randomUUID();
    await kv.put(`checkout-token:${token}`, JSON.stringify(payload), { expirationTtl: 600 });
    console.log('[checkout-token] POST: stored token', token, 'keys:', Object.keys(payload));

    return Response.json({ token }, { headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const token = url.searchParams.get('t');
    console.log('[checkout-token] GET: token param =', token);
    if (!token) {
      return Response.json({ error: 'missing token' }, { status: 400, headers: CORS_HEADERS });
    }

    const raw = await kv.get(`checkout-token:${token}`);
    console.log('[checkout-token] GET: KV lookup =', raw ? 'found' : 'not found / expired');
    if (!raw) {
      return Response.json({ error: 'expired' }, { status: 404, headers: CORS_HEADERS });
    }

    await kv.delete(`checkout-token:${token}`);
    console.log('[checkout-token] GET: returning payload, keys:', Object.keys(JSON.parse(raw)));

    return Response.json(JSON.parse(raw), { headers: CORS_HEADERS });
  }

  return Response.json({ error: 'method not allowed' }, { status: 405, headers: CORS_HEADERS });
}
