// Route wrapper used by every API endpoint: authentication, origin (CSRF) checks, rate limiting,
// input validation, request idempotency and uniform error mapping.
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { SESSION_COOKIE, parseCookies, userForToken, type SessionUser } from './auth';
import { getPool, withTx, type Db, type Tx } from './db';
import { GameError } from './errors';
import { log, reportError } from './log';
import { rateLimit, type LimitClass } from './ratelimit';

export interface Ctx<B> {
  req: Request;
  user: SessionUser;
  body: B;
  params: Record<string, string>;
  ip: string | null;
  url: URL;
  /** Stable per-request key used to derive ledger idempotency keys. */
  opKey: string;
}

type Params = { params: Promise<Record<string, string>> };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

export function errorResponse(err: unknown) {
  if (err instanceof GameError) {
    return json({ ok: false, error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  const code = (err as { code?: string }).code;
  if (code === '23505') {
    // unique violation that escaped explicit checks: treat as a concurrent conflict
    return json({ ok: false, error: { code: 'conflict', message: 'This action conflicted with another change. Please retry.' } }, 409);
  }
  if (code === '23514') {
    return json({ ok: false, error: { code: 'conflict', message: 'The action would violate a game rule.' } }, 409);
  }
  reportError(err);
  return json({ ok: false, error: { code: 'internal', message: 'Internal server error' } }, 500);
}

export function clientIp(req: Request): string | null {
  // Only trust X-Forwarded-For when explicitly configured to run behind a proxy.
  if (process.env.TRUST_PROXY === '1') {
    const xf = req.headers.get('x-forwarded-for');
    if (xf) return xf.split(',')[0].trim();
  }
  return req.headers.get('x-real-ip');
}

export function allowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const configured = process.env.APP_ORIGIN;
  if (configured && origin === configured) return true;
  const host = req.headers.get('host');
  return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

export async function currentUser(req: Request): Promise<SessionUser | null> {
  return userForToken(parseCookies(req.headers.get('cookie'))[SESSION_COOKIE]);
}

async function readBody<S extends z.ZodTypeAny>(req: Request, schema?: S): Promise<z.infer<S>> {
  if (!schema) return undefined as z.infer<S>;
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new GameError('invalid_input', 'Expected application/json');
  const text = await req.text();
  if (text.length > 64_000) throw new GameError('invalid_input', 'Request body too large');
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new GameError('invalid_input', 'Malformed JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new GameError('invalid_input', `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return parsed.data;
}

/** Authenticated read endpoint (GET). */
export function getRoute(handler: (ctx: Ctx<undefined> & { db: Db }) => Promise<unknown>, opts: { auth?: boolean } = {}) {
  return async (req: Request, { params }: Params) => {
    try {
      const user = await currentUser(req);
      if (opts.auth !== false && !user) throw new GameError('unauthenticated', 'Sign in required');
      const ip = clientIp(req);
      const rl = rateLimit(user?.id ?? ip ?? 'anon', 'read');
      if (!rl.ok) return json({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } }, 429, { 'retry-after': String(rl.retryAfterSec) });
      const data = await handler({ req, user: user as SessionUser, body: undefined, params: await params, ip, url: new URL(req.url), opKey: '', db: getPool() });
      return json({ ok: true, data });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

interface ActionOpts<S extends z.ZodTypeAny> {
  schema?: S;
  limit?: LimitClass;
  /** Require an Idempotency-Key header and replay stored responses for duplicates. Default true. */
  idempotent?: boolean;
  scope: string;
}

/**
 * Authenticated mutating endpoint. The handler runs inside one database transaction together with
 * the idempotency record, so a replayed request either returns the original response or (if the
 * original failed) executes once.
 */
export function actionRoute<S extends z.ZodTypeAny>(opts: ActionOpts<S>, handler: (ctx: Ctx<z.infer<S>> & { tx: Tx }) => Promise<unknown>) {
  return async (req: Request, { params }: Params) => {
    try {
      if (!allowedOrigin(req)) throw new GameError('forbidden', 'Cross-origin request rejected');
      const user = await currentUser(req);
      if (!user) throw new GameError('unauthenticated', 'Sign in required');
      const rl = rateLimit(user.id, opts.limit ?? 'action');
      if (!rl.ok) return json({ ok: false, error: { code: 'rate_limited', message: 'Too many requests, slow down' } }, 429, { 'retry-after': String(rl.retryAfterSec) });
      const body = await readBody(req, opts.schema);
      const p = await params;
      const key = req.headers.get('idempotency-key');
      const idempotent = opts.idempotent !== false;
      if (idempotent && (!key || key.length < 8 || key.length > 100)) throw new GameError('invalid_input', 'Idempotency-Key header required');
      const requestHash = createHash('sha256').update(opts.scope + JSON.stringify(p) + JSON.stringify(body ?? null)).digest('hex');
      const ip = clientIp(req);
      const result = await withTx(async (tx) => {
        if (idempotent) {
          const ins = await tx.query(
            `INSERT INTO idempotency_keys (user_id, key, scope, request_hash) VALUES ($1,$2,$3,$4)
             ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
            [user.id, key, opts.scope, requestHash],
          );
          if (ins.rowCount === 0) {
            const prev = await tx.query<{ request_hash: string; response_body: unknown }>(
              'SELECT request_hash, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
              [user.id, key],
            );
            if (prev.rows[0].request_hash !== requestHash) throw new GameError('idempotency_mismatch', 'Idempotency key reused with a different request');
            return { replayed: true, data: prev.rows[0].response_body };
          }
        }
        const opKey = `${user.id}:${key ?? randomUUID()}`;
        const data = await handler({ req, user, body, params: p, ip, url: new URL(req.url), opKey, tx });
        if (idempotent) {
          await tx.query('UPDATE idempotency_keys SET response_body = $3 WHERE user_id = $1 AND key = $2', [user.id, key, JSON.stringify(data ?? null)]);
        }
        return { replayed: false, data };
      });
      if (result.replayed) log.info('idempotent replay', { scope: opts.scope, user: user.id });
      return json({ ok: true, data: result.data, replayed: result.replayed });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
