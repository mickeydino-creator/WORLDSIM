import { withTx } from '../db';
import { claimJobs, enqueue, markDone, markFailed, RetryLater, type Job } from '../jobs';
import { getPool } from '../db';
import { log, reportError } from '../log';
import { completeProduction } from '../services/production';
import { expireOrders } from '../services/market';
import { finalizeProposal } from '../services/settlements';
import { accrueIncome } from '../services/simulation';

type Handler = (job: Job) => Promise<void>;

const handlers: Record<string, Handler> = {
  'production.complete': async (job) => {
    await withTx(async (tx) => {
      const res = await completeProduction(tx, String(job.payload.runId));
      if (res === 'not_due') throw new RetryLater(new Date(Date.now() + 1000));
      await markDone(tx, job.id);
    });
  },
  'world.tick': async (job) => {
    const processed = await withTx(async (tx) => {
      const n = await accrueIncome(tx, String(job.id));
      await markDone(tx, job.id);
      return n;
    });
    if (processed >= 500) await enqueue(getPool(), 'world.tick', {}, { dedupeKey: `tick:more:${job.id}` });
  },
  'market.expire': async (job) => {
    await withTx(async (tx) => {
      await expireOrders(tx);
      await markDone(tx, job.id);
    });
  },
  'proposal.finalize': async (job) => {
    await withTx(async (tx) => {
      await finalizeProposal(tx, String(job.payload.proposalId));
      const still = await tx.query("SELECT 1 FROM proposals WHERE id = $1 AND status = 'open' AND closes_at > now()", [job.payload.proposalId]);
      if (still.rowCount) throw new RetryLater(new Date(Date.now() + 5000));
      await markDone(tx, job.id);
    });
  },
  // Safety net: finalize any overdue proposal whose dedicated job was lost.
  'proposal.sweep': async (job) => {
    await withTx(async (tx) => {
      const due = await tx.query<{ id: string }>("SELECT id FROM proposals WHERE status = 'open' AND closes_at <= now() LIMIT 50");
      for (const p of due.rows) await finalizeProposal(tx, p.id);
      await markDone(tx, job.id);
    });
  },
  'maintenance.cleanup': async (job) => {
    await withTx(async (tx) => {
      await tx.query('DELETE FROM sessions WHERE expires_at < now()');
      await tx.query("DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '1 day'");
      await tx.query("DELETE FROM world_events WHERE created_at < now() - interval '2 days'");
      await tx.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'");
      await markDone(tx, job.id);
    });
  },
};

/** Recurring jobs, de-duplicated per time bucket so multiple workers do not multiply them. */
export const RECURRING: { type: string; everySec: number }[] = [
  { type: 'world.tick', everySec: 30 },
  { type: 'market.expire', everySec: 60 },
  { type: 'proposal.sweep', everySec: 60 },
  { type: 'maintenance.cleanup', everySec: 3600 },
];

export async function scheduleRecurring(now = Date.now()) {
  for (const r of RECURRING) {
    const bucket = Math.floor(now / 1000 / r.everySec);
    await enqueue(getPool(), r.type, {}, { dedupeKey: `${r.type}:${bucket}`, maxAttempts: 3 });
  }
}

export async function runJob(job: Job) {
  const h = handlers[job.type];
  try {
    if (!h) throw new Error(`no handler for job type ${job.type}`);
    await h(job);
  } catch (err) {
    if (err instanceof RetryLater) {
      await getPool().query("UPDATE jobs SET status = 'pending', attempts = attempts - 1, run_at = $2, locked_until = NULL WHERE id = $1", [job.id, err.runAt]);
      return;
    }
    const final = await markFailed(getPool(), job, (err as Error).message ?? String(err));
    if (final) reportError(err, { job: job.type, jobId: job.id });
    else log.warn('job failed, will retry', { job: job.type, jobId: job.id, err: (err as Error).message });
  }
}

/** Claims and runs all currently due jobs (used by the worker loop and by tests). */
export async function processDueJobs(batch = 20): Promise<number> {
  let total = 0;
  for (;;) {
    const jobs = await claimJobs(getPool(), batch);
    if (jobs.length === 0) return total;
    await Promise.all(jobs.map(runJob));
    total += jobs.length;
  }
}
