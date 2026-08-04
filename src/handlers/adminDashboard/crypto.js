// src/handlers/adminDashboard/crypto.js
//
// Password hashing and single-use link tokens for the Admin Dashboard.
//
// Nothing reversible is ever written to the database: account keys are stored as
// salted PBKDF2-SHA256 digests, and invite / reset links are stored as SHA-256
// digests of the token that was emailed. Reading the table gives an attacker
// neither a working login nor a usable link.

const enc = new TextEncoder();

const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time comparison of two hex strings. */
export function ctEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(secret, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Hash an account key for storage.
 * Returns `pbkdf2$<iterations>$<saltHex>$<hashHex>` — self-describing, so the cost
 * can be raised later without invalidating existing hashes.
 */
export async function hashSecret(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(String(secret), salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

/**
 * Check a supplied key against a stored hash.
 * Returns false for anything unparseable rather than throwing.
 */
export async function verifySecret(stored, supplied) {
  if (typeof stored !== 'string' || !stored || !supplied) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;
  try {
    const hash = await pbkdf2(String(supplied), hexToBytes(parts[2]), iterations);
    return ctEq(bytesToHex(hash), parts[3]);
  } catch (_) {
    return false;
  }
}

/** True when a stored value is already a PBKDF2 digest (vs. a legacy plaintext key). */
export function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('pbkdf2$');
}

/**
 * Mint a single-use link token.
 * The caller emails `token` and stores only `tokenHash`.
 */
export async function createToken() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(raw);
  return { token, tokenHash: await sha256Hex(token) };
}

export async function sha256Hex(value) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(value)));
  return bytesToHex(new Uint8Array(buf));
}
