// Durable job queue on PostgreSQL. Jobs are claimed with FOR UPDATE SKIP LOCKED so any number of
// workers can run concurrently; handlers run in a transaction that also marks the job done, so a
// job's effects and its completion commit atomically (exactly-once effects, at-least-once attempts).
import type { Db, Tx } from './db';

export async function enqueue(db: Db, type: string, payload: Record<string, unknown>, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  await db.query(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key, max_attempts) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [type, JSON.stringify(payload), opts.runAt ?? new Date(), opts.dedupeKey ?? null, opts.maxAttempts ?? 8],
  );
}

export interface Job {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function claimJobs(db: Db, limit: number, lockSeconds = 60): Promise<Job[]> {
  const r = await db.query<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $2), updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE (status = 'pending' AND run_at <= now()) OR (status = 'running' AND locked_until < now())
         ORDER BY run_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, type, payload, attempts, max_attempts`,
    [limit, lockSeconds],
  );
  return r.rows;
}

export async function markDone(tx: Tx, jobId: number) {
  await tx.query("UPDATE jobs SET status = 'done', locked_until = NULL, updated_at = now() WHERE id = $1", [jobId]);
}

export async function markFailed(db: Db, job: Job, error: string) {
  const final = job.attempts >= job.max_attempts;
  const backoff = Math.min(300, 2 ** job.attempts);
  await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + make_interval(secs => $4), locked_until = NULL, updated_at = now() WHERE id = $1`,
    [job.id, final ? 'failed' : 'pending', error.slice(0, 2000), backoff],
  );
  return final;
}

/** Thrown by a handler to reschedule without counting as a failure (e.g. not yet due). */
export class RetryLater extends Error {
  constructor(readonly runAt: Date) {
    super('retry later');
  }
}
