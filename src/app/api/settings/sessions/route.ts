import { invalidateSessions } from '@/server/auth';
import { actionRoute, getRoute } from '@/server/http';

export const GET = getRoute(async ({ db, user }) => {
  const r = await db.query(
    'SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", user_agent AS "userAgent", id = $2 AS current FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC',
    [user.id, user.sessionId],
  );
  return { sessions: r.rows };
});

export const POST = actionRoute({ scope: 'settings.sessions', idempotent: false }, async ({ tx, user }) => {
  const r = await tx.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [user.id, user.sessionId]);
  invalidateSessions(user.id);
  return { revoked: r.rowCount };
});
