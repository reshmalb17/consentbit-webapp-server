// src/utils/adminAuth.js
// Validates the X-Admin-Key header against ADMIN_SECRET env var.
// Returns a 401 Response if invalid, null if valid.

export function checkAdminAuth(request, env) {
  const secret = env.ADMIN_SECRET;
  if (!secret) {
    return Response.json({ success: false, error: 'Admin secret not configured' }, { status: 500 });
  }
  const provided = request.headers.get('X-Admin-Key');
  if (!provided || provided !== secret) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null; // valid
}
