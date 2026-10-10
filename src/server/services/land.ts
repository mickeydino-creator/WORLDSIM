import { CELL_DEG, MAX_CHUNKS_PER_REQUEST, chunkOfParcel, parcelBounds, parcelCenter, parcelRing, parcelsInChunk, parseChunkKey, parseParcelId } from '@/shared/grid';
import { LAND_CLASSES, NEIGHBOR_RADIUS_M, landPrice, type LandClass } from '@/shared/config/land';
import { XP } from '@/shared/config/progression';
import type { Db, Tx } from '../db';
import { fail } from '../errors';
import { publish } from '../events';
import { playerAccountId, systemAccountId, transfer } from '../ledger';
import { addXp, checkAchievements, maxParcelsForLevel, publishWallet } from './players';

// ---------------------------------------------------------------------------
// Land survey: classify every grid cell of a chunk from real geography (Natural Earth).
// ---------------------------------------------------------------------------

async function geoVersion(db: Db): Promise<number> {
  const r = await db.query<{ value: number }>("SELECT value FROM system_status WHERE key = 'geo_version'");
  if (!r.rows[0]) fail('unavailable', 'World geography has not been imported (run npm run geo:import)');
  return Number(r.rows[0].value);
}

/** Returns { parcelId: landClass } for every parcel in the chunk, computing and caching on first use. */
export async function surveyChunk(db: Db, chunkKey: string): Promise<Record<string, LandClass>> {
  const version = await geoVersion(db);
  const cached = await db.query<{ cells: Record<string, LandClass>; geo_version: number }>('SELECT cells, geo_version FROM parcel_surveys WHERE chunk_key = $1', [chunkKey]);
  if (cached.rows[0] && cached.rows[0].geo_version === version) return cached.rows[0].cells;

  const ids = parcelsInChunk(chunkKey);
  const pid: string[] = [];
  const lng: number[] = [];
  const lat: number[] = [];
  const kind: number[] = [];
  for (const id of ids) {
    const b = parcelBounds(id);
    const [cx, cy] = parcelCenter(id);
    const ix = (b.east - b.west) * 0.4;
    const iy = CELL_DEG * 0.4;
    const pts: [number, number][] = [[cx, cy], [cx - ix, cy - iy], [cx + ix, cy - iy], [cx + ix, cy + iy], [cx - ix, cy + iy]];
    pts.forEach(([x, y], k) => { pid.push(id); lng.push(x); lat.push(y); kind.push(k); });
  }
  const r = await db.query<{ id: string; k: number; land: boolean; lake: boolean; urban: boolean; restricted: boolean }>(
    `WITH pts AS (
       SELECT id, k, ST_SetSRID(ST_MakePoint(x, y), 4326) AS g
         FROM unnest($1::text[], $2::float8[], $3::float8[], $4::int[]) AS t(id, x, y, k))
     SELECT id, k,
       EXISTS (SELECT 1 FROM geo_features f WHERE f.layer = 'land' AND ST_Intersects(f.geom, pts.g)) AS land,
       EXISTS (SELECT 1 FROM geo_features f WHERE f.layer = 'lake' AND ST_Intersects(f.geom, pts.g)) AS lake,
       (k = 0 AND EXISTS (SELECT 1 FROM geo_features f WHERE f.layer = 'urban' AND ST_Intersects(f.geom, pts.g))) AS urban,
       (k = 0 AND EXISTS (SELECT 1 FROM restricted_zones z WHERE ST_Intersects(z.geom, pts.g))) AS restricted
     FROM pts`,
    [pid, lng, lat, kind],
  );
  const byId = new Map<string, { center?: { dry: boolean; urban: boolean; restricted: boolean }; wetCorner: boolean }>();
  for (const row of r.rows) {
    const e = byId.get(row.id) ?? { wetCorner: false };
    const dry = row.land && !row.lake;
    if (row.k === 0) e.center = { dry, urban: row.urban, restricted: row.restricted };
    else if (!dry) e.wetCorner = true;
    byId.set(row.id, e);
  }
  const cells: Record<string, LandClass> = {};
  for (const id of ids) {
    const e = byId.get(id);
    if (!e?.center) continue;
    cells[id] = e.center.restricted ? 'restricted' : !e.center.dry ? 'water' : e.center.urban ? 'urban' : e.wetCorner ? 'coastal' : 'land';
  }
  await db.query(
    `INSERT INTO parcel_surveys (chunk_key, cells, geo_version) VALUES ($1,$2,$3)
     ON CONFLICT (chunk_key) DO UPDATE SET cells = excluded.cells, geo_version = excluded.geo_version, surveyed_at = now()`,
    [chunkKey, JSON.stringify(cells), version],
  );
  return cells;
}

