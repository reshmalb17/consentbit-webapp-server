// src/handlers/feedback.js
import { ensureSchema, getSessionById } from '../services/db.js';

function getSessionIdFromCookie(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return match ? match[1].trim() : null;
}

export async function handleFeedback(request, env) {
  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);

  if (request.method === 'GET') {
    try {
      const { results } = await db
        .prepare(
          `SELECT id, userId, message, createdAt
           FROM Feedback
           ORDER BY createdAt DESC
           LIMIT 200`
        )
        .all();

      return Response.json({ success: true, feedbacks: results || [] });
    } catch (error) {
      console.error('[Feedback GET] Error:', error);
      return Response.json({ success: false, error: error?.message || 'Failed to fetch feedback' }, { status: 500 });
    }
  }

  if (request.method === 'POST') {
    // Resolve session (optional auth — store userId if logged in, allow anonymous)
    let userId = null;
    const sid = getSessionIdFromCookie(request);
    if (sid) {
      try {
        const session = await getSessionById(db, sid);
        if (session) userId = session.userId ?? session.user_id ?? null;
      } catch (_) {}
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    const message = (body?.message || '').trim();
    if (!message) {
      return Response.json({ success: false, error: 'message is required' }, { status: 400 });
    }
    if (message.length > 2000) {
      return Response.json({ success: false, error: 'message must be 2000 characters or fewer' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    try {
      await db
        .prepare(
          `INSERT INTO Feedback (id, userId, message, createdAt) VALUES (?1, ?2, ?3, ?4)`
        )
        .bind(id, userId, message, createdAt)
        .run();

      return Response.json({
        success: true,
        feedback: { id, userId, message, createdAt },
      }, { status: 201 });
    } catch (error) {
      console.error('[Feedback POST] Error:', error);
      return Response.json({ success: false, error: error?.message || 'Failed to save feedback' }, { status: 500 });
    }
  }

  return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
}
