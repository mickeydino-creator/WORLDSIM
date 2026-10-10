import { GameError } from '@/server/errors';
import { audit, notifyUser } from '@/server/events';
import { actionRoute } from '@/server/http';
import { playerAccountId, systemAccountId, transfer } from '@/server/ledger';
import { publishWallet } from '@/server/services/players';
import { adminGrantSchema } from '@/shared/schemas';

// Restricted, audited administrative currency grant.
export const POST = actionRoute({ scope: 'admin.grant', schema: adminGrantSchema }, async ({ tx, user, body, opKey, ip }) => {
  if (!user.isAdmin) throw new GameError('forbidden', 'Administrators only');
  const u = await tx.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [body.username]);
  if (!u.rows[0]) throw new GameError('not_found', 'No such player');
  await transfer(tx, {
    from: await systemAccountId(tx, 'mint'), to: await playerAccountId(tx, u.rows[0].id), amount: body.amount, type: 'admin_grant',
    idempotencyKey: `${opKey}:admin_grant`, refs: { actorUserId: user.id }, metadata: { reason: body.reason },
  });
  await audit(tx, user.id, 'admin.grant', 'user', u.rows[0].id, { amount: body.amount, reason: body.reason }, ip);
  await notifyUser(tx, u.rows[0].id, 'admin_grant', 'Administrative credit grant', body.reason);
  await publishWallet(tx, u.rows[0].id);
  return { granted: body.amount };
});
