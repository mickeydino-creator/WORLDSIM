import { getBuildingDef } from '@/shared/config/buildings';
import { BASE_STORAGE, RESOURCE_IDS, isResourceId, type ResourceId } from '@/shared/config/resources';
import { computeModifiers } from '@/shared/config/research';
import type { Db, Tx } from '../db';
import { fail } from '../errors';

export type ResourceMap = Partial<Record<ResourceId, number>>;

/** Storage capacity per resource: base + storage buildings, scaled by research/specialization. */
export async function storageCapacity(db: Db, userId: string): Promise<number> {
  const b = await db.query<{ type: string; level: number }>('SELECT type, level FROM buildings WHERE owner_user_id = $1', [userId]);
  let extra = 0;
  for (const row of b.rows) extra += (getBuildingDef(row.type)?.effects.storage ?? 0) * row.level;
  const p = await db.query<{ specialization: string | null; techs: string[] }>(
    `SELECT p.specialization, COALESCE(array_agg(r.tech_id) FILTER (WHERE r.tech_id IS NOT NULL), '{}') AS techs
       FROM players p LEFT JOIN player_research r ON r.user_id = p.user_id WHERE p.user_id = $1 GROUP BY p.user_id`,
    [userId],
  );
  const m = computeModifiers(p.rows[0]?.techs ?? [], p.rows[0]?.specialization ?? null);
  return Math.floor((BASE_STORAGE + extra) * m.storageMultiplier);
}

export async function getInventory(db: Db, userId: string) {
  const r = await db.query<{ resource: string; quantity: number }>('SELECT resource, quantity FROM inventories WHERE user_id = $1', [userId]);
  const items = Object.fromEntries(RESOURCE_IDS.map((id) => [id, 0])) as Record<ResourceId, number>;
  for (const row of r.rows) if (isResourceId(row.resource)) items[row.resource] = row.quantity;
  return { items, capacity: await storageCapacity(db, userId) };
}

function entries(map: ResourceMap): [ResourceId, number][] {
  // Sorted order gives a consistent row-lock order across concurrent transactions.
  return (Object.entries(map) as [ResourceId, number][])
    .filter(([, q]) => (q ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Atomically removes resources. Each row update is conditional on sufficient stock, so the
 * quantity can never go negative even under concurrency; a shortfall aborts the transaction.
 */
export async function removeResources(tx: Tx, userId: string, map: ResourceMap) {
  for (const [res, q] of entries(map)) {
    if (!Number.isSafeInteger(q)) throw new Error('invalid quantity');
    const r = await tx.query('UPDATE inventories SET quantity = quantity - $3 WHERE user_id = $1 AND resource = $2 AND quantity >= $3', [userId, res, q]);
    if (r.rowCount === 0) fail('insufficient_resources', `Not enough ${res} (need ${q})`, { resource: res, required: q });
  }
}

/**
 * Atomically adds resources. Unless ignoreCapacity, the per-resource capacity is enforced inside
 * the UPDATE itself so concurrent additions cannot overfill storage.
 * With clamp, surplus beyond capacity is discarded and the delivered amounts are returned.
 */
export async function addResources(tx: Tx, userId: string, map: ResourceMap, opts: { ignoreCapacity?: boolean; clamp?: boolean; capacity?: number } = {}): Promise<ResourceMap> {
  const list = entries(map);
  if (list.length === 0) return {};
  const cap = opts.ignoreCapacity ? Number.MAX_SAFE_INTEGER : (opts.capacity ?? (await storageCapacity(tx, userId)));
  const delivered: ResourceMap = {};
  for (const [res, q] of list) {
    if (!Number.isSafeInteger(q)) throw new Error('invalid quantity');
    await tx.query('INSERT INTO inventories (user_id, resource, quantity) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [userId, res]);
    if (opts.clamp) {
      const r = await tx.query<{ added: number }>(
        `WITH cur AS (SELECT quantity FROM inventories WHERE user_id = $1 AND resource = $2 FOR UPDATE)
         UPDATE inventories i SET quantity = LEAST($4::bigint, cur.quantity + $3) FROM cur
          WHERE i.user_id = $1 AND i.resource = $2
         RETURNING GREATEST(0, i.quantity - cur.quantity) AS added`,
        [userId, res, q, Math.max(cap, 0)],
      );
      delivered[res] = r.rows[0]?.added ?? 0;
    } else {
      const r = await tx.query('UPDATE inventories SET quantity = quantity + $3 WHERE user_id = $1 AND resource = $2 AND quantity + $3 <= $4', [userId, res, q, cap]);
      if (r.rowCount === 0) fail('storage_full', `Not enough storage for ${q} ${res} (capacity ${cap})`, { resource: res, capacity: cap });
      delivered[res] = q;
    }
  }
  return delivered;
}

export function scaleResources(map: ResourceMap, factor: number): ResourceMap {
  const out: ResourceMap = {};
  for (const [r, q] of Object.entries(map)) out[r as ResourceId] = Math.floor((q ?? 0) * factor);
  return out;
}
