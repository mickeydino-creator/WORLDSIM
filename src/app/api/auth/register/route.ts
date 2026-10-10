import { createSession, hashPassword, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/server/auth';
import { withTx } from '@/server/db';
import { GameError } from '@/server/errors';
import { audit } from '@/server/events';
import { allowedOrigin, clientIp, errorResponse, json } from '@/server/http';
import { rateLimit } from '@/server/ratelimit';
import { sessionCookie } from '@/server/cookies';
import { createPlayer } from '@/server/services/players';
import { registerSchema } from '@/shared/schemas';

export async function POST(req: Request) {
  try {
    if (!allowedOrigin(req)) throw new GameError('forbidden', 'Cross-origin request rejected');
    const ip = clientIp(req);
    if (!rateLimit(ip ?? 'anon', 'auth').ok) throw new GameError('rate_limited', 'Too many attempts, try again in a minute');
    const parsed = registerSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new GameError('invalid_input', `${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    const b = parsed.data;
    const hash = await hashPassword(b.password);
    const session = await withTx(async (tx) => {
      const exists = await tx.query('SELECT 1 FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)', [b.username, b.email]);
      if (exists.rowCount) throw new GameError('conflict', 'That username or email is already registered');
      const u = await tx.query<{ id: string }>(
        'INSERT INTO users (username, email, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id',
        [b.username, b.email.toLowerCase(), hash, b.displayName],
      );
      await createPlayer(tx, u.rows[0].id);
      await audit(tx, u.rows[0].id, 'auth.register', 'user', u.rows[0].id, {}, ip);
      return createSession(tx, u.rows[0].id, req.headers.get('user-agent'), ip);
    });
    return json({ ok: true, data: { registered: true } }, 201, { 'set-cookie': sessionCookie(session.token, SESSION_TTL_DAYS * 86400) });
  } catch (err) {
    return errorResponse(err);
  }
}
