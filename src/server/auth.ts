// Self-hosted authentication: scrypt password hashes, opaque random session tokens stored only as
// SHA-256 hashes, httpOnly cookies. No secrets are ever sent to the browser.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getPool, type Db } from './db';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'ws_session';
export const SESSION_TTL_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A dummy hash so login timing does not reveal whether a username exists. */
let dummyHash: Promise<string> | null = null;
export function getDummyHash() {
  dummyHash ??= hashPassword('not-a-real-password');
  return dummyHash;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Db, userId: string, userAgent: string | null, ip: string | null) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await db.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)',
    [userId, hashToken(token), expires, userAgent?.slice(0, 300) ?? null, ip],
  );
  return { token, expires };
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  sessionId: string;
}

// Valid sessions are cached for a few seconds per process to save a database round trip on every
// request. Logout, password changes and "sign out other devices" invalidate the cache immediately.
const SESSION_CACHE_MS = 15_000;
const sessionCache = new Map<string, { user: SessionUser; at: number }>();

export function invalidateSessions(userId?: string) {
  if (!userId) return sessionCache.clear();
  for (const [k, v] of sessionCache) if (v.user.id === userId) sessionCache.delete(k);
}

export async function userForToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const key = hashToken(token);
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.user;
  const user = await lookupSession(key);
  if (user) {
    if (sessionCache.size > 50_000) sessionCache.clear();
    sessionCache.set(key, { user, at: Date.now() });
  } else sessionCache.delete(key);
  return user;
}

async function lookupSession(tokenHash: string): Promise<SessionUser | null> {
  const r = await getPool().query<{ id: string; username: string; display_name: string; is_admin: boolean; session_id: string; last_seen_at: Date }>(
    `SELECT u.id, u.username, u.display_name, u.is_admin, s.id AS session_id, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    getPool().query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => undefined);
  }
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.is_admin, sessionId: row.session_id };
}

export async function destroySession(token: string) {
  sessionCache.delete(hashToken(token));
  await getPool().query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
