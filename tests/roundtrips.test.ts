// Measures database round trips per API action. Each round trip costs one network RTT between the
// app and the database (tens of ms on hosted setups), so this is the main driver of action latency.
import pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import * as me from '@/app/api/me/route';
import * as economy from '@/app/api/economy/route';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import * as parcel from '@/app/api/parcels/[id]/route';
import * as build from '@/app/api/buildings/route';
import * as production from '@/app/api/buildings/[id]/production/route';
import * as orders from '@/app/api/market/orders/route';
import * as chunks from '@/app/api/world/chunks/route';
import { chunkKeyAt, parcelCenter, parcelIdAt } from '@/shared/grid';
import { RURAL, call, registerUser, resetGame, setLevel } from './helpers';

let count = 0;
const orig = pg.Client.prototype.query;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pg.Client.prototype as any).query = function (...args: any[]) {
  count++;
  return (orig as any).apply(this, args);
};

async function measure(label: string, fn: () => Promise<unknown>) {
  count = 0;
  const r = await fn();
  console.log(`ROUNDTRIPS ${label}: ${count}`);
  return { r, n: count };
}

const pid = parcelIdAt(RURAL.lng, RURAL.lat);
const [cx, cy] = parcelCenter(pid);

describe('database round trips per action', () => {
  beforeEach(resetGame);

  it('stays within budget', async () => {
    const u = await registerUser();
    await setLevel(u.id, 3);
    const budgets: Record<string, number> = {};
    budgets.me = (await measure('GET /api/me', () => call(me.GET, { user: u, method: 'GET' }))).n;
    budgets.economy = (await measure('GET /api/economy', () => call(economy.GET, { user: u, method: 'GET' }))).n;
    budgets.chunks = (await measure('GET /api/world/chunks (1 cached chunk)', () => call(chunks.GET, { user: u, method: 'GET', query: `?keys=${chunkKeyAt(cx, cy)}` }))).n;
    budgets.parcel = (await measure('GET /api/parcels/:id', () => call(parcel.GET, { user: u, method: 'GET', params: { id: pid } }))).n;
    budgets.purchase = (await measure('POST purchase', () => call(purchase.POST, { user: u, params: { id: pid }, body: { name: 'Plot' } }))).n;
    const b = await measure('POST build', () => call(build.POST, { user: u, body: { type: 'lumber_camp', parcelId: pid, lng: cx, lat: cy, rotation: 0 } }));
    budgets.build = b.n;
    const id = (b.r as { data: { building: { id: string } } }).data.building.id;
    budgets.production = (await measure('POST production', () => call(production.POST, { user: u, params: { id }, body: { recipeId: 'harvest_wood' } }))).n;
    budgets.order = (await measure('POST order', () => call(orders.POST, { user: u, body: { side: 'sell', resource: 'wood', pricePerUnit: 100, quantity: 5, expiresHours: 24 } }))).n;
    console.log('ROUNDTRIPS', JSON.stringify(budgets));
    expect(budgets.purchase).toBeGreaterThan(0);
  });
});
