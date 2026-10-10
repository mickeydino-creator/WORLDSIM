import { actionRoute } from '@/server/http';
import { publish } from '@/server/events';
import { displayNameSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settings.profile', schema: displayNameSchema, idempotent: false }, async ({ tx, user, body }) => {
  await tx.query('UPDATE users SET display_name = $2 WHERE id = $1', [user.id, body.displayName]);
  await publish(tx, `user:${user.id}`, 'player', {});
  return { displayName: body.displayName };
});
