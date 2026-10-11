// Transactional outbox. Events are inserted inside the business transaction and announced via
// pg_notify, which PostgreSQL only delivers on COMMIT, so clients never hear about rolled-back changes.
import type { Tx } from './db';

export const EVENTS_CHANNEL = 'worldstate_events';

export type Channel = `chunk:${string}` | `user:${string}` | `settlement:${string}` | `market:${string}` | 'global';

// Each helper below is a single SQL statement (one database round trip): the event row is inserted
// and pg_notify is called in the same statement.
const NOTIFY_TAIL = `SELECT pg_notify('${EVENTS_CHANNEL}', id::text) AS sent, id, payload FROM e`;

export async function publish(tx: Tx, channel: Channel, type: string, payload: Record<string, unknown>) {
  const r = await tx.query<{ id: number }>(
    `WITH e AS (INSERT INTO world_events (channel, type, payload) VALUES ($1, $2, $3) RETURNING id, payload) ${NOTIFY_TAIL}`,
    [channel, type, JSON.stringify(payload)],
  );
  return r.rows[0].id;
}

/**
 * Publishes an event whose payload is computed by a SQL query (row → JSON) without a separate read.
 * `sql` must select exactly one row; its columns become the payload (or `{ [wrapKey]: row }`).
 * Placeholders in `sql` start at $2 ($1 is the event type). `channelSql` is evaluated per row of `q`.
 * Returns the payload, or null if the query found no row.
 */
export async function publishFromQuery<T = Record<string, unknown>>(tx: Tx, channelSql: string, type: string, sql: string, params: unknown[], wrapKey?: string): Promise<T | null> {
  const payloadExpr = wrapKey ? `jsonb_build_object('${wrapKey}', to_jsonb(q) - 'chunk_key')` : `to_jsonb(q) - 'chunk_key'`;
  const r = await tx.query<{ payload: T }>(
    `WITH q AS (${sql}),
          e AS (INSERT INTO world_events (channel, type, payload) SELECT ${channelSql}, $1, ${payloadExpr} FROM q RETURNING id, payload)
     ${NOTIFY_TAIL}`,
    [type, ...params],
  );
  return r.rows[0]?.payload ?? null;
}

export async function notifyUser(tx: Tx, userId: string, type: string, title: string, body = '', payload: Record<string, unknown> = {}) {
  await tx.query(
    `WITH n AS (INSERT INTO notifications (user_id, type, title, body, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id),
          e AS (INSERT INTO world_events (channel, type, payload)
                SELECT 'user:' || $1::text, 'notification', jsonb_build_object('id', n.id, 'type', $2::text, 'title', $3::text, 'body', $4::text, 'payload', $5::jsonb) FROM n
                RETURNING id, payload)
     ${NOTIFY_TAIL}`,
    [userId, type, title, body, JSON.stringify(payload)],
  );
}

export async function audit(tx: Tx, actorUserId: string | null, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}, ip?: string | null) {
  await tx.query(
    'INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [actorUserId, action, targetType, targetId, JSON.stringify(details), ip ?? null],
  );
}
