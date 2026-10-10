// Migrates the test database once and ensures geography is imported.
import pg from 'pg';
import { loadEnv } from '../scripts/env';
import { migrate } from '../scripts/migrate';
import { importGeo } from '../scripts/import-geo';

export default async function setup() {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for integration tests');
  await migrate(url, () => undefined);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const r = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM geo_features WHERE layer = 'land'");
  await c.end();
  if (r.rows[0].n === 0) await importGeo(url);
}
