import { DEMOLISH_REFUND, getBuildingDef, upgradeCost, type BuildingDef } from '@/shared/config/buildings';
import { LAND_CLASSES } from '@/shared/config/land';
import { XP } from '@/shared/config/progression';
import { hasPermission, type SettlementRole } from '@/shared/config/settlements';
import { footprintRing } from '@/shared/geo';
import { chunkKeyAt, parcelIdAt } from '@/shared/grid';
import type { Db, Tx } from '../db';
import { fail } from '../errors';
import { publish } from '../events';
import { playerAccountId, settlementAccountId, systemAccountId, transfer } from '../ledger';
import { removeResources, type ResourceMap } from './inventory';
import { BUILDING_SUMMARY_SQL, lockParcel, type BuildingSummary } from './land';
import { addXp, checkAchievements, getModifiers, ownedBuildingCounts, publishWallet, unlockedTechs } from './players';

export interface PlacementInput {
  type: string;
  parcelId: string;
  lng: number;
  lat: number;
  rotation: number;
}

/** Categories allowed on settlement (civic) land: no private production businesses. */
function allowedOnSettlementLand(def: BuildingDef) {
  return !def.effects.recipes?.length;
}

async function settlementRole(db: Db, userId: string, settlementId: string): Promise<SettlementRole | null> {
  const r = await db.query<{ role: SettlementRole }>('SELECT role FROM settlement_members WHERE settlement_id = $1 AND user_id = $2', [settlementId, userId]);
  return r.rows[0]?.role ?? null;
}

export function scaledCost(def: BuildingDef, multiplier: number) {
  return Math.round(def.cost * multiplier);
}

/**
 * Validates and pays for a new building. All checks run server-side under a lock on the parcel row,
 * which serialises concurrent placements on the same parcel (the only place they could collide).
 */
