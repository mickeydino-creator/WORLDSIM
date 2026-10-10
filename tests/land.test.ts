import { beforeEach, describe, expect, it } from 'vitest';
import * as me from '@/app/api/me/route';
import * as chunks from '@/app/api/world/chunks/route';
import * as parcel from '@/app/api/parcels/[id]/route';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import { getPool } from '@/server/db';
import { STARTING_BALANCE } from '@/shared/config/resources';
import { chunkKeyAt, parcelIdAt } from '@/shared/grid';
import { RURAL, assertLedgerConsistent, balance, call, registerUser, resetGame } from './helpers';

const pid = parcelIdAt(RURAL.lng, RURAL.lat);

describe('authentication', () => {
  beforeEach(resetGame);

  it('registers a player with a persistent wallet and restores state for a returning session', async () => {
    const u = await registerUser('alice');
    const r = await call(me.GET, { user: u, method: 'GET' });
    expect(r.status).toBe(200);
    expect(r.data.username).toBe('alice');
    expect(r.data.balance).toBe(STARTING_BALANCE);
    await assertLedgerConsistent();
  });

  it('rejects protected actions without a session', async () => {
    const r = await call(purchase.POST, { body: { name: 'Test land' }, params: { id: pid } });
    expect(r.status).toBe(401);
    const g = await call(me.GET, { method: 'GET' });
    expect(g.status).toBe(401);
  });

  it('rejects a forged session cookie (no impersonation)', async () => {
    const r = await call(me.GET, { method: 'GET', user: { id: 'x', username: 'x', cookie: 'ws_session=forged-token' } });
    expect(r.status).toBe(401);
  });

  it('rejects cross-origin mutations', async () => {
    const u = await registerUser();
    const r = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: pid }, origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });
});

describe('land ownership', () => {
  beforeEach(resetGame);

  it('purchases an available parcel, deducts the authoritative price, and persists ownership', async () => {
    const u = await registerUser();
    const details = await call(parcel.GET, { user: u, method: 'GET', params: { id: pid } });
    expect(details.data.status).toBe('available');
    const price = details.data.price as number;
    expect(price).toBeGreaterThan(0);

    const r = await call(purchase.POST, { user: u, params: { id: pid }, body: { name: 'Test land' } });
    expect(r.status).toBe(200);
    expect(r.data.price).toBe(price);
    expect(await balance(u.id)).toBe(STARTING_BALANCE - price);

    // "Reload": a fresh read from the database shows the same ownership.
    const after = await call(parcel.GET, { user: u, method: 'GET', params: { id: pid } });
    expect(after.data.status).toBe('mine');
    const world = await call(chunks.GET, { user: u, method: 'GET', query: `?keys=${chunkKeyAt(RURAL.lng, RURAL.lat)}` });
    expect(world.data.chunks[0].parcels.map((p: { id: string }) => p.id)).toContain(pid);
    await assertLedgerConsistent();
  });

  it('ignores client-supplied prices: maxPrice below the real price is rejected', async () => {
    const u = await registerUser();
    const r = await call(purchase.POST, { user: u, params: { id: pid }, body: { name: 'Test land', maxPrice: 1 } });
    expect(r.status).toBe(409);
    expect(await balance(u.id)).toBe(STARTING_BALANCE);
  });

  it('refuses to sell an already-owned parcel', async () => {
    const a = await registerUser();
    const b = await registerUser();
    expect((await call(purchase.POST, { body: { name: 'Test land' }, user: a, params: { id: pid } })).status).toBe(200);
    const r = await call(purchase.POST, { body: { name: 'Test land' }, user: b, params: { id: pid } });
    expect(r.status).toBe(409);
    expect(r.error?.code).toBe('unavailable');
    expect(await balance(b.id)).toBe(STARTING_BALANCE);
  });

  it('refuses water and restricted land', async () => {
    const u = await registerUser();
    const sea = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: parcelIdAt(-30, 40) } });
    expect(sea.error?.code).toBe('unavailable');
    const ant = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: parcelIdAt(0, -75) } });
    expect(ant.error?.code).toBe('restricted');
  });

  it('refuses purchases with insufficient funds', async () => {
    const u = await registerUser();
    await getPool().query("UPDATE accounts SET balance = 100 WHERE user_id = $1", [u.id]);
    // keep ledger-consistency out of this test: we forced the balance directly
    const r = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: pid } });
    expect(r.status).toBe(402);
    expect(r.error?.code).toBe('insufficient_funds');
    const p = await getPool().query('SELECT owner_user_id FROM parcels WHERE id = $1', [pid]);
    expect(p.rows[0]?.owner_user_id ?? null).toBeNull();
  });

  it('lets exactly one of many simultaneous buyers win', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => registerUser()));
    const results = await Promise.all(users.map((u) => call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: pid } })));
    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const balances = await Promise.all(users.map((u) => balance(u.id)));
    expect(balances.filter((b) => b < STARTING_BALANCE)).toHaveLength(1);
    const hist = await getPool().query('SELECT count(*)::int AS n FROM parcel_ownership_history WHERE parcel_id = $1', [pid]);
    expect(hist.rows[0].n).toBe(1);
    await assertLedgerConsistent();
  });

  it('replays an idempotent purchase without charging twice', async () => {
    const u = await registerUser();
    const key = 'purchase-key-123';
    const a = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: pid }, key });
    const b = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: pid }, key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.data).toEqual(a.data);
    expect(await balance(u.id)).toBe(STARTING_BALANCE - a.data.price);
  });

  it('requires an idempotency key on mutations', async () => {
    const u = await registerUser();
    const r = await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: pid }, key: null });
    expect(r.status).toBe(400);
  });
});
