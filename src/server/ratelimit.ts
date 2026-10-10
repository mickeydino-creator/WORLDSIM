// In-process fixed-window rate limiter. Suitable for a single web instance; for horizontal
// scaling replace the Map with a shared store (documented in docs/OPERATIONS.md).
const buckets = new Map<string, { count: number; resetAt: number }>();

export const LIMITS = {
  auth: { max: 10, windowMs: 60_000 },
  action: { max: 120, windowMs: 60_000 },
  read: { max: 600, windowMs: 60_000 },
} as const;

export type LimitClass = keyof typeof LIMITS;

export function rateLimit(key: string, cls: LimitClass): { ok: boolean; retryAfterSec: number } {
  if (process.env.DISABLE_RATE_LIMIT === '1') return { ok: true, retryAfterSec: 0 };
  const { max, windowMs } = LIMITS[cls];
  const now = Date.now();
  const k = `${cls}:${key}`;
  let b = buckets.get(k);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(k, b);
  }
  b.count++;
  if (buckets.size > 50_000) for (const [kk, v] of buckets) if (v.resetAt <= now) buckets.delete(kk);
  return { ok: b.count <= max, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
}
