// Background worker: runs durable jobs (production completion, world simulation ticks,
// order expiry, governance deadlines, maintenance). Start any number of instances.
import { loadEnv } from '../scripts/env';
loadEnv();
process.env.WORLDSTATE_PROCESS ??= 'worker';

const { getPool } = await import('@/server/db');
const { startWorkerLoop } = await import('@/server/worker/loop');

const stop = startWorkerLoop();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await stop();
    await getPool().end();
    process.exit(0);
  });
}
