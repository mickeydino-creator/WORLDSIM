// Imports Natural Earth (public domain, https://www.naturalearthdata.com) 1:10m land, lakes and
// urban-area polygons into geo_features, subdivided for fast point-in-polygon lookups.
// Usage: npm run geo:import [-- --test]   (downloads to ./data on first run)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadEnv } from './env';
import { pgConfig } from '../src/server/pgconfig';

const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';
const LAYERS = [
  { layer: 'land', file: 'ne_10m_land.geojson' },
  { layer: 'lake', file: 'ne_10m_lakes.geojson' },
  { layer: 'urban', file: 'ne_10m_urban_areas.geojson' },
] as const;

async function fetchCached(file: string): Promise<string> {
  const dir = join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (!existsSync(path)) {
    console.log(`downloading ${file}`);
    const res = await fetch(`${BASE}/${file}`);
    if (!res.ok) throw new Error(`download ${file} failed: HTTP ${res.status}`);
    writeFileSync(path, await res.text());
  }
  return readFileSync(path, 'utf8');
}

export async function importGeo(databaseUrl: string) {
  const client = new pg.Client(pgConfig(databaseUrl));
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM geo_features');
    for (const { layer, file } of LAYERS) {
      const fc = JSON.parse(await fetchCached(file)) as { features: { geometry: unknown }[] };
      const geoms = fc.features.map((f) => f.geometry).filter(Boolean);
      let n = 0;
      // Batched inserts keep the import fast over a remote connection (e.g. a hosted database).
      // ST_Subdivide keeps each stored polygon small (<=128 vertices) so gist lookups stay cheap.
      for (let i = 0; i < geoms.length; i += 200) {
        const r = await client.query(
          `INSERT INTO geo_features (layer, geom)
           SELECT $1, ST_Subdivide(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g), 4326)), 128)
             FROM jsonb_array_elements($2::jsonb) AS g`,
          [layer, JSON.stringify(geoms.slice(i, i + 200))],
        );
        n += r.rowCount ?? 0;
      }
      console.log(`${layer}: ${fc.features.length} features -> ${n} subdivided polygons`);
    }
    // Bump the geo version so cached parcel surveys are recomputed.
    await client.query(`INSERT INTO system_status (key, value) VALUES ('geo_version', to_jsonb(extract(epoch from now())::int))
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`);
    await client.query('DELETE FROM parcel_surveys');
    await client.query('COMMIT');
    await client.query('ANALYZE geo_features');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const url = process.argv.includes('--test') ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  importGeo(url).then(() => console.log('geo import complete'), (e) => { console.error(e); process.exit(1); });
}
