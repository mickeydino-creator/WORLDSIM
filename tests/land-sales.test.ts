import { beforeEach, describe, expect, it } from 'vitest';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import * as rename from '@/app/api/parcels/[id]/rename/route';
import * as sell from '@/app/api/parcels/[id]/sell/route';
import * as listing from '@/app/api/parcels/[id]/listing/route';
import * as cancelListing from '@/app/api/parcels/[id]/listing/cancel/route';
import * as buyListing from '@/app/api/parcels/[id]/buy-listing/route';
import * as listings from '@/app/api/listings/route';
import * as parcel from '@/app/api/parcels/[id]/route';
import * as build from '@/app/api/buildings/route';
import * as production from '@/app/api/buildings/[id]/production/route';
import * as settlements from '@/app/api/settlements/route';
import * as invites from '@/app/api/settlements/[id]/invites/route';
import * as respond from '@/app/api/invites/[id]/respond/route';
import * as projects from '@/app/api/settlements/[id]/projects/route';
import * as contribute from '@/app/api/projects/[id]/contribute/route';
import * as dissolve from '@/app/api/settlements/[id]/dissolve/route';
import * as settlementGet from '@/app/api/settlements/[id]/route';
import { getPool } from '@/server/db';
import { parcelCenter, parcelIdAt } from '@/shared/grid';
import { metersToLngLat } from '@/shared/geo';
import { STARTING_BALANCE } from '@/shared/config/resources';
import { RURAL, assertLedgerConsistent, balance, call, registerUser, resetGame, setLevel } from './helpers';

const pid = parcelIdAt(RURAL.lng, RURAL.lat);
const [cx, cy] = parcelCenter(pid);

describe('land names', () => {
  beforeEach(resetGame);

  it('requires a name to buy land and lets the owner rename it', async () => {
    const u = await registerUser();
    expect((await call(purchase.POST, { user: u, params: { id: pid }, body: {} })).status).toBe(400);
    expect((await call(purchase.POST, { user: u, params: { id: pid }, body: { name: '   ' } })).status).toBe(400);
    expect((await call(purchase.POST, { user: u, params: { id: pid }, body: { name: 'Green Acres' } })).status).toBe(200);
    expect((await call(parcel.GET, { user: u, method: 'GET', params: { id: pid } })).data.name).toBe('Green Acres');
    const other = await registerUser();
    expect((await call(rename.POST, { user: other, params: { id: pid }, body: { name: 'Mine now' } })).status).toBe(403);
    expect((await call(rename.POST, { user: u, params: { id: pid }, body: { name: 'Golden Field' } })).status).toBe(200);
    expect((await call(parcel.GET, { user: u, method: 'GET', params: { id: pid } })).data.name).toBe('Golden Field');
  });
});

describe('selling land', () => {
  beforeEach(resetGame);

  it('sells land and buildings to the land office for less than was paid; the parcel becomes available', async () => {
    const u = await registerUser();
    const bought = await call(purchase.POST, { user: u, params: { id: pid }, body: { name: 'Home' } });
    expect((await call(build.POST, { user: u, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 } })).status).toBe(200);
    const quote = (await call(parcel.GET, { user: u, method: 'GET', params: { id: pid } })).data.quickSale;
    expect(quote.total).toBeGreaterThan(0);
    const before = await balance(u.id);
    const r = await call(sell.POST, { user: u, params: { id: pid } });
    expect(r.status).toBe(200);
    expect(r.data.received).toBe(quote.total);
    expect(await balance(u.id)).toBe(before + quote.total);
    expect(await balance(u.id)).toBeLessThan(STARTING_BALANCE); // selling never profits
    expect(r.data.received).toBeLessThan(bought.data.price + 2_000_00);
    const after = await call(parcel.GET, { user: u, method: 'GET', params: { id: pid } });
    expect(after.data.status).toBe('available');
    expect(after.data.buildings).toHaveLength(0);
    // Selling twice is refused.
    expect((await call(sell.POST, { user: u, params: { id: pid } })).status).toBe(403);
    await assertLedgerConsistent();
  });

  it('refuses a quick sale while production is running', async () => {
    const u = await registerUser();
    await setLevel(u.id, 2);
    await call(purchase.POST, { user: u, params: { id: pid }, body: { name: 'Camp' } });
    const b = await call(build.POST, { user: u, body: { type: 'lumber_camp', parcelId: pid, lng: cx, lat: cy, rotation: 0 } });
    await call(production.POST, { user: u, params: { id: b.data.building.id }, body: { recipeId: 'harvest_wood' } });
    expect((await call(sell.POST, { user: u, params: { id: pid } })).status).toBe(409);
  });

  it('lists land for players; a buyer pays the listing price and receives the land with its houses', async () => {
    const seller = await registerUser();
    const buyer = await registerUser();
    await call(purchase.POST, { user: seller, params: { id: pid }, body: { name: 'Seaview' } });
    const house = await call(build.POST, { user: seller, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 } });
    expect((await call(listing.POST, { user: buyer, params: { id: pid }, body: { price: 10_000_00 } })).status).toBe(403);
    expect((await call(listing.POST, { user: seller, params: { id: pid }, body: { price: 10_000_00 } })).status).toBe(200);
    const list = await call(listings.GET, { user: buyer, method: 'GET' });
    expect(list.data.listings.map((l: { parcelId: string }) => l.parcelId)).toContain(pid);
    // Client cannot lower the price: maxPrice below the asking price is refused.
    expect((await call(buyListing.POST, { user: buyer, params: { id: pid }, body: { name: 'Bargain', maxPrice: 100 } })).status).toBe(409);
    expect((await call(buyListing.POST, { user: buyer, params: { id: pid }, body: {} })).status).toBe(400);
    const sBefore = await balance(seller.id);
    const bBefore = await balance(buyer.id);
    const r = await call(buyListing.POST, { user: buyer, params: { id: pid }, body: { name: 'My Seaview' } });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(await balance(buyer.id)).toBe(bBefore - 10_000_00);
    expect(await balance(seller.id)).toBe(sBefore + 10_000_00 - r.data.fee);
    const after = await call(parcel.GET, { user: buyer, method: 'GET', params: { id: pid } });
    expect(after.data).toMatchObject({ status: 'mine', name: 'My Seaview', listingPrice: null });
    const b = await getPool().query('SELECT owner_user_id FROM buildings WHERE id = $1', [house.data.building.id]);
    expect(b.rows[0].owner_user_id).toBe(buyer.id);
    await assertLedgerConsistent();
  });

  it('a listing can be cancelled, and only one of two simultaneous buyers succeeds', async () => {
    const seller = await registerUser();
    await call(purchase.POST, { user: seller, params: { id: pid }, body: { name: 'Hot property' } });
    await call(listing.POST, { user: seller, params: { id: pid }, body: { price: 5_000_00 } });
    expect((await call(cancelListing.POST, { user: seller, params: { id: pid } })).status).toBe(200);
    const b1 = await registerUser();
    expect((await call(buyListing.POST, { user: b1, params: { id: pid }, body: { name: 'X' } })).status).toBe(409);
    await call(listing.POST, { user: seller, params: { id: pid }, body: { price: 5_000_00 } });
    const buyers = await Promise.all([registerUser(), registerUser(), registerUser()]);
    const res = await Promise.all(buyers.map((b) => call(buyListing.POST, { user: b, params: { id: pid }, body: { name: 'Race' } })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    const charged = (await Promise.all(buyers.map((b) => balance(b.id)))).filter((x) => x < STARTING_BALANCE);
    expect(charged).toHaveLength(1);
    await assertLedgerConsistent();
  });
});

