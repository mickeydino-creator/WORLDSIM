import pg from 'pg';
import { afterAll } from 'vitest';
import { loadEnv } from '../scripts/env';
import { setPool } from '@/server/db';

loadEnv();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DISABLE_RATE_LIMIT = '1';
process.env.APP_ORIGIN = 'http://test.local';
process.env.LOG_LEVEL = 'error';
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 20 });
setPool(pool);
afterAll(async () => {
  await pool.end();
});
