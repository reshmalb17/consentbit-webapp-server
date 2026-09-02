// src/utils/authCrypto.js
//
// Application-layer encryption for password fields, layered on top of TLS.
//
// Flow: the browser GETs /api/auth/public-key, encrypts the password with RSA-OAEP
// (SHA-256) and sends base64 in a `*Enc` field instead of the plaintext one. Only this
// worker holds the private half, as the AUTH_RSA_PRIVATE_JWK secret. The decrypted
// password is then hashed with PBKDF2 exactly as before — this layer changes what
// travels in the request body, not how credentials are stored.
//
// ROLLOUT SAFETY: with the secret unset, getPublicJwk() reports disabled, the client
// falls back to sending plaintext, and resolvePasswordField() passes that through. So
// deploying this before setting the secret changes nothing and breaks nothing.
//
// KEY ROTATION: replace the secret and every browser picks the new public key up on its
// next load. In-flight page sessions holding the old key get a decrypt failure, which
// surfaces as "reload and try again" rather than "invalid credentials".

/** Distinguishes a ciphertext problem from a wrong password, so handlers can say so. */
export class AuthCryptoError extends Error {}

let cachedKey = null;
let cachedRaw = null;

function readJwk(env) {
  const raw = env && env.AUTH_RSA_PRIVATE_JWK;
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[AuthCrypto] AUTH_RSA_PRIVATE_JWK is not valid JSON');
    return null;
  }
}

async function getPrivateKey(env) {
  const raw = env && env.AUTH_RSA_PRIVATE_JWK;
  if (!raw) return null;
  // Import is not free, and a worker isolate serves many requests — cache per key value
  // so rotation still takes effect without a redeploy.
  if (cachedKey && cachedRaw === raw) return cachedKey;
  const jwk = readJwk(env);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
  cachedKey = key;
  cachedRaw = raw;
  return key;
}

/**
 * The public half, safe to hand to any browser. Built by whitelisting the public JWK
 * fields — never by deleting the private ones, so a future JWK field cannot leak by
 * being forgotten here. Returns null when encryption is not configured.
 */
export function getPublicJwk(env) {
  const jwk = readJwk(env);
  if (!jwk || !jwk.n || !jwk.e) return null;
  return {
    kty: jwk.kty || 'RSA',
    n: jwk.n,
    e: jwk.e,
    alg: 'RSA-OAEP-256',
    ext: true,
    key_ops: ['encrypt'],
  };
}

export function isAuthCryptoConfigured(env) {
  return getPublicJwk(env) !== null;
}

/**
 * Resolve one password field from a request body, accepting either the encrypted form
 * or the plaintext one. Throws AuthCryptoError when ciphertext is present but unusable,
 * so a key mismatch is never reported to the user as a wrong password.
 */
export async function resolvePasswordField(env, { enc, plain } = {}) {
  if (typeof enc === 'string' && enc.length > 0) {
    const key = await getPrivateKey(env);
    if (!key) {
      throw new AuthCryptoError('Password encryption is not configured on this server.');
    }
    let bytes;
    try {
      const bin = atob(enc);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      throw new AuthCryptoError('Malformed encrypted password.');
    }
    let buf;
    try {
      buf = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, bytes);
    } catch (e) {
      throw new AuthCryptoError(
        'Could not decrypt the password. The page may be holding an old key — reload and try again.',
      );
    }
    return { password: new TextDecoder().decode(buf), encrypted: true };
  }
  return { password: typeof plain === 'string' ? plain : '', encrypted: false };
}
