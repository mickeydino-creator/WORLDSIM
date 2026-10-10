import { beforeEach, describe, expect, it } from 'vitest';
import * as spec from '@/app/api/research/specialization/route';
import * as grant from '@/app/api/admin/grant/route';
import * as password from '@/app/api/settings/password/route';
import * as login from '@/app/api/auth/login/route';
import * as me from '@/app/api/me/route';
import * as logout from '@/app/api/auth/logout/route';
import { getPool } from '@/server/db';
import { STARTING_BALANCE } from '@/shared/config/resources';
import { ORIGIN, assertLedgerConsistent, balance, call, registerUser, resetGame } from './helpers';

async function loginAs(username: string, pw: string) {
  const res = await login.POST(new Request(`${ORIGIN}/api/auth/login`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: pw }) }));
  return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

describe('accounts and settings', () => {
  beforeEach(resetGame);

  it('chooses a specialization for free, then charges RP to change it', async () => {
    const u = await registerUser();
    expect((await call(spec.POST, { user: u, body: { specialization: 'trade' } })).status).toBe(200);
    const m = await call(me.GET, { user: u, method: 'GET' });
    expect(m.data.modifiers.marketFeeBps).toBe(100);
    expect((await call(spec.POST, { user: u, body: { specialization: 'industry' } })).error?.code).toBe('insufficient_resources');
    await getPool().query('UPDATE players SET research_points = 30 WHERE user_id = $1', [u.id]);
    expect((await call(spec.POST, { user: u, body: { specialization: 'industry' } })).status).toBe(200);
    expect((await call(me.GET, { user: u, method: 'GET' })).data.researchPoints).toBe(5);
    expect((await call(spec.POST, { user: u, body: { specialization: 'wizardry' } })).status).toBe(400);
  });

  it('restricts administrative grants to admins and records them in the ledger and audit log', async () => {
    const player = await registerUser();
    const admin = await registerUser();
    const body = { username: player.username, amount: 1_000_00, reason: 'event prize' };
    expect((await call(grant.POST, { user: player, body })).status).toBe(403);
    await getPool().query('UPDATE users SET is_admin = true WHERE id = $1', [admin.id]);
    expect((await call(grant.POST, { user: admin, body })).status).toBe(200);
    expect(await balance(player.id)).toBe(STARTING_BALANCE + 1_000_00);
    const a = await getPool().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.grant'");
    expect(a.rows[0].n).toBe(1);
    await assertLedgerConsistent();
  });

  it('logs in, changes password (revoking other sessions) and logs out', async () => {
    const u = await registerUser();
    const other = await loginAs(u.username, 'correct horse battery');
    expect(other.status).toBe(200);
    expect((await loginAs(u.username, 'wrong password!')).status).toBe(401);
    const r = await call(password.POST, { user: u, body: { currentPassword: 'correct horse battery', newPassword: 'a much better passphrase' } });
    expect(r.status).toBe(200);
    // The other session was revoked; the current one still works.
    expect((await call(me.GET, { method: 'GET', user: { ...u, cookie: other.cookie } })).status).toBe(401);
    expect((await call(me.GET, { method: 'GET', user: u })).status).toBe(200);
    expect((await loginAs(u.username, 'a much better passphrase')).status).toBe(200);
    const res = await logout.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { origin: ORIGIN, cookie: u.cookie } }));
    expect(res.status).toBe(200);
    expect((await call(me.GET, { method: 'GET', user: u })).status).toBe(401);
  });

  it('rejects duplicate usernames and invalid registration input', async () => {
    await registerUser('dupe_user');
    await expect(registerUser('dupe_user')).rejects.toThrow(/409/);
    await expect(registerUser('x')).rejects.toThrow(/400/);
  });
});
