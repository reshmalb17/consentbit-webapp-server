// src/utils/cors.js

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://dev-4s-dandy-site-102239.webflow.io',
  // later: add your production domain(s) here
];

function getCorsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true'; // <- required for cookies
  }

  return headers;
}

// src/utils/cors.js
export function withCors(response, request) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers); // keep Set-Cookie

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// For public API endpoints that can be called from any origin (e.g., from CDN scripts)
export function withPublicCors(response, request) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(response.headers);

  // Allow any origin for public endpoints
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

export function handleOptions(request) {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);
  const headers = new Headers();

  // Public endpoints (consent, scan-scripts, scan-cookies, pageview) allow any origin
  const isPublicEndpoint =
    url.pathname === '/api/consent' ||
    url.pathname === '/api/scan-scripts' ||
    url.pathname === '/api/scan-cookies' ||
    url.pathname === '/api/pageview';

  if (origin) {
    if (isPublicEndpoint || ALLOWED_ORIGINS.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      if (!isPublicEndpoint) {
        headers.set('Access-Control-Allow-Credentials', 'true');
      }
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
  }

  return new Response(null, { status: 204, headers });
}
