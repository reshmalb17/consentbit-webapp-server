// src/utils/adminAuth.js
// Validates the X-Admin-Key header against ADMIN_SECRET env var.
// Returns a 401 Response if invalid, null if valid.

/**
 * Constant-time string compare for secrets. `===` stops at the first differing
 * character, so response timing can leak how much of a guess was right. Length is
 * compared up front (it reveals only the length, not the content).
 */
export function secretMatches(provided, secret) {
  if (typeof provided !== 'string' || typeof secret !== 'string' || !secret) return false;
  if (provided.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export function checkAdminAuth(request, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) {
    return Response.json({ success: false, error: 'Admin secret not configured' }, { status: 500 });
  }
  const provided = request.headers.get('X-Admin-Key');
  if (!provided || !secretMatches(provided, secret)) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null; // valid
}
