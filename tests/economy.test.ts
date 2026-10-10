import { beforeEach, describe, expect, it } from 'vitest';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import * as build from '@/app/api/buildings/route';
import * as production from '@/app/api/buildings/[id]/production/route';
import * as cancelProd from '@/app/api/buildings/[id]/production/cancel/route';
import * as orders from '@/app/api/market/orders/route';
import * as take from '@/app/api/market/orders/[id]/take/route';
import * as cancel from '@/app/api/market/orders/[id]/cancel/route';
import { getPool, withTx } from '@/server/db';
import { completeProduction } from '@/server/services/production';
import { accrueIncome } from '@/server/services/simulation';
import { processDueJobs } from '@/server/worker/handlers';
import { getRecipe } from '@/shared/config/recipes';
import { parcelCenter, parcelIdAt } from '@/shared/grid';
import { metersToLngLat } from '@/shared/geo';
import { RURAL, assertLedgerConsistent, balance, call, giveResources, grantTech, inventory, registerUser, resetGame, setLevel, type TestUser } from './helpers';

const pid = parcelIdAt(RURAL.lng, RURAL.lat);
const [cx, cy] = parcelCenter(pid);

async function withBuilding(type: string, dx = 0): Promise<{ u: TestUser; buildingId: string }> {
  const u = await registerUser();
  await setLevel(u.id, 5);
  expect((await call(purchase.POST, { user: u, params: { id: pid } })).status).toBe(200);
  const [x, y] = metersToLngLat([cx, cy], dx, 0);
  const r = await call(build.POST, { user: u, body: { type, parcelId: pid, lng: x, lat: y, rotation: 0 } });
  expect(r.status, JSON.stringify(r.error)).toBe(200);
  return { u, buildingId: r.data.building.id };
}

async function fastForwardJobs() {
  await getPool().query("UPDATE production_runs SET completes_at = now() - interval '1 second' WHERE status = 'running'");
  await getPool().query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending'");
  await processDueJobs();
}