export async function landClassOf(db: Db, parcelId: string): Promise<LandClass> {
  const cells = await surveyChunk(db, chunkOfParcel(parcelId));
  return cells[parcelId] ?? 'water';
}

// ---------------------------------------------------------------------------
// Viewport chunk loading
// ---------------------------------------------------------------------------

export interface ChunkPayload {
  key: string;
  cells: Record<string, LandClass>;
  parcels: { id: string; ownerId: string | null; ownerName: string | null; settlementId: string | null; settlementName: string | null }[];
  buildings: BuildingSummary[];
}

export interface BuildingSummary {
  id: string;
  type: string;
  parcelId: string;
  lng: number;
  lat: number;
  rotation: number;
  level: number;
  status: string;
  ownerId: string | null;
  ownerName: string | null;
  settlementId: string | null;
}

export const BUILDING_SUMMARY_SQL = `
  SELECT b.id, b.type, b.parcel_id AS "parcelId", ST_X(b.position) AS lng, ST_Y(b.position) AS lat,
         b.rotation_deg AS rotation, b.level, b.status, b.owner_user_id AS "ownerId", u.display_name AS "ownerName",
         b.settlement_id AS "settlementId", b.chunk_key
    FROM buildings b LEFT JOIN users u ON u.id = b.owner_user_id`;

/** Maximum buildings returned for a single chunk request (bounded payload). */
export const MAX_BUILDINGS_PER_CHUNK = 2_000;

export async function loadChunks(db: Db, keys: string[]): Promise<ChunkPayload[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  if (unique.length > MAX_CHUNKS_PER_REQUEST) fail('invalid_input', `At most ${MAX_CHUNKS_PER_REQUEST} chunks per request`);
  for (const k of unique) if (!parseChunkKey(k)) fail('invalid_input', `Invalid chunk key ${k}`);

  const surveys: Record<string, Record<string, LandClass>> = {};
  for (const k of unique) surveys[k] = await surveyChunk(db, k);

  const parcels = await db.query<ChunkPayload['parcels'][number] & { chunk_key: string }>(
    `SELECT p.id, p.chunk_key, p.owner_user_id AS "ownerId", u.display_name AS "ownerName",
            p.settlement_id AS "settlementId", s.name AS "settlementName"
       FROM parcels p LEFT JOIN users u ON u.id = p.owner_user_id LEFT JOIN settlements s ON s.id = p.settlement_id
      WHERE p.chunk_key = ANY($1) AND (p.owner_user_id IS NOT NULL OR p.settlement_id IS NOT NULL)`,
    [unique],
  );
  const buildings = await db.query<BuildingSummary & { chunk_key: string }>(
    `${BUILDING_SUMMARY_SQL} WHERE b.chunk_key = ANY($1) ORDER BY b.created_at LIMIT $2`,
    [unique, MAX_BUILDINGS_PER_CHUNK * unique.length],
  );
  return unique.map((key) => ({
    key,
    cells: surveys[key],
    parcels: parcels.rows.filter((p) => p.chunk_key === key).map(({ chunk_key: _c, ...p }) => p),
    buildings: buildings.rows.filter((b) => b.chunk_key === key).map(({ chunk_key: _c, ...b }) => b),
  }));
}

// ---------------------------------------------------------------------------
// Parcel details & pricing
// ---------------------------------------------------------------------------

