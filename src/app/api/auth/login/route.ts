import { createSession, getDummyHash, SESSION_TTL_DAYS, verifyPassword } from '@/server/auth';
import { getPool } from '@/server/db';
import { GameError } from '@/server/errors';
import { allowedOrigin, clientIp, errorResponse, json } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { sessionCookie } from '@/server/cookies';
import { loginSchema } from '@/shared/schemas';

export async function POST(req: Request) {
  try {
    if (!allowedOrigin(req)) throw new GameError('forbidden', 'Cross-origin request rejected');
    const ip = clientIp(req);
    const parsed = loginSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new GameError('invalid_input', 'Enter your username and password');
    const { username, password } = parsed.data;
    if (!rateLimit(`${ip ?? 'anon'}:${username.toLowerCase()}`, 'auth').ok) throw new GameError('rate_limited', 'Too many attempts, try again in a minute');
    const r = await getPool().query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)',
      [username],
    );
    const user = r.rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !ok) throw new GameError('unauthenticated', 'Incorrect username or password');
    const session = await createSession(getPool(), user.id, req.headers.get('user-agent'), ip);
    return json({ ok: true, data: { signedIn: true } }, 200, { 'set-cookie': sessionCookie(session.token, SESSION_TTL_DAYS * 86400) });
  } catch (err) {
    return errorResponse(err);
  }
}
