import { actionRoute } from '@/server/http';
import { markReadSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'notifications.read', schema: markReadSchema, idempotent: false }, async ({ tx, user, body }) => {
  const r = body.ids?.length
    ? await tx.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [user.id, body.ids])
    : await tx.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  return { marked: r.rowCount };
});