export async function ownedNeighborCount(db: Db, parcelId: string): Promise<number> {
  const [lng, lat] = parcelCenter(parcelId);
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM parcels
      WHERE id <> $3 AND (owner_user_id IS NOT NULL OR settlement_id IS NOT NULL)
        AND centroid && ST_Expand(ST_SetSRID(ST_MakePoint($1,$2),4326), 0.01)
        AND ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $4)`,
    [lng, lat, parcelId, NEIGHBOR_RADIUS_M],
  );
  return r.rows[0].n;
}

export async function quoteParcel(db: Db, parcelId: string) {
  if (!parseParcelId(parcelId)) fail('invalid_input', 'Invalid parcel id');
  const landClass = await landClassOf(db, parcelId);
  const neighbors = await ownedNeighborCount(db, parcelId);
  return { landClass, price: LAND_CLASSES[landClass].purchasable ? landPrice(landClass, neighbors) : null, neighbors };
}

export async function getParcelDetails(db: Db, parcelId: string, viewerId: string) {
  if (!parseParcelId(parcelId)) fail('invalid_input', 'Invalid parcel id');
  const quote = await quoteParcel(db, parcelId);
  const p = await db.query<{ owner_user_id: string | null; owner_name: string | null; settlement_id: string | null; settlement_name: string | null; created_at: Date; last_price: number | null }>(
    `SELECT p.owner_user_id, u.display_name AS owner_name, p.settlement_id, s.name AS settlement_name, p.created_at, p.last_price
       FROM parcels p LEFT JOIN users u ON u.id = p.owner_user_id LEFT JOIN settlements s ON s.id = p.settlement_id WHERE p.id = $1`,
    [parcelId],
  );
  const row = p.rows[0];
  const owned = !!row && (row.owner_user_id != null || row.settlement_id != null);
  const [buildings, history, permissions] = await Promise.all([
    db.query(`${BUILDING_SUMMARY_SQL} WHERE b.parcel_id = $1 ORDER BY b.created_at`, [parcelId]),
    db.query(
      `SELECT h.reason, h.price, h.created_at AS "at", fu.display_name AS "from", tu.display_name AS "to", ts.name AS "toSettlement"
         FROM parcel_ownership_history h
         LEFT JOIN users fu ON fu.id = h.from_user_id LEFT JOIN users tu ON tu.id = h.to_user_id
         LEFT JOIN settlements ts ON ts.id = h.to_settlement_id
        WHERE h.parcel_id = $1 ORDER BY h.id DESC LIMIT 10`,
      [parcelId],
    ),
    db.query<{ user_id: string; display_name: string }>(
      'SELECT pp.grantee_user_id AS user_id, u.display_name FROM parcel_permissions pp JOIN users u ON u.id = pp.grantee_user_id WHERE pp.parcel_id = $1',
      [parcelId],
    ),
  ]);
  const cls = LAND_CLASSES[quote.landClass];
  const status = !cls.purchasable ? quote.landClass : row?.settlement_id ? 'settlement' : row?.owner_user_id ? (row.owner_user_id === viewerId ? 'mine' : 'owned') : 'available';
  return {
    id: parcelId,
    ring: parcelRing(parcelId),
    center: parcelCenter(parcelId),
    landClass: quote.landClass,
    landClassName: cls.name,
    landClassDescription: cls.description,
    status,
    ownerId: row?.owner_user_id ?? null,
    ownerName: row?.owner_name ?? null,
    settlementId: row?.settlement_id ?? null,
    settlementName: row?.settlement_name ?? null,
    price: owned ? null : quote.price,
    lastPrice: row?.last_price ?? null,
    materializedAt: row?.created_at ?? null,
    buildings: buildings.rows,
    history: history.rows,
    builders: permissions.rows.map((r) => ({ id: r.user_id, name: r.display_name })),
    canBuild: row?.owner_user_id === viewerId || permissions.rows.some((r) => r.user_id === viewerId),
  };
}

// ---------------------------------------------------------------------------
// Purchase (server-authoritative, concurrency-safe)
// ---------------------------------------------------------------------------

/** Ensures a parcel row exists, then locks it. Concurrent callers serialise on the row lock. */
export async function lockParcel(tx: Tx, parcelId: string, landClass?: LandClass) {
  if (!parseParcelId(parcelId)) fail('invalid_input', 'Invalid parcel id');
  if (landClass) {
    const ring = parcelRing(parcelId);
    const [cx, cy] = parcelCenter(parcelId);
    const { row, col } = parseParcelId(parcelId)!;
    await tx.query(
      `INSERT INTO parcels (id, row_idx, col_idx, chunk_key, geom, centroid, land_class)
       VALUES ($1,$2,$3,$4, ST_SetSRID(ST_GeomFromGeoJSON($5),4326), ST_SetSRID(ST_MakePoint($6,$7),4326), $8)
       ON CONFLICT (id) DO NOTHING`,
      [parcelId, row, col, chunkOfParcel(parcelId), JSON.stringify({ type: 'Polygon', coordinates: [ring] }), cx, cy, landClass],
    );
  }
  const r = await tx.query<{ id: string; owner_user_id: string | null; settlement_id: string | null; land_class: LandClass; chunk_key: string }>(
    'SELECT id, owner_user_id, settlement_id, land_class, chunk_key FROM parcels WHERE id = $1 FOR UPDATE',
    [parcelId],
  );
  return r.rows[0] ?? null;
}

export async function parcelEventPayload(tx: Db, parcelId: string) {
  const r = await tx.query(
    `SELECT p.id, p.owner_user_id AS "ownerId", u.display_name AS "ownerName", p.settlement_id AS "settlementId", s.name AS "settlementName"
       FROM parcels p LEFT JOIN users u ON u.id = p.owner_user_id LEFT JOIN settlements s ON s.id = p.settlement_id WHERE p.id = $1`,
    [parcelId],
  );
  return r.rows[0];
}

export async function purchaseParcel(tx: Tx, userId: string, parcelId: string, opKey: string, maxPrice?: number) {
  if (!parseParcelId(parcelId)) fail('invalid_input', 'Invalid parcel id');
  const landClass = await landClassOf(tx, parcelId);
  if (landClass === 'restricted') fail('restricted', 'This parcel is in a restricted zone and cannot be purchased');
  if (!LAND_CLASSES[landClass].purchasable) fail('unavailable', `${LAND_CLASSES[landClass].name} cannot be purchased`);

  const parcel = await lockParcel(tx, parcelId, landClass);
  if (!parcel) fail('not_found', 'Parcel not found');
  if (parcel!.owner_user_id || parcel!.settlement_id) {
    fail('unavailable', parcel!.owner_user_id === userId ? 'You already own this parcel' : 'This parcel has already been purchased');
  }

  // Eligibility: parcel cap grows with player level.
  const pl = await tx.query<{ level: number; owned: number }>(
    'SELECT p.level, (SELECT count(*)::int FROM parcels WHERE owner_user_id = $1) AS owned FROM players p WHERE p.user_id = $1 FOR UPDATE',
    [userId],
  );
  const { level, owned } = pl.rows[0];
  if (owned >= maxParcelsForLevel(level)) fail('requirements_not_met', `Level ${level} players may own at most ${maxParcelsForLevel(level)} parcels`);

  const price = landPrice(landClass, await ownedNeighborCount(tx, parcelId));
  if (maxPrice !== undefined && price > maxPrice) fail('conflict', 'The price of this parcel changed. Review the new price and try again.', { price });

  const entryId = await transfer(tx, {
    from: await playerAccountId(tx, userId),
    to: await systemAccountId(tx, 'land_office'),
    amount: price,
    type: 'land_purchase',
    idempotencyKey: `${opKey}:land_purchase`,
    refs: { actorUserId: userId, parcelId },
    insufficientMessage: 'Insufficient funds to purchase this parcel',
  });
  await tx.query('UPDATE parcels SET owner_user_id = $2, last_price = $3, updated_at = now() WHERE id = $1', [parcelId, userId, price]);
  await tx.query(
    "INSERT INTO parcel_ownership_history (parcel_id, to_user_id, price, reason, ledger_entry_id) VALUES ($1,$2,$3,'purchase',$4)",
    [parcelId, userId, price, entryId],
  );
  await tx.query('UPDATE players SET home_lng = COALESCE(home_lng, $2), home_lat = COALESCE(home_lat, $3) WHERE user_id = $1', [userId, ...parcelCenter(parcelId)]);
  await addXp(tx, userId, XP.parcelPurchase);
  await checkAchievements(tx, userId, ['parcels']);
  await publish(tx, `chunk:${parcel!.chunk_key}`, 'parcel', (await parcelEventPayload(tx, parcelId)) as Record<string, unknown>);
  await publishWallet(tx, userId);
  return { parcelId, price, landClass };
}

export async function grantBuildPermission(tx: Tx, userId: string, parcelId: string, granteeUsername: string, grant: boolean) {
  const parcel = await lockParcel(tx, parcelId);
  if (!parcel || parcel.owner_user_id !== userId) fail('forbidden', 'Only the parcel owner can manage build permissions');
  const g = await tx.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [granteeUsername]);
  if (!g.rows[0]) fail('not_found', 'No player with that username');
  if (g.rows[0].id === userId) fail('invalid_input', 'You already own this parcel');
  if (grant) {
    await tx.query('INSERT INTO parcel_permissions (parcel_id, grantee_user_id, granted_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [parcelId, g.rows[0].id, userId]);
  } else {
    await tx.query('DELETE FROM parcel_permissions WHERE parcel_id = $1 AND grantee_user_id = $2', [parcelId, g.rows[0].id]);
  }
  return { parcelId, grantee: granteeUsername, granted: grant };
}

export async function listOwnedParcels(db: Db, userId: string) {
  const r = await db.query(
    `SELECT p.id, p.land_class AS "landClass", p.last_price AS "lastPrice", ST_X(p.centroid) AS lng, ST_Y(p.centroid) AS lat,
            (SELECT count(*)::int FROM buildings b WHERE b.parcel_id = p.id) AS buildings
       FROM parcels p WHERE p.owner_user_id = $1 ORDER BY p.updated_at DESC LIMIT 200`,
    [userId],
  );
  return r.rows;
}
