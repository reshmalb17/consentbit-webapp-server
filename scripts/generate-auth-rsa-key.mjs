#!/usr/bin/env node
/**
 * Generate the RSA key pair used for password-field encryption.
 *
 *   node scripts/generate-auth-rsa-key.mjs
 *
 * Prints two things:
 *   1. the PRIVATE JWK  -> the worker secret AUTH_RSA_PRIVATE_JWK
 *   2. the PUBLIC JWK   -> the webapp build var NEXT_PUBLIC_AUTH_RSA_PUBLIC_JWK
 *
 * The parameters must match utils/authCrypto.js exactly: RSA-OAEP with SHA-256, which is
 * what the worker imports the private half as and what the browser imports the public
 * half as. A key generated for any other algorithm will import fine and then fail to
 * decrypt, which surfaces as "Could not decrypt the password" rather than an obvious
 * configuration error.
 *
 * SECRETS ARE WRITE-ONLY on Cloudflare: once `wrangler secret put` has taken this value
 * you cannot read it back. If you want the same key on more than one worker script, keep
 * this output somewhere safe (a password manager) at generation time. Otherwise just
 * generate a separate pair per script — they are independent, and each environment's
 * webapp build simply needs the matching public half.
 *
 * Each worker script has its OWN secrets. `consent-webapp-manager` and
 * `consent-webapp-manager-production` are two scripts, so setting the secret on one does
 * nothing for the other.
 */

import { webcrypto } from 'node:crypto';

const MODULUS_BITS = 2048;

const pair = await webcrypto.subtle.generateKey(
  {
    name: 'RSA-OAEP',
    modulusLength: MODULUS_BITS,
    // 65537, the standard public exponent.
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: 'SHA-256',
  },
  true, // extractable — the whole point is to export both halves
  ['encrypt', 'decrypt'],
);

const privateJwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const rawPublicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);

// Match what the worker's getPublicJwk() hands to browsers, so what you paste into the
// build var is byte-for-byte what the endpoint would have returned.
const publicJwk = {
  kty: rawPublicJwk.kty,
  n: rawPublicJwk.n,
  e: rawPublicJwk.e,
  alg: 'RSA-OAEP-256',
  ext: true,
  key_ops: ['encrypt'],
};

// Prove the pair actually round-trips before anyone puts it into a secret. A key that
// only fails at login time is a miserable thing to debug.
const probe = 'round-trip probe';
const ciphertext = await webcrypto.subtle.encrypt(
  { name: 'RSA-OAEP' },
  await webcrypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']),
  new TextEncoder().encode(probe),
);
const decrypted = new TextDecoder().decode(
  await webcrypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    await webcrypto.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']),
    ciphertext,
  ),
);
if (decrypted !== probe) {
  console.error('FAILED: generated pair did not round-trip. Do not use it.');
  process.exit(1);
}

const line = '='.repeat(78);

console.log(`\n${line}`);
console.log(`RSA-OAEP-256 / ${MODULUS_BITS}-bit — round-trip verified`);
console.log(line);

console.log('\n1. WORKER SECRET — AUTH_RSA_PRIVATE_JWK');
console.log('   Set it with (add --env production for the production script):\n');
console.log('     npx wrangler secret put AUTH_RSA_PRIVATE_JWK\n');
console.log('   Paste this single line when prompted:\n');
console.log(JSON.stringify(privateJwk));

console.log('\n2. WEBAPP BUILD VAR — NEXT_PUBLIC_AUTH_RSA_PUBLIC_JWK');
console.log('   Put this in consentbitwebapp/.env.local, and in the Pages project vars');
console.log('   for whichever environment talks to the worker above:\n');
console.log(`NEXT_PUBLIC_AUTH_RSA_PUBLIC_JWK=${JSON.stringify(publicJwk)}`);

console.log(`\n${line}`);
console.log('The PRIVATE half is a credential. Do not commit it, paste it into a ticket,');
console.log('or leave it in shell history. The PUBLIC half is safe to ship to browsers —');
console.log('the worker already serves it at /api/auth/public-key.');
console.log('Verify afterwards: curl <worker-url>/api/auth/public-key  ->  "enabled": true');
console.log(`${line}\n`);
