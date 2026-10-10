import { getBuildingDef, levelMultiplier } from '@/shared/config/buildings';
import { RP_PER_RUN, getRecipe, type RecipeDef } from '@/shared/config/recipes';
import type { ResourceId } from '@/shared/config/resources';
import type { Tx } from '../db';
import { fail, GameError } from '../errors';
import { notifyUser, publish } from '../events';
import { enqueue } from '../jobs';
import { playerAccountId, systemAccountId, transfer } from '../ledger';
import { addResources, removeResources, storageCapacity, type ResourceMap } from './inventory';
import { buildingSummary, lockBuilding } from './buildings';
import { addXp, checkAchievements, getModifiers, publishWallet, unlockedTechs } from './players';

export interface RunPlan {
  recipe: RecipeDef;
  inputs: ResourceMap;
  outputs: ResourceMap;
  currencyOut: number;
  durationSec: number;
}

export async function planRun(tx: Tx, userId: string, buildingType: string, level: number, recipeId: string): Promise<RunPlan> {
  const def = getBuildingDef(buildingType)!;
  const recipe = getRecipe(recipeId);
  if (!recipe || recipe.building !== buildingType || !def.effects.recipes?.includes(recipeId)) fail('invalid_input', 'This building cannot run that recipe');
  const r = recipe!;
  if (r.research?.length) {
    const techs = await unlockedTechs(tx, userId);
    const missing = r.research.filter((t) => !techs.has(t));
    if (missing.length) fail('requirements_not_met', `Requires research: ${missing.join(', ')}`);
  }
  const mods = await getModifiers(tx, userId);
  const outMul = levelMultiplier(level) * (mods.outputMultiplier[def.category] ?? 1);
  const outputs: ResourceMap = {};
  for (const [res, q] of Object.entries(r.outputs)) outputs[res as ResourceId] = Math.floor((q ?? 0) * outMul);
  return {
    recipe: r,
    inputs: { ...r.inputs },
    outputs,
    currencyOut: Math.floor((r.currencyOut ?? 0) * levelMultiplier(level) * mods.incomeMultiplier),
    durationSec: Math.max(5, Math.round(r.durationSec * mods.durationMultiplier)),
  };
}

/** Starts a production run: consumes inputs and operating cost now, schedules completion durably. */
export async function startProduction(tx: Tx, userId: string, buildingId: string, recipeId: string, autoRepeat: boolean, opKey: string) {
  const b = await lockBuilding(tx, buildingId);
  if (b.owner_user_id !== userId) fail('forbidden', 'Only the owner can operate this business');
  if (b.status === 'producing') fail('conflict', 'This building is already producing');
  const plan = await planRun(tx, userId, b.type, b.level, recipeId);

  // Ensure there is room for the output before committing inputs.
  const cap = await storageCapacity(tx, userId);
  for (const [res, q] of Object.entries(plan.outputs)) {
    const cur = await tx.query<{ quantity: number }>('SELECT quantity FROM inventories WHERE user_id = $1 AND resource = $2', [userId, res]);
    if ((cur.rows[0]?.quantity ?? 0) + (q ?? 0) > cap) fail('storage_full', `Not enough storage for ${q} ${res}. Build or upgrade a warehouse, or sell stock.`);
  }

  await removeResources(tx, userId, plan.inputs);
  const run = await tx.query<{ id: string; completes_at: Date }>(
    `INSERT INTO production_runs (building_id, owner_user_id, recipe_id, inputs, outputs, currency_out, status, completes_at)
     VALUES ($1,$2,$3,$4,$5,$6,'running', now() + make_interval(secs => $7)) RETURNING id, completes_at`,
    [buildingId, userId, recipeId, JSON.stringify(plan.inputs), JSON.stringify(plan.outputs), plan.currencyOut, plan.durationSec],
  );
  const runId = run.rows[0].id;
  if (plan.recipe.operatingCost > 0) {
    await transfer(tx, {
      from: await playerAccountId(tx, userId),
      to: await systemAccountId(tx, 'operations'),
      amount: plan.recipe.operatingCost,
      type: 'operating_cost',
      idempotencyKey: `${opKey}:opcost`,
      refs: { actorUserId: userId, buildingId, productionRunId: runId },
      insufficientMessage: 'Insufficient funds for operating costs',
    });
  }
  await tx.query("UPDATE buildings SET status = 'producing', recipe_id = $2, auto_repeat = $3, updated_at = now() WHERE id = $1", [buildingId, recipeId, autoRepeat]);
  await enqueue(tx, 'production.complete', { runId }, { runAt: run.rows[0].completes_at, dedupeKey: `production:${runId}` });
  await publishWallet(tx, userId);
  await publish(tx, `user:${userId}`, 'inventory', {});
  await publish(tx, `user:${userId}`, 'production', { buildingId, runId, status: 'running', completesAt: run.rows[0].completes_at });
  const s = await buildingSummary(tx, buildingId);
  await publish(tx, `chunk:${s.chunkKey}`, 'building', { building: s.building });
  return { runId, completesAt: run.rows[0].completes_at, plan: { inputs: plan.inputs, outputs: plan.outputs, currencyOut: plan.currencyOut, durationSec: plan.durationSec } };
}

