import { getRoute } from '@/server/http';

export const GET = getRoute(async ({ db, user }) => {
  const r = await db.query(
    'SELECT id, type, title, body, payload, read_at AS "readAt", created_at AS "at" FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
    [user.id],
  );
  return { notifications: r.rows };
});
