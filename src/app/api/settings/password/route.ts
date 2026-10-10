import { hashPassword, verifyPassword } from '@/server/auth';
import { GameError } from '@/server/errors';
import { audit } from '@/server/events';
import { actionRoute } from '@/server/http';
import { passwordChangeSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settings.password', schema: passwordChangeSchema, idempotent: false, limit: 'auth' }, async ({ tx, user, body, ip }) => {
  const r = await tx.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [user.id]);
  if (!(await verifyPassword(body.currentPassword, r.rows[0].password_hash))) throw new GameError('forbidden', 'Current password is incorrect');
  await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(body.newPassword)]);
  // Sign out every other session.
  await tx.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [user.id, user.sessionId]);
  await audit(tx, user.id, 'auth.password_change', 'user', user.id, {}, ip);
  return { changed: true };
});
