// utils/signedToken.js
// Compact HMAC-SHA256 signed tokens for unauthenticated PDF download links.
//
// Token format: base64url(exp_unix_seconds) + '.' + base64url(HMAC(siteId:id:exp))
// Keeping the payload tiny so the full URL stays well under Excel's 255-char hyperlink limit.

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function getKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

export async function createDownloadToken(secret, siteId, id) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const expB64 = base64url(new TextEncoder().encode(String(exp)));
  const message = `${siteId}:${id}:${exp}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `${expB64}.${base64url(sig)}`;
}

export async function verifyDownloadToken(secret, token, expectedSiteId, expectedId) {
  try {
    const dot = token.indexOf('.');
    if (dot === -1) return false;
    const expB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    const exp = parseInt(new TextDecoder().decode(base64urlDecode(expB64)), 10);
    if (!exp || exp < Math.floor(Date.now() / 1000)) return false;
    const message = `${expectedSiteId}:${expectedId}:${exp}`;
    const key = await getKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC', key, base64urlDecode(sigB64), new TextEncoder().encode(message),
    );
    return valid;
  } catch {
    return false;
  }
}