describe('dissolving settlements', () => {
  beforeEach(resetGame);

  it('founder dissolves: projects refunded, treasury split, land and buildings returned to the founder', async () => {
    const f = await registerUser();
    await setLevel(f.id, 3);
    await call(purchase.POST, { user: f, params: { id: pid }, body: { name: 'Founding plot' } });
    const s = await call(settlements.POST, { user: f, body: { name: 'Shortlived', description: '', parcelId: pid } });
    const sid = s.data.id;
    const m = await registerUser();
    const inv = await call(invites.POST, { user: f, params: { id: sid }, body: { username: m.username } });
    await call(respond.POST, { user: m, params: { id: inv.data.inviteId }, body: { accept: true } });
    const p = await call(projects.POST, { user: m, params: { id: sid }, body: { type: 'public_park', name: 'Park', parcelId: pid, lng: cx, lat: cy, rotation: 0 } });
    const mBefore = await balance(m.id);
    await call(contribute.POST, { user: m, params: { id: p.data.projectId }, body: { currency: 500_00 } });
    expect(await balance(m.id)).toBe(mBefore - 500_00);
    const [px, py] = metersToLngLat([cx, cy], 30, 30);
    expect((await call(build.POST, { user: f, body: { type: 'park', parcelId: pid, lng: px, lat: py, rotation: 0 } })).status).toBe(200);

    expect((await call(dissolve.POST, { user: m, params: { id: sid }, body: { confirmName: 'Shortlived' } })).status).toBe(403);
    expect((await call(dissolve.POST, { user: f, params: { id: sid }, body: { confirmName: 'Wrong' } })).status).toBe(400);
    const r = await call(dissolve.POST, { user: f, params: { id: sid }, body: { confirmName: 'shortlived' } });
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    // Member got the project refund plus half of the 5,000 CR treasury.
    expect(await balance(m.id)).toBe(mBefore + 2_500_00);
    const parcelRow = await getPool().query('SELECT owner_user_id, settlement_id FROM parcels WHERE id = $1', [pid]);
    expect(parcelRow.rows[0]).toEqual({ owner_user_id: f.id, settlement_id: null });
    const bld = await getPool().query('SELECT count(*)::int AS n FROM buildings WHERE owner_user_id = $1 AND parcel_id = $2', [f.id, pid]);
    expect(bld.rows[0].n).toBe(1);
    expect((await call(settlementGet.GET, { user: f, method: 'GET', params: { id: sid } })).status).toBe(404);
    // The name can be reused and both players can found or join again.
    await setLevel(m.id, 3);
    const second = parcelIdAt(...metersToLngLat([cx, cy], 150, 0));
    await call(purchase.POST, { user: m, params: { id: second }, body: { name: 'New start' } });
    expect((await call(settlements.POST, { user: m, body: { name: 'Shortlived', description: '', parcelId: second } })).status).toBe(200);
    await assertLedgerConsistent();
  });
});
