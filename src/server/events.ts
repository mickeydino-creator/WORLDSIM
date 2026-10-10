// Transactional outbox. Events are inserted inside the business transaction and announced via
// pg_notify, which PostgreSQL only delivers on COMMIT, so clients never hear about rolled-back changes.
import type { Tx } from './db';

export const EVENTS_CHANNEL = 'worldstate_events';

export type Channel = `chunk:${string}` | `user:${string}` | `settlement:${string}` | `market:${string}` | 'global';

export async function publish(tx: Tx, channel: Channel, type: string, payload: Record<string, unknown>) {
  const r = await tx.query<{ id: number }>(
    'INSERT INTO world_events (channel, type, payload) VALUES ($1, $2, $3) RETURNING id',
    [channel, type, JSON.stringify(payload)],
  );
  await tx.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, String(r.rows[0].id)]);
  return r.rows[0].id;
}

export async function notifyUser(tx: Tx, userId: string, type: string, title: string, body = '', payload: Record<string, unknown> = {}) {
  const r = await tx.query<{ id: number }>(
    'INSERT INTO notifications (user_id, type, title, body, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [userId, type, title, body, JSON.stringify(payload)],
  );
  await publish(tx, `user:${userId}`, 'notification', { id: r.rows[0].id, type, title, body, payload });
}

export async function audit(tx: Tx, actorUserId: string | null, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}, ip?: string | null) {
  await tx.query(
    'INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [actorUserId, action, targetType, targetId, JSON.stringify(details), ip ?? null],
  );
}
