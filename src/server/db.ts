import pg from 'pg';
import { log } from './log';

// bigint (int8) columns come back as strings by default; balances fit comfortably in
// Number.MAX_SAFE_INTEGER (9e15 minor units = 9e13 credits), which we enforce at the API layer.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${v}`);
  return n;
});

export type Db = pg.PoolClient | pg.Pool;
export type Tx = pg.PoolClient;

declare global {
  // eslint-disable-next-line no-var
  var __worldstatePool: pg.Pool | undefined;
}

export function getPool(): pg.Pool {
  if (!globalThis.__worldstatePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const pool = new pg.Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      application_name: process.env.WORLDSTATE_PROCESS ?? 'worldstate-web',
    });
    pool.on('error', (err) => log.error('pg pool error', { err: err.message }));
    globalThis.__worldstatePool = pool;
  }
  return globalThis.__worldstatePool;
}

/** Replace the pool (tests point it at the test database). */
export function setPool(pool: pg.Pool) {
  globalThis.__worldstatePool = pool;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Runs fn inside a READ COMMITTED transaction. Correctness relies on explicit row locks
 * (SELECT ... FOR UPDATE), conditional updates and unique constraints rather than isolation level.
 * Deadlocks/serialization failures are retried with jitter.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 50));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Db = getPool()) {
  return db.query<T>(text, params);
}
