import { beforeEach, describe, expect, it } from 'vitest';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import * as permissions from '@/app/api/parcels/[id]/permissions/route';
import * as build from '@/app/api/buildings/route';
import * as buildingGet from '@/app/api/buildings/[id]/route';
import * as upgrade from '@/app/api/buildings/[id]/upgrade/route';
import * as demolish from '@/app/api/buildings/[id]/demolish/route';
import * as chunks from '@/app/api/world/chunks/route';
import { getBuildingDef } from '@/shared/config/buildings';
import { chunkKeyAt, parcelCenter, parcelIdAt } from '@/shared/grid';
import { metersToLngLat } from '@/shared/geo';
import { STARTING_BALANCE } from '@/shared/config/resources';
import { RURAL, assertLedgerConsistent, balance, call, inventory, registerUser, resetGame, setLevel, type TestUser } from './helpers';

const pid = parcelIdAt(RURAL.lng, RURAL.lat);
const [cx, cy] = parcelCenter(pid);

async function owner(): Promise<TestUser> {
  const u = await registerUser();
  expect((await call(purchase.POST, { user: u, params: { id: pid } })).status).toBe(200);
  return u;
}

describe('construction', () => {
  beforeEach(resetGame);

  it('builds on owned land, charges cost and resources, and the building survives a reload', async () => {
    const u = await owner();
    const before = await balance(u.id);
    const woodBefore = await inventory(u.id, 'wood');
    const r = await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 90 } });
    expect(r.status).toBe(200);
    const def = getBuildingDef('small_house')!;
    expect(await balance(u.id)).toBe(before - def.cost);
    expect(await inventory(u.id, 'wood')).toBe(woodBefore - def.resources.wood!);

    const world = await call(chunks.GET, { user: u, method: 'GET', query: `?keys=${chunkKeyAt(cx, cy)}` });
    const b = world.data.chunks[0].buildings.find((x: { id: string }) => x.id === r.data.building.id);
    expect(b).toMatchObject({ type: 'small_house', parcelId: pid, rotation: 90, ownerId: u.id });
    await assertLedgerConsistent();
  });

  it('rejects overlapping placements', async () => {
    const u = await owner();
    expect((await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 } })).status).toBe(200);
    const [x, y] = metersToLngLat([cx, cy], 4, 0);
    const r = await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: x, lat: y, rotation: 0 } });
    expect(r.status).toBe(422);
    expect(r.error?.message).toMatch(/Overlaps/);
  });

  it('allows adjacent, non-overlapping placements', async () => {
    const u = await owner();
    expect((await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 } })).status).toBe(200);
    const [x, y] = metersToLngLat([cx, cy], 20, 0);
    expect((await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: x, lat: y, rotation: 0 } })).status).toBe(200);
  });

  it('rejects buildings that extend outside the parcel', async () => {
    const u = await owner();
    const [x, y] = metersToLngLat([cx, cy], 52, 0);
    const r = await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: x, lat: y, rotation: 0 } });
    expect(r.status).toBe(422);
  });

  it("forbids building on another player's land unless permitted", async () => {
    const a = await owner();
    const b = await registerUser();
    const body = { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 };
    const denied = await call(build.POST, { user: b, body });
    expect(denied.status).toBe(403);
    expect(await balance(b.id)).toBe(STARTING_BALANCE);
    expect((await call(permissions.POST, { user: a, params: { id: pid }, body: { username: b.username, grant: true } })).status).toBe(200);
    expect((await call(build.POST, { user: b, body })).status).toBe(200);
  });

  it('enforces level, research and land-class requirements', async () => {
    const u = await owner();
    const apt = await call(build.POST, { user: u, body: { type: 'apartment_building', parcelId: pid, lng: cx, lat: cy, rotation: 0 } });
    expect(apt.error?.code).toBe('requirements_not_met');
    const urban = parcelIdAt(34.7818, 32.0853);
    expect((await call(purchase.POST, { user: u, params: { id: urban } })).status).toBe(200);
    const [ux, uy] = parcelCenter(urban);
    const farm = await call(build.POST, { user: u, body: { type: 'farm', parcelId: urban, lng: ux, lat: uy, rotation: 0 } });
    expect(farm.error?.code).toBe('requirements_not_met');
  });

  it('rejects unknown building types and malformed input', async () => {
    const u = await owner();
    expect((await call(build.POST, { user: u, body: { type: 'death_star', parcelId: pid, lng: cx, lat: cy, rotation: 0 } })).status).toBe(400);
    expect((await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: 'x', lat: cy, rotation: 0 } })).status).toBe(400);
  });

  it('upgrades and demolishes owned buildings with refunds', async () => {
    const u = await owner();
    const r = await call(build.POST, { user: u, body: { type: 'park', parcelId: pid, lng: cx, lat: cy, rotation: 0 } });
    const id = r.data.building.id;
    const up = await call(upgrade.POST, { user: u, params: { id } });
    expect(up.status).toBe(200);
    expect(up.data.building.level).toBe(2);
    const other = await registerUser();
    expect((await call(demolish.POST, { user: other, params: { id } })).status).toBe(403);
    const before = await balance(u.id);
    const d = await call(demolish.POST, { user: u, params: { id } });
    expect(d.status).toBe(200);
    expect(await balance(u.id)).toBe(before + d.data.refund);
    expect((await call(buildingGet.GET, { user: u, method: 'GET', params: { id } })).status).toBe(404);
    await assertLedgerConsistent();
  });

  it('serialises concurrent overlapping placements: only one succeeds', async () => {
    const u = await owner();
    await setLevel(u.id, 2);
    const attempts = await Promise.all(
      [0, 3, 6, -3].map((dx) => {
        const [x, y] = metersToLngLat([cx, cy], dx, 0);
        return call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: x, lat: y, rotation: 0 } });
      }),
    );
    expect(attempts.filter((a) => a.status === 200)).toHaveLength(1);
  });
});