describe('production', () => {
  beforeEach(resetGame);

  it('consumes inputs at start and delivers outputs via the durable worker', async () => {
    const { u, buildingId } = await withBuilding('power_facility');
    const recipe = getRecipe('generate_energy')!;
    const woodBefore = await inventory(u.id, 'wood');
    const balBefore = await balance(u.id);
    const r = await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'generate_energy' } });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(await inventory(u.id, 'wood')).toBe(woodBefore - recipe.inputs.wood!);
    expect(await balance(u.id)).toBe(balBefore - recipe.operatingCost);
    expect(await inventory(u.id, 'energy')).toBe(0);

    // Not yet due: the worker must not complete it early.
    await processDueJobs();
    expect(await inventory(u.id, 'energy')).toBe(0);

    await fastForwardJobs();
    expect(await inventory(u.id, 'energy')).toBe(recipe.outputs.energy);
    const run = await getPool().query('SELECT status FROM production_runs WHERE id = $1', [r.data.runId]);
    expect(run.rows[0].status).toBe('completed');
    await assertLedgerConsistent();
  });

  it('never completes a run twice (replayed completion is a no-op)', async () => {
    const { u, buildingId } = await withBuilding('shop');
    await giveResources(u.id, { goods: 5 });
    const r = await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'shop_sales' } });
    await getPool().query("UPDATE production_runs SET completes_at = now() WHERE id = $1", [r.data.runId]);
    const before = await balance(u.id);
    const results = await Promise.all([1, 2, 3].map(() => withTx((tx) => completeProduction(tx, r.data.runId))));
    expect(results.filter((x) => x === 'completed')).toHaveLength(1);
    expect(await balance(u.id)).toBe(before + getRecipe('shop_sales')!.currencyOut!);
    await assertLedgerConsistent();
  });

  it('rejects production without inputs and never lets inventory go negative', async () => {
    const { u, buildingId } = await withBuilding('shop');
    const r = await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'shop_sales' } });
    expect(r.error?.code).toBe('insufficient_resources');
    const neg = await getPool().query('SELECT count(*)::int AS n FROM inventories WHERE quantity < 0');
    expect(neg.rows[0].n).toBe(0);
  });

  it('a replayed start request (same idempotency key) does not double-consume', async () => {
    const { u, buildingId } = await withBuilding('power_facility');
    const woodBefore = await inventory(u.id, 'wood');
    const key = 'start-prod-key-1';
    const a = await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'generate_energy' }, key });
    const b = await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'generate_energy' }, key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.replayed).toBe(true);
    expect(await inventory(u.id, 'wood')).toBe(woodBefore - 4);
  });

  it('cancels a run and refunds inputs', async () => {
    const { u, buildingId } = await withBuilding('power_facility');
    const woodBefore = await inventory(u.id, 'wood');
    await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'generate_energy' } });
    const c = await call(cancelProd.POST, { user: u, params: { id: buildingId } });
    expect(c.status).toBe(200);
    expect(await inventory(u.id, 'wood')).toBe(woodBefore);
    await fastForwardJobs();
    expect(await inventory(u.id, 'energy')).toBe(0);
  });

  it('enforces research requirements on recipes', async () => {
    const { u, buildingId } = await withBuilding('quarry');
    await giveResources(u.id, { energy: 10 });
    const r = await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'quarry_ore' } });
    expect(r.error?.code).toBe('requirements_not_met');
    await grantTech(u.id, 'mining');
    expect((await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'quarry_ore' } })).status).toBe(200);
  });

  it('auto-repeat keeps producing while the player is offline', async () => {
    const { u, buildingId } = await withBuilding('lumber_camp');
    await call(production.POST, { user: u, params: { id: buildingId }, body: { recipeId: 'harvest_wood', autoRepeat: true } });
    const w0 = await inventory(u.id, 'wood');
    await fastForwardJobs();
    await fastForwardJobs();
    expect(await inventory(u.id, 'wood')).toBe(w0 + 24);
    const runs = await getPool().query("SELECT count(*)::int AS n FROM production_runs WHERE building_id = $1", [buildingId]);
    expect(runs.rows[0].n).toBe(3);
  });
});

describe('simulation income', () => {
  beforeEach(resetGame);

  it('accrues rent exactly once per elapsed period', async () => {
    const { u, buildingId } = await withBuilding('small_house');
    await getPool().query("UPDATE buildings SET income_at = now() - interval '60 minutes' WHERE id = $1", [buildingId]);
    const before = await balance(u.id);
    await Promise.all([withTx((tx) => accrueIncome(tx, 'a')), withTx((tx) => accrueIncome(tx, 'b'))]);
    await withTx((tx) => accrueIncome(tx, 'c'));
    const gained = (await balance(u.id)) - before;
    // One hour of 120 CR/h rent (plus at most one extra minute if the clock ticked over).
    expect(gained).toBeGreaterThanOrEqual(120_00);
    expect(gained).toBeLessThanOrEqual(120_00 + 200);
    await assertLedgerConsistent();
  });
});

