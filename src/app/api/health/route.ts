import { getPool } from '@/server/db';
import { json } from '@/server/http';

// Liveness/readiness: database, PostGIS, imported geography and worker heartbeat.
export async function GET() {
  const checks: Record<string, unknown> = {};
  let healthy = true;
  try {
    const r = await getPool().query<{ postgis: string; geo: number; hb: Date | null; pending: number }>(
      `SELECT postgis_lib_version() AS postgis,
              (SELECT count(*)::int FROM geo_features) AS geo,
              (SELECT updated_at FROM system_status WHERE key = 'worker_heartbeat') AS hb,
              (SELECT count(*)::int FROM jobs WHERE status = 'pending' AND run_at < now() - interval '1 minute') AS pending`,
    );
    const row = r.rows[0];
    // Network round trip to the database: every action needs ~15-20 of these in sequence, so this
    // should be a few ms (app and database in the same region).
    const rtts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await getPool().query('SELECT 1');
      rtts.push(performance.now() - t);
    }
    checks.dbRoundTripMs = Math.round(rtts.sort((a, b) => a - b)[1] * 10) / 10;
    checks.database = 'ok';
    checks.postgis = row.postgis;
    checks.geography = row.geo > 0 ? 'ok' : 'missing (run npm run geo:import)';
    const age = row.hb ? (Date.now() - new Date(row.hb).getTime()) / 1000 : null;
    checks.worker = age !== null && age < 60 ? 'ok' : age === null ? 'never seen' : `stale (${Math.round(age)}s)`;
    checks.overdueJobs = row.pending;
    healthy = row.geo > 0;
  } catch (err) {
    checks.database = `error: ${(err as Error).message}`;
    healthy = false;
  }
  return json({ ok: healthy, checks }, healthy ? 200 : 503);
}
