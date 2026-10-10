import { randomUUID } from 'node:crypto';
import { getPool } from '@/server/db';
import * as register from '@/app/api/auth/register/route';

export const ORIGIN = 'http://test.local';

/** Rural parcel candidates in central France (classified as open land by Natural Earth). */
export const RURAL = { lng: 2.4512, lat: 46.6341 };

const GAME_TABLES = [
  'votes', 'proposals', 'project_contributions', 'settlement_projects', 'settlement_activity', 'settlement_invites',
  'settlement_members', 'trades', 'market_orders', 'production_runs', 'inventories', 'buildings', 'parcel_permissions',
  'parcel_ownership_history', 'parcels', 'notifications', 'world_events', 'jobs', 'idempotency_keys', 'sessions',
  'player_research', 'player_achievements', 'players', 'ledger_entries', 'audit_log',
];

/** Wipes all game state (keeps geography, surveys and system accounts). */
export async function resetGame() {
  const db = getPool();
  await db.query('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER USER');
  await db.query('ALTER TABLE votes DISABLE TRIGGER USER');
  try {
    await db.query(`TRUNCATE ${GAME_TABLES.join(', ')} CASCADE`);
    await db.query("DELETE FROM accounts WHERE kind <> 'system'");
    await db.query('UPDATE accounts SET balance = 0');
    await db.query('DELETE FROM settlements');
    await db.query('DELETE FROM users');
  } finally {
    await db.query('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
    await db.query('ALTER TABLE audit_log ENABLE TRIGGER USER');
    await db.query('ALTER TABLE votes ENABLE TRIGGER USER');
  }
}

export interface TestUser { id: string; username: string; cookie: string }

export async function registerUser(name = `u${randomUUID().slice(0, 8)}`): Promise<TestUser> {
  const res = await register.POST(
    new Request(`${ORIGIN}/api/auth/register`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: name, email: `${name}@example.com`, password: 'correct horse battery', displayName: name }),
    }),
  );
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const u = await getPool().query<{ id: string }>('SELECT id FROM users WHERE username = $1', [name]);
  return { id: u.rows[0].id, username: name, cookie };
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

export async function call(handler: Handler, opts: { user?: TestUser; method?: string; body?: unknown; params?: Record<string, string>; key?: string | null; query?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.user) headers.cookie = opts.user.cookie;
  const method = opts.method ?? 'POST';
  if (method !== 'GET' && opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  const req = new Request(`${ORIGIN}/api/x${opts.query ?? ''}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}) });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const json = (await res.json()) as { ok: boolean; data?: any; replayed?: boolean; error?: { code: string; message: string } };
  return { status: res.status, ...json };
}

export async function balance(userId: string): Promise<number> {
  const r = await getPool().query<{ balance: number }>('SELECT balance FROM accounts WHERE user_id = $1', [userId]);
  return r.rows[0].balance;
}

export async function inventory(userId: string, resource: string): Promise<number> {
  const r = await getPool().query<{ quantity: number }>('SELECT quantity FROM inventories WHERE user_id = $1 AND resource = $2', [userId, resource]);
  return r.rows[0]?.quantity ?? 0;
}

export async function setLevel(userId: string, level: number) {
  await getPool().query('UPDATE players SET level = $2, xp = 100 * ($2 - 1) * ($2 - 1) WHERE user_id = $1', [userId, level]);
}

export async function grantTech(userId: string, ...techs: string[]) {
  for (const t of techs) await getPool().query('INSERT INTO player_research (user_id, tech_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, t]);
}

export async function giveResources(userId: string, map: Record<string, number>) {
  for (const [r, q] of Object.entries(map)) {
    await getPool().query(
      'INSERT INTO inventories (user_id, resource, quantity) VALUES ($1,$2,$3) ON CONFLICT (user_id, resource) DO UPDATE SET quantity = inventories.quantity + excluded.quantity',
      [userId, r, q],
    );
  }
}

/** Ledger invariants: every account balance equals its ledger flows; total money supply is zero-sum. */
export async function assertLedgerConsistent() {
  const r = await getPool().query<{ id: string; balance: number; flow: number }>(
    `SELECT a.id, a.balance,
            COALESCE((SELECT sum(amount) FROM ledger_entries WHERE to_account = a.id), 0)
          - COALESCE((SELECT sum(amount) FROM ledger_entries WHERE from_account = a.id), 0) AS flow
       FROM accounts a`,
  );
  const bad = r.rows.filter((x) => Number(x.balance) !== Number(x.flow));
  if (bad.length) throw new Error(`ledger mismatch: ${JSON.stringify(bad)}`);
  const total = r.rows.reduce((s, x) => s + Number(x.balance), 0);
  if (total !== 0) throw new Error(`money supply not zero-sum: ${total}`);
}