describe('marketplace', () => {
  beforeEach(resetGame);

  it('matches a buy against a sell, transferring goods, credits and the fee consistently', async () => {
    const seller = await registerUser();
    const buyer = await registerUser();
    const sBal = await balance(seller.id);
    const bBal = await balance(buyer.id);
    const s = await call(orders.POST, { user: seller, body: { side: 'sell', resource: 'stone', pricePerUnit: 500, quantity: 50, expiresHours: 24 } });
    expect(s.status).toBe(200);
    expect(await inventory(seller.id, 'stone')).toBe(30);
    const b = await call(orders.POST, { user: buyer, body: { side: 'buy', resource: 'stone', pricePerUnit: 600, quantity: 20, expiresHours: 24 } });
    expect(b.status).toBe(200);
    expect(b.data.trades).toHaveLength(1);
    expect(b.data.order.status).toBe('filled');
    expect(await inventory(buyer.id, 'stone')).toBe(80 + 20);
    // Executed at the resting (maker) price; buyer gets the price improvement back.
    expect(await balance(buyer.id)).toBe(bBal - 500 * 20);
    const fee = Math.floor((500 * 20 * 200) / 10_000);
    expect(await balance(seller.id)).toBe(sBal + 500 * 20 - fee);
    await assertLedgerConsistent();
  });

  it('cancels an order and returns escrowed goods', async () => {
    const u = await registerUser();
    const s = await call(orders.POST, { user: u, body: { side: 'sell', resource: 'wood', pricePerUnit: 100, quantity: 100, expiresHours: 24 } });
    expect(await inventory(u.id, 'wood')).toBe(20);
    const other = await registerUser();
    expect((await call(cancel.POST, { user: other, params: { id: s.data.order.id } })).status).toBe(403);
    expect((await call(cancel.POST, { user: u, params: { id: s.data.order.id } })).status).toBe(200);
    expect(await inventory(u.id, 'wood')).toBe(120);
    expect((await call(cancel.POST, { user: u, params: { id: s.data.order.id } })).status).toBe(409);
  });

  it('cannot oversell: concurrent takers never receive more than the order holds', async () => {
    const seller = await registerUser();
    const s = await call(orders.POST, { user: seller, body: { side: 'sell', resource: 'wood', pricePerUnit: 100, quantity: 30, expiresHours: 24 } });
    const buyers = await Promise.all(Array.from({ length: 6 }, () => registerUser()));
    const res = await Promise.all(buyers.map((b) => call(take.POST, { user: b, params: { id: s.data.order.id }, body: { quantity: 10 } })));
    const filled = res.filter((r) => r.status === 200).reduce((sum, r) => sum + (r.data.trades as { quantity: number }[]).reduce((a, t) => a + t.quantity, 0), 0);
    expect(filled).toBe(30);
    const total = (await Promise.all(buyers.map((b) => inventory(b.id, 'wood')))).reduce((a, b) => a + b, 0);
    expect(total).toBe(6 * 120 + 30);
    await assertLedgerConsistent();
  });

  it('cannot overspend: concurrent buy orders beyond the balance are rejected', async () => {
    const u = await registerUser();
    const bal = await balance(u.id);
    const each = Math.floor(bal / 3) + 1; // three of these exceed the wallet
    const res = await Promise.all([0, 1, 2].map(() => call(orders.POST, { user: u, body: { side: 'buy', resource: 'metal', pricePerUnit: each, quantity: 1, expiresHours: 24 } })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(2);
    expect(res.filter((r) => r.error?.code === 'insufficient_funds')).toHaveLength(1);
    expect(await balance(u.id)).toBeGreaterThanOrEqual(0);
    await assertLedgerConsistent();
  });

  it('expires stale orders through the worker and releases escrow', async () => {
    const u = await registerUser();
    const bal = await balance(u.id);
    const o = await call(orders.POST, { user: u, body: { side: 'buy', resource: 'agri', pricePerUnit: 100, quantity: 10, expiresHours: 1 } });
    expect(await balance(u.id)).toBe(bal - 1000);
    await getPool().query("UPDATE market_orders SET expires_at = now() - interval '1 second' WHERE id = $1", [o.data.order.id]);
    await getPool().query("INSERT INTO jobs (type, payload) VALUES ('market.expire', '{}')");
    await processDueJobs();
    expect(await balance(u.id)).toBe(bal);
    const st = await getPool().query('SELECT status FROM market_orders WHERE id = $1', [o.data.order.id]);
    expect(st.rows[0].status).toBe('expired');
    await assertLedgerConsistent();
  });

  it('prevents self-trading', async () => {
    const u = await registerUser();
    const s = await call(orders.POST, { user: u, body: { side: 'sell', resource: 'wood', pricePerUnit: 100, quantity: 10, expiresHours: 24 } });
    const t = await call(take.POST, { user: u, params: { id: s.data.order.id }, body: { quantity: 5 } });
    expect(t.status).toBe(400);
  });
});
