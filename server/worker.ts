// Background worker: runs durable jobs (production completion, world simulation ticks,
// order expiry, governance deadlines, maintenance). Start any number of instances.
import { loadEnv } from '../scripts/env';
loadEnv();
process.env.WORLDSTATE_PROCESS ??= 'worker';

const { getPool } = await import('@/server/db');
const { log, reportError } = await import('@/server/log');
const { processDueJobs, scheduleRecurring } = await import('@/server/worker/handlers');

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heartbeat() {
  await getPool().query(
    `INSERT INTO system_status (key, value) VALUES ('worker_heartbeat', jsonb_build_object('pid', $1::int, 'at', now()))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [process.pid],
  );
}

async function main() {
  log.info('worker started', { pid: process.pid });
  let lastSchedule = 0;
  let lastBeat = 0;
  while (!stopping) {
    try {
      const now = Date.now();
      if (now - lastSchedule > 5000) { await scheduleRecurring(now); lastSchedule = now; }
      if (now - lastBeat > 10000) { await heartbeat(); lastBeat = now; }
      const n = await processDueJobs();
      if (n === 0) await sleep(500);
    } catch (err) {
      reportError(err, { where: 'worker loop' });
      await sleep(2000);
    }
  }
  await getPool().end();
  log.info('worker stopped');
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; });
main();
