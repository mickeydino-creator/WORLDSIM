import { SESSION_COOKIE } from './auth';

export function sessionCookie(token: string, maxAgeSec: number) {
  const secure = process.env.COOKIE_SECURE === '1' || (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0');
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