/**
 * Completes a run. Safe to call repeatedly: only a 'running' run is completed, under a row lock,
 * and the reward ledger entry has a deterministic idempotency key.
 */
export async function completeProduction(tx: Tx, runId: string): Promise<'completed' | 'not_due' | 'noop'> {
  const r = await tx.query<{ id: string; building_id: string; owner_user_id: string; recipe_id: string; outputs: ResourceMap; currency_out: number; status: string; due: boolean }>(
    'SELECT id, building_id, owner_user_id, recipe_id, outputs, currency_out, status, completes_at <= now() AS due FROM production_runs WHERE id = $1 FOR UPDATE',
    [runId],
  );
  const run = r.rows[0];
  if (!run || run.status !== 'running') return 'noop';
  if (!run.due) return 'not_due';
  const userId = run.owner_user_id;
  const recipe = getRecipe(run.recipe_id)!;

  const delivered = await addResources(tx, userId, run.outputs, { clamp: true });
  const lost = Object.entries(run.outputs).filter(([res, q]) => (delivered[res as ResourceId] ?? 0) < (q ?? 0));
  if (run.currency_out > 0) {
    await transfer(tx, {
      from: await systemAccountId(tx, 'mint'),
      to: await playerAccountId(tx, userId),
      amount: run.currency_out,
      type: 'production_sales',
      idempotencyKey: `production:${runId}:sales`,
      refs: { actorUserId: userId, buildingId: run.building_id, productionRunId: runId },
    });
  }
  await tx.query("UPDATE production_runs SET status = 'completed', completed_at = now() WHERE id = $1", [runId]);
  await tx.query('UPDATE players SET research_points = research_points + $2 WHERE user_id = $1', [userId, RP_PER_RUN]);
  await addXp(tx, userId, recipe.xp);
  await checkAchievements(tx, userId, ['production_runs']);

  const b = await tx.query<{ auto_repeat: boolean; type: string }>("UPDATE buildings SET status = 'idle', updated_at = now() WHERE id = $1 RETURNING auto_repeat, type", [run.building_id]);
  const building = b.rows[0];
  let repeated = false;
  if (building?.auto_repeat) {
    await tx.query('SAVEPOINT auto_repeat');
    try {
      await startProduction(tx, userId, run.building_id, run.recipe_id, true, `auto:${runId}`);
      await tx.query('RELEASE SAVEPOINT auto_repeat');
      repeated = true;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT auto_repeat');
      if (!(err instanceof GameError)) throw err;
      await tx.query('UPDATE buildings SET auto_repeat = false WHERE id = $1', [run.building_id]);
      await notifyUser(tx, userId, 'production_stopped', `${getBuildingDef(building.type)?.name ?? 'Building'}: automatic production stopped`, err.message, { buildingId: run.building_id });
    }
  }
  if (!repeated) {
    const s = await buildingSummary(tx, run.building_id).catch(() => null);
    if (s) await publish(tx, `chunk:${s.chunkKey}`, 'building', { building: s.building });
  }
  const body = lost.length ? `Storage full: ${lost.map(([res, q]) => `${(q ?? 0) - (delivered[res as ResourceId] ?? 0)} ${res}`).join(', ')} discarded.` : '';
  await publish(tx, `user:${userId}`, 'production', { buildingId: run.building_id, runId, status: 'completed', delivered, currencyOut: run.currency_out });
  if (lost.length) await notifyUser(tx, userId, 'production_overflow', `${recipe.name} completed with overflow`, body, { runId });
  await publishWallet(tx, userId);
  await publish(tx, `user:${userId}`, 'inventory', {});
  return 'completed';
}

