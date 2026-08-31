// src/handlers/authPublicKey.js
import { getPublicJwk } from '../utils/authCrypto.js';

/**
 * Hand the browser the RSA public key it uses to encrypt password fields.
 *
 * Public by design — a public key is not a secret, and this has to be reachable before
 * anyone is signed in. When encryption is not configured the response says so plainly
 * (`enabled: false`) and the client falls back to sending plaintext over HTTPS.
 */
export async function handleAuthPublicKey(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  const jwk = getPublicJwk(env);
  if (!jwk) {
    return Response.json({ success: true, enabled: false }, { status: 200 });
  }

  return Response.json(
    { success: true, enabled: true, alg: 'RSA-OAEP-256', publicKey: jwk },
    {
      status: 200,
      // Deliberately NOT cached. This was max-age=300, which meant a browser could keep
      // encrypting with a key the server no longer had — after a key rotation, or after
      // the same URL was repointed at a different worker — and every sign-in failed hard
      // for the life of the cache entry. The response is a few hundred bytes once per
      // page load; correctness is worth far more than that here.
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