export async function placeBuilding(tx: Tx, userId: string, input: PlacementInput, opKey: string, opts: { asSettlementProject?: { settlementId: string; projectId: string } } = {}) {
  const def = getBuildingDef(input.type);
  if (!def) fail('invalid_input', 'Unknown building type');
  const d = def!;
  if (!Number.isFinite(input.lng) || !Number.isFinite(input.lat)) fail('invalid_input', 'Invalid position');
  const rotation = ((Math.round(input.rotation) % 360) + 360) % 360;
  if (parcelIdAt(input.lng, input.lat) !== input.parcelId) fail('invalid_placement', 'The building centre must be inside the selected parcel');

  const parcel = await lockParcel(tx, input.parcelId);
  if (!parcel || (!parcel.owner_user_id && !parcel.settlement_id)) fail('forbidden', 'You can only build on land you own or have permission to use');
  const p = parcel!;
  const project = opts.asSettlementProject;

  // --- permissions --------------------------------------------------------
  let ownerUserId: string | null = null;
  let ownerSettlementId: string | null = null;
  if (project) {
    if (p.settlement_id !== project.settlementId) fail('invalid_placement', 'Project site must be settlement land');
    ownerSettlementId = project.settlementId;
  } else if (p.settlement_id) {
    const role = await settlementRole(tx, userId, p.settlement_id);
    if (!role || !hasPermission(role, 'build_on_land')) fail('forbidden', 'Your settlement role does not allow building on settlement land');
    if (!allowedOnSettlementLand(d)) fail('requirements_not_met', 'Settlement land is zoned for civic, residential and infrastructure buildings only');
    ownerSettlementId = p.settlement_id;
  } else if (p.owner_user_id === userId) {
    ownerUserId = userId;
  } else {
    const perm = await tx.query('SELECT 1 FROM parcel_permissions WHERE parcel_id = $1 AND grantee_user_id = $2', [p.id, userId]);
    if (perm.rowCount === 0) fail('forbidden', "You do not have permission to build on another player's land");
    ownerUserId = userId;
  }

  // --- requirements -------------------------------------------------------
  const req = d.requirements;
  if (!LAND_CLASSES[p.land_class].purchasable) fail('restricted', 'Construction is not permitted here');
  if (req.landClasses && !req.landClasses.includes(p.land_class)) fail('requirements_not_met', `${d.name} cannot be built on ${LAND_CLASSES[p.land_class].name.toLowerCase()}`);
  if (req.settlementLandOnly && !ownerSettlementId) fail('requirements_not_met', `${d.name} can only be built on settlement land`);
  if (!project) {
    const pl = await tx.query<{ level: number }>('SELECT level FROM players WHERE user_id = $1', [userId]);
    if (req.minLevel && pl.rows[0].level < req.minLevel) fail('requirements_not_met', `Requires player level ${req.minLevel}`);
    if (req.research?.length) {
      const techs = await unlockedTechs(tx, userId);
      const missing = req.research.filter((t) => !techs.has(t));
      if (missing.length) fail('requirements_not_met', `Requires research: ${missing.join(', ')}`);
    }
    if (req.requiresOwned?.length) {
      const counts = await ownedBuildingCounts(tx, userId);
      const missing = req.requiresOwned.filter((t) => !counts[t]);
      if (missing.length) fail('requirements_not_met', `Requires owning: ${missing.map((t) => getBuildingDef(t)?.name ?? t).join(', ')}`);
    }
  }

  // --- geometry -----------------------------------------------------------
  const ring = footprintRing([input.lng, input.lat], d.width, d.depth, rotation);
  const fp = JSON.stringify({ type: 'Polygon', coordinates: [ring] });
  const geo = await tx.query<{ inside: boolean }>(
    'SELECT ST_CoveredBy(ST_SetSRID(ST_GeomFromGeoJSON($1),4326), geom) AS inside FROM parcels WHERE id = $2',
    [fp, p.id],
  );
  if (!geo.rows[0]?.inside) fail('invalid_placement', 'The building must fit entirely inside the parcel');
  const clash = await tx.query<{ id: string; type: string }>(
    `SELECT id, type FROM buildings
      WHERE footprint && ST_SetSRID(ST_GeomFromGeoJSON($1),4326)
        AND ST_Relate(footprint, ST_SetSRID(ST_GeomFromGeoJSON($1),4326), 'T********')
      LIMIT 1`,
    [fp],
  );
  if (clash.rows[0]) fail('invalid_placement', `Overlaps an existing ${getBuildingDef(clash.rows[0].type)?.name ?? 'building'}`, { buildingId: clash.rows[0].id });

  // --- payment (project buildings are pre-funded by contributions) -------
  let cost = 0;
  if (!project) {
    const mods = await getModifiers(tx, userId);
    cost = scaledCost(d, mods.buildCostMultiplier);
    await removeResources(tx, userId, d.resources);
  }

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO buildings (type, owner_user_id, settlement_id, built_by, parcel_id, chunk_key, position, rotation_deg, footprint, status)
     VALUES ($1,$2,$3,$4,$5,$6, ST_SetSRID(ST_MakePoint($7,$8),4326), $9, ST_SetSRID(ST_GeomFromGeoJSON($10),4326), $11)
     RETURNING id`,
    [d.type, ownerUserId, ownerSettlementId, userId, p.id, chunkKeyAt(input.lng, input.lat), input.lng, input.lat, rotation, fp, d.effects.recipes?.length ? 'idle' : 'active'],
  );
  const buildingId = ins.rows[0].id;

  if (cost > 0) {
    await transfer(tx, {
      from: await playerAccountId(tx, userId),
      to: await systemAccountId(tx, 'construction'),
      amount: cost,
      type: 'construction',
      idempotencyKey: `${opKey}:construction`,
      refs: { actorUserId: userId, parcelId: p.id, buildingId, settlementId: ownerSettlementId },
      metadata: { type: d.type },
      insufficientMessage: `Insufficient funds to build ${d.name}`,
    });
  }
  if (!project) {
    await addXp(tx, userId, XP.buildBase + Math.floor(cost / 100_000) * XP.buildPer1000Credits);
    await checkAchievements(tx, userId, ['buildings']);
    await publishWallet(tx, userId);
    await publish(tx, `user:${userId}`, 'inventory', {});
  }
  const summary = await buildingSummary(tx, buildingId);
  await publish(tx, `chunk:${summary.chunkKey}`, 'building', { building: summary.building });
  return { building: summary.building, cost };
}

export async function buildingSummary(db: Db, buildingId: string): Promise<{ building: BuildingSummary; chunkKey: string }> {
  const r = await db.query<BuildingSummary & { chunk_key: string }>(`${BUILDING_SUMMARY_SQL} WHERE b.id = $1`, [buildingId]);
  if (!r.rows[0]) fail('not_found', 'Building not found');
  const { chunk_key, ...building } = r.rows[0];
  return { building, chunkKey: chunk_key };
}

interface LockedBuilding {
  id: string;
  type: string;
  owner_user_id: string | null;
  settlement_id: string | null;
  parcel_id: string;
  chunk_key: string;
  level: number;
  status: string;
}

export async function lockBuilding(tx: Tx, buildingId: string): Promise<LockedBuilding> {
  const r = await tx.query<LockedBuilding>(
    'SELECT id, type, owner_user_id, settlement_id, parcel_id, chunk_key, level, status FROM buildings WHERE id = $1 FOR UPDATE',
    [buildingId],
  );
  if (!r.rows[0]) fail('not_found', 'Building not found');
  return r.rows[0];
}

/** Who may manage (upgrade/demolish) a building: its owner, or settlement members with manage_assets. */
async function assertCanManage(tx: Tx, userId: string, b: LockedBuilding) {
  if (b.owner_user_id) {
    if (b.owner_user_id !== userId) fail('forbidden', 'You do not own this building');
    return;
  }
  const role = await settlementRole(tx, userId, b.settlement_id!);
  if (!role || !hasPermission(role, 'manage_assets')) fail('forbidden', 'Your settlement role does not allow managing settlement assets');
}

export async function upgradeBuilding(tx: Tx, userId: string, buildingId: string, opKey: string) {
  const b = await lockBuilding(tx, buildingId);
  await assertCanManage(tx, userId, b);
  const def = getBuildingDef(b.type)!;
  if (b.level >= def.maxLevel) fail('requirements_not_met', `${def.name} is already at maximum level`);
  if (b.status === 'producing') fail('conflict', 'Wait for the current production run to finish before upgrading');
  const target = b.level + 1;
  const mods = await getModifiers(tx, userId);
  const { cost, resources } = upgradeCost(def, target);
  const finalCost = Math.round(cost * mods.buildCostMultiplier);
  await removeResources(tx, userId, resources);
  if (finalCost > 0) {
    await transfer(tx, {
      from: await playerAccountId(tx, userId),
      to: await systemAccountId(tx, 'construction'),
      amount: finalCost,
      type: 'upgrade',
      idempotencyKey: `${opKey}:upgrade`,
      refs: { actorUserId: userId, buildingId, parcelId: b.parcel_id, settlementId: b.settlement_id },
      metadata: { toLevel: target },
      insufficientMessage: 'Insufficient funds for this upgrade',
    });
  }
  await tx.query('UPDATE buildings SET level = $2, updated_at = now() WHERE id = $1', [buildingId, target]);
  await addXp(tx, userId, XP.buildBase);
  await publishWallet(tx, userId);
  await publish(tx, `user:${userId}`, 'inventory', {});
  const s = await buildingSummary(tx, buildingId);
  await publish(tx, `chunk:${s.chunkKey}`, 'building', { building: s.building });
  return { building: s.building, cost: finalCost, resources };
}

export async function demolishBuilding(tx: Tx, userId: string, buildingId: string, opKey: string) {
  const b = await lockBuilding(tx, buildingId);
  await assertCanManage(tx, userId, b);
  if (b.status === 'producing') fail('conflict', 'Cancel or finish the current production run before demolishing');
  const def = getBuildingDef(b.type)!;
  const refund = Math.floor(def.cost * DEMOLISH_REFUND);
  const destination = b.owner_user_id ? await playerAccountId(tx, b.owner_user_id) : await settlementAccountId(tx, b.settlement_id!);
  if (refund > 0) {
    await transfer(tx, {
      from: await systemAccountId(tx, 'construction'),
      to: destination,
      amount: refund,
      type: 'demolition_refund',
      idempotencyKey: `${opKey}:demolish`,
      refs: { actorUserId: userId, buildingId, parcelId: b.parcel_id, settlementId: b.settlement_id },
      metadata: { type: b.type },
    });
  }
  await tx.query('DELETE FROM buildings WHERE id = $1', [buildingId]);
  if (b.owner_user_id) await publishWallet(tx, b.owner_user_id);
  await publish(tx, `chunk:${b.chunk_key}`, 'building_removed', { id: buildingId, parcelId: b.parcel_id });
  return { id: buildingId, refund };
}

export async function getBuildingDetails(db: Db, buildingId: string, viewerId: string) {
  const { building } = await buildingSummary(db, buildingId);
  const def = getBuildingDef(building.type)!;
  const run = await db.query(
    `SELECT id, recipe_id AS "recipeId", inputs, outputs, currency_out AS "currencyOut", started_at AS "startedAt", completes_at AS "completesAt"
       FROM production_runs WHERE building_id = $1 AND status = 'running'`,
    [buildingId],
  );
  const extra = await db.query<{ auto_repeat: boolean; recipe_id: string | null; built_by_name: string; created_at: Date }>(
    'SELECT b.auto_repeat, b.recipe_id, u.display_name AS built_by_name, b.created_at FROM buildings b JOIN users u ON u.id = b.built_by WHERE b.id = $1',
    [buildingId],
  );
  let canManage = building.ownerId === viewerId;
  if (!canManage && building.settlementId) {
    const role = await settlementRole(db, viewerId, building.settlementId);
    canManage = !!role && hasPermission(role, 'manage_assets');
  }
  const next = building.level < def.maxLevel ? upgradeCost(def, building.level + 1) : null;
  return {
    ...building,
    name: def.name,
    category: def.category,
    maxLevel: def.maxLevel,
    builtBy: extra.rows[0].built_by_name,
    createdAt: extra.rows[0].created_at,
    autoRepeat: extra.rows[0].auto_repeat,
    lastRecipeId: extra.rows[0].recipe_id,
    currentRun: run.rows[0] ?? null,
    canManage,
    canOperate: building.ownerId === viewerId,
    upgrade: next,
    demolishRefund: Math.floor(def.cost * DEMOLISH_REFUND),
  };
}

export async function listMyBuildings(db: Db, userId: string) {
  const r = await db.query(`${BUILDING_SUMMARY_SQL} WHERE b.owner_user_id = $1 ORDER BY b.created_at DESC LIMIT 500`, [userId]);
  return r.rows.map(({ chunk_key: _c, ...b }) => b);
}

export type { ResourceMap };
