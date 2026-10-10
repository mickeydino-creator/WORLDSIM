import { destroySession, parseCookies, SESSION_COOKIE } from '@/server/auth';
import { allowedOrigin, errorResponse, json } from '@/server/http';
import { GameError } from '@/server/errors';
import { sessionCookie } from '@/server/cookies';

export async function POST(req: Request) {
  try {
    if (!allowedOrigin(req)) throw new GameError('forbidden', 'Cross-origin request rejected');
    const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
    if (token) await destroySession(token);
    return json({ ok: true, data: { signedOut: true } }, 200, { 'set-cookie': sessionCookie('', 0) });
  } catch (err) {
    return errorResponse(err);
  }
}
