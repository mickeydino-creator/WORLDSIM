// One-shot startup step for hosted deployments: apply migrations and, if the geography tables are
// empty, import Natural Earth data. Safe to run on every boot.
import pg from 'pg';
import { loadEnv } from './env';
import { migrate } from './migrate';
import { importGeo } from './import-geo';
import { pgConfig } from '../src/server/pgconfig';

loadEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
await migrate(url);
const c = new pg.Client(pgConfig(url));
await c.connect();
const r = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM geo_features WHERE layer = 'land'");
await c.end();
if (r.rows[0].n === 0) {
  console.log('geography missing: importing Natural Earth (first boot only)...');
  await importGeo(url);
}
console.log('bootstrap complete');
