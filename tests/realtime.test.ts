import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import * as build from '@/app/api/buildings/route';
import { RealtimeHub } from '@/server/realtime';
import { chunkKeyAt, parcelCenter, parcelIdAt } from '@/shared/grid';
import { RURAL, balance, call, registerUser, resetGame, type TestUser } from './helpers';

const pid = parcelIdAt(RURAL.lng, RURAL.lat);
const [cx, cy] = parcelCenter(pid);
const chunk = chunkKeyAt(cx, cy);

let server: Server;
let hub: RealtimeHub;
let port: number;

beforeAll(async () => {
  hub = new RealtimeHub();
  await hub.start();
  server = createServer();
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await hub.stop();
  server.close();
});

interface Conn { ws: WebSocket; messages: any[]; waitFor: (pred: (m: any) => boolean, ms?: number) => Promise<any> }

function connect(user?: TestUser, origin = 'http://test.local'): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { origin };
    if (user) headers.cookie = user.cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const messages: any[] = [];
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
    const waitFor = (pred: (m: any) => boolean, ms = 5000) => {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
      });
    };
    ws.on('open', () => resolve({ ws, messages, waitFor }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

describe('realtime multiplayer', () => {
  beforeEach(resetGame);

  it('rejects unauthenticated connections and foreign origins', async () => {
    await expect(connect()).rejects.toThrow(/401/);
    const u = await registerUser();
    await expect(connect(u, 'http://evil.example')).rejects.toThrow(/401/);
  });

  it("refuses subscriptions to another player's private channel", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const c = await connect(a);
    c.ws.send(JSON.stringify({ type: 'subscribe', channels: [`user:${b.id}`, `chunk:${chunk}`] }));
    const ack = await c.waitFor((m) => m.type === 'subscribed');
    expect(ack.channels).toEqual([`chunk:${chunk}`]);
    c.ws.close();
  });

  it('broadcasts committed building and ownership changes to other subscribed players without economic side effects', async () => {
    const builder = await registerUser();
    const observer = await registerUser();
    const obs = await connect(observer);
    obs.ws.send(JSON.stringify({ type: 'subscribe', channels: [`chunk:${chunk}`] }));
    await obs.waitFor((m) => m.type === 'subscribed');
    const obsBalance = await balance(observer.id);

    expect((await call(purchase.POST, { user: builder, params: { id: pid } })).status).toBe(200);
    const parcelEvt = await obs.waitFor((m) => m.type === 'event' && m.event === 'parcel');
    expect(parcelEvt.payload).toMatchObject({ id: pid, ownerId: builder.id });

    const r = await call(build.POST, { user: builder, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 } });
    expect(r.status).toBe(200);
    const evt = await obs.waitFor((m) => m.type === 'event' && m.event === 'building');
    expect(evt.payload.building).toMatchObject({ id: r.data.building.id, type: 'small_house', ownerId: builder.id });
    expect(await balance(observer.id)).toBe(obsBalance);
    obs.ws.close();
  });

  it('does not broadcast rolled-back changes', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const obs = await connect(b);
    obs.ws.send(JSON.stringify({ type: 'subscribe', channels: [`chunk:${chunk}`] }));
    await obs.waitFor((m) => m.type === 'subscribed');
    // Building without owning the parcel fails -> transaction rolls back -> no event.
    expect((await call(build.POST, { user: a, body: { type: 'small_house', parcelId: pid, lng: cx, lat: cy, rotation: 0 } })).status).toBe(403);
    await new Promise((r) => setTimeout(r, 300));
    expect(obs.messages.filter((m) => m.type === 'event' && m.channel === `chunk:${chunk}`)).toHaveLength(0);
    obs.ws.close();
  });

  it('replays missed events after reconnecting (resync)', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const first = await connect(b);
    const hello = await first.waitFor((m) => m.type === 'hello');
    first.ws.close();
    // Changes happen while b is offline.
    expect((await call(purchase.POST, { user: a, params: { id: pid } })).status).toBe(200);
    expect((await call(build.POST, { user: a, body: { type: 'park', parcelId: pid, lng: cx, lat: cy, rotation: 0 } })).status).toBe(200);
    const again = await connect(b);
    again.ws.send(JSON.stringify({ type: 'subscribe', channels: [`chunk:${chunk}`] }));
    await again.waitFor((m) => m.type === 'subscribed');
    again.ws.send(JSON.stringify({ type: 'resync', since: hello.lastEventId }));
    await again.waitFor((m) => m.type === 'resynced');
    const replayed = again.messages.filter((m) => m.replay);
    expect(replayed.map((m) => m.event)).toEqual(expect.arrayContaining(['parcel', 'building']));
    again.ws.close();
  });

  it('stops delivering settlement events to removed members', async () => {
    const { getPool } = await import('@/server/db');
    const founder = await registerUser();
    const member = await registerUser();
    const s = await getPool().query<{ id: string }>(
      `INSERT INTO settlements (name, founder_user_id, center, governance) VALUES ($1, $2, ST_SetSRID(ST_MakePoint(0,0),4326), '{}') RETURNING id`,
      [`S${member.username}`, founder.id],
    );
    const sid = s.rows[0].id;
    await getPool().query("INSERT INTO settlement_members (settlement_id, user_id, role) VALUES ($1,$2,'founder'),($1,$3,'member')", [sid, founder.id, member.id]);
    const c = await connect(member);
    c.ws.send(JSON.stringify({ type: 'subscribe', channels: [`settlement:${sid}`] }));
    expect((await c.waitFor((m) => m.type === 'subscribed')).channels).toEqual([`settlement:${sid}`]);
    const { withTx } = await import('@/server/db');
    const { publish } = await import('@/server/events');
    await withTx((tx) => publish(tx, `settlement:${sid}`, 'vote', { n: 1 }));
    await c.waitFor((m) => m.type === 'event' && m.payload.n === 1);
    await getPool().query('DELETE FROM settlement_members WHERE user_id = $1', [member.id]);
    await withTx((tx) => publish(tx, `settlement:${sid}`, 'activity', { n: 2 }));
    await new Promise((r) => setTimeout(r, 400));
    expect(c.messages.some((m) => m.type === 'event' && m.payload.n === 2)).toBe(false);
    c.ws.close();
  });

  it('tracks transient presence per chunk', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const ca = await connect(a);
    const cb = await connect(b);
    for (const c of [ca, cb]) {
      c.ws.send(JSON.stringify({ type: 'subscribe', channels: [`chunk:${chunk}`] }));
      await c.waitFor((m) => m.type === 'subscribed');
    }
    ca.ws.send(JSON.stringify({ type: 'presence', chunk }));
    const p = await cb.waitFor((m) => m.type === 'presence' && m.users.some((u: { id: string }) => u.id === a.id));
    expect(p.chunk).toBe(chunk);
    ca.ws.close();
    cb.ws.close();
  });
});
