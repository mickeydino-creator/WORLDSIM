// Load test against a database (default TEST_DATABASE_URL): simulates many players concurrently
// buying land, building, trading and loading viewport chunks through the real service layer.
// Usage: npx tsx scripts/loadtest.ts [players=50]
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { loadEnv } from './env';

loadEnv();
process.env.LOG_LEVEL = 'warn';
const url = process.env.LOADTEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL not set');
const PLAYERS = Number(process.argv[2] ?? 50);

const { setPool, withTx, getPool } = await import('@/server/db');
const { pgConfig } = await import('@/server/pgconfig');
setPool(new pg.Pool({ ...pgConfig(url), max: 20 }));
const { createPlayer } = await import('@/server/services/players');
const { purchaseParcel, loadChunks } = await import('@/server/services/land');
const { placeBuilding } = await import('@/server/services/buildings');
const { placeOrder } = await import('@/server/services/market');
const { parcelIdAt, parcelCenter, chunksInBounds } = await import('@/shared/grid');

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
async function timed<T>(arr: number[], fn: () => Promise<T>): Promise<T | null> {
  const t = performance.now();
  try { return await fn(); } catch { return null; } finally { arr.push(performance.now() - t); }
}

const tag = randomUUID().slice(0, 6);
const users: string[] = [];
for (let i = 0; i < PLAYERS; i++) {
  const id = await withTx(async (tx) => {
    const u = await tx.query<{ id: string }>("INSERT INTO users (username, email, password_hash, display_name) VALUES ($1,$2,'x',$1) RETURNING id", [`lt${tag}${i}`, `lt${tag}${i}@example.com`]);
    await createPlayer(tx, u.rows[0].id);
    return u.rows[0].id;
  });
  users.push(id);
}

// Players cluster in one area (worst case for contention): ~20x20 parcels near Orleans.
const base = { lng: 1.80 + Math.random() * 0.1, lat: 47.80 + Math.random() * 0.1 };
const contested = parcelIdAt(base.lng, base.lat);
const buyT: number[] = [], buildT: number[] = [], tradeT: number[] = [], chunkT: number[] = [];
const t0 = performance.now();
const results = await Promise.all(users.map(async (u, i) => {
  // Everyone first races for the same parcel, then buys their own.
  const contestedWin = await timed(buyT, () => withTx((tx) => purchaseParcel(tx, u, contested, `${u}:c`, { name: 'Contested' })));
  const own = parcelIdAt(base.lng + (i % 20) * 0.0016, base.lat + Math.floor(i / 20) * 0.0011 + 0.002);
  const bought = await timed(buyT, () => withTx((tx) => purchaseParcel(tx, u, own, `${u}:own`, { name: 'Load test plot' })));
  if (bought) {
    const [x, y] = parcelCenter(own);
    await timed(buildT, () => withTx((tx) => placeBuilding(tx, u, { type: 'small_house', parcelId: own, lng: x, lat: y, rotation: 0 }, `${u}:b`)));
  }
  await timed(tradeT, () => withTx((tx) => placeOrder(tx, u, { side: i % 2 ? 'buy' : 'sell', resource: 'wood', pricePerUnit: 100 + (i % 7), quantity: 5, expiresHours: 1 }, `${u}:o`)));
  const keys = chunksInBounds(base.lng - 0.03, base.lat - 0.02, base.lng + 0.03, base.lat + 0.02);
  await timed(chunkT, () => loadChunks(getPool(), keys));
  return { contested: !!contestedWin, bought: !!bought };
}));
const elapsed = (performance.now() - t0) / 1000;
const ops = buyT.length + buildT.length + tradeT.length + chunkT.length;
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 50).toFixed(0)}ms p95=${pct(xs, 95).toFixed(0)}ms max=${Math.max(...xs).toFixed(0)}ms`;
console.log(`players=${PLAYERS} elapsed=${elapsed.toFixed(1)}s throughput=${(ops / elapsed).toFixed(1)} ops/s`);
console.log(`contested parcel winners: ${results.filter((r) => r.contested).length} (must be 1 unless already owned)`);
console.log(`purchase  ${fmt(buyT)}`);
console.log(`build     ${fmt(buildT)}`);
console.log(`order     ${fmt(tradeT)}`);
console.log(`chunks    ${fmt(chunkT)}  (12 chunks per viewport)`);
const bad = await getPool().query("SELECT count(*)::int AS n FROM inventories WHERE quantity < 0");
const sum = await getPool().query('SELECT sum(balance)::bigint AS s FROM accounts');
console.log(`negative inventories: ${bad.rows[0].n}; money supply sum: ${sum.rows[0].s}`);
await getPool().end();
