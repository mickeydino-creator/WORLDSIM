// Worker loop: schedules recurring jobs, writes a heartbeat and runs due jobs until stopped.
// Used by the standalone worker process and, when RUN_WORKER=1, inside the web process
// (for single-service hosting such as a free Render web service).
import { getPool } from '../db';
import { log, reportError } from '../log';
import { processDueJobs, scheduleRecurring } from './handlers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startWorkerLoop() {
  let stopping = false;
  const done = (async () => {
    log.info('worker loop started', { pid: process.pid });
    let lastSchedule = 0;
    let lastBeat = 0;
    while (!stopping) {
      try {
        const now = Date.now();
        if (now - lastSchedule > 5000) { await scheduleRecurring(now); lastSchedule = now; }
        if (now - lastBeat > 10000) {
          await getPool().query(
            `INSERT INTO system_status (key, value) VALUES ('worker_heartbeat', jsonb_build_object('pid', $1::int, 'at', now()))
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
            [process.pid],
          );
          lastBeat = now;
        }
        const n = await processDueJobs();
        if (n === 0) await sleep(500);
      } catch (err) {
        reportError(err, { where: 'worker loop' });
        await sleep(2000);
      }
    }
    log.info('worker loop stopped');
  })();
  return async () => {
    stopping = true;
    await done;
  };
}