/** Cancels a running job and returns its inputs (operating costs are not refunded). */
export async function cancelProduction(tx: Tx, userId: string, buildingId: string) {
  const b = await lockBuilding(tx, buildingId);
  if (b.owner_user_id !== userId) fail('forbidden', 'Only the owner can operate this business');
  const r = await tx.query<{ id: string; inputs: ResourceMap }>("SELECT id, inputs FROM production_runs WHERE building_id = $1 AND status = 'running' FOR UPDATE", [buildingId]);
  if (!r.rows[0]) fail('conflict', 'No production run in progress');
  await tx.query("UPDATE production_runs SET status = 'cancelled', completed_at = now() WHERE id = $1", [r.rows[0].id]);
  await addResources(tx, userId, r.rows[0].inputs, { ignoreCapacity: true });
  await tx.query("UPDATE buildings SET status = 'idle', auto_repeat = false, updated_at = now() WHERE id = $1", [buildingId]);
  await publish(tx, `user:${userId}`, 'inventory', {});
  const s = await buildingSummary(tx, buildingId);
  await publish(tx, `chunk:${s.chunkKey}`, 'building', { building: s.building });
  return { runId: r.rows[0].id, refunded: r.rows[0].inputs };
}

export async function setAutoRepeat(tx: Tx, userId: string, buildingId: string, autoRepeat: boolean) {
  const b = await lockBuilding(tx, buildingId);
  if (b.owner_user_id !== userId) fail('forbidden', 'Only the owner can operate this business');
  await tx.query('UPDATE buildings SET auto_repeat = $2 WHERE id = $1', [buildingId, autoRepeat]);
  return { buildingId, autoRepeat };
}

export async function listBusinesses(tx: Tx | import('pg').Pool, userId: string) {
  const r = await tx.query(
    `SELECT b.id, b.type, b.level, b.status, b.auto_repeat AS "autoRepeat", b.recipe_id AS "recipeId", b.parcel_id AS "parcelId",
            ST_X(b.position) AS lng, ST_Y(b.position) AS lat,
            pr.id AS "runId", pr.recipe_id AS "runRecipeId", pr.completes_at AS "completesAt", pr.started_at AS "startedAt"
       FROM buildings b LEFT JOIN production_runs pr ON pr.building_id = b.id AND pr.status = 'running'
      WHERE b.owner_user_id = $1 AND b.status IN ('idle','producing')
      ORDER BY b.created_at`,
    [userId],
  );
  return r.rows;
}

export async function recentRuns(tx: Tx | import('pg').Pool, userId: string) {
  const r = await tx.query(
    `SELECT id, building_id AS "buildingId", recipe_id AS "recipeId", inputs, outputs, currency_out AS "currencyOut", status,
            started_at AS "startedAt", completed_at AS "completedAt"
       FROM production_runs WHERE owner_user_id = $1 ORDER BY started_at DESC LIMIT 30`,
    [userId],
  );
  return r.rows;
}
