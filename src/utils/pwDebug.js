// src/utils/pwDebug.js
//
// TEMPORARY — verbose tracing for the password-auth rollout on the Test worker.
//
// TO REMOVE: every line this adds to a handler contains the token `pwDebug`, so
//   grep -v pwDebug   over authLogin.js / authSetPassword.js / authRequestCode.js /
//   authVerifyCode.js, then delete this file. Nothing else references it.
//
// SAFETY: this never logs a password, a hash, or a session id — only lengths, detected
// formats and pass/fail outcomes. Keep it that way if you add more calls: Workers logs
// are retained and tailable, so a plaintext password logged here is a real leak.

/** Name the stored credential's format without revealing any of it. */
export function describeStored(stored) {
  if (stored === null || stored === undefined) return 'null';
  const s = String(stored).trim();
  if (s === '') return 'empty';
  if (s === 'passwordless') return 'sentinel-passwordless';
  if (s.startsWith('client:')) return 'legacy-client-sha256';
  if (/^[0-9a-f]{32}:[0-9a-f]{64}$/i.test(s)) return 'pbkdf2-salt:hash';
  if (s.includes(':')) return 'colon-other';
  return `unknown(len=${s.length})`;
}

export function pwDebug(event, data) {
  try {
    console.log(`[PwAuth:DEBUG] ${event}`, JSON.stringify(data));
  } catch (e) {
    console.log(`[PwAuth:DEBUG] ${event} <unserialisable>`);
  }
}
