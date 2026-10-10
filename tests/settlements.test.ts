import { beforeEach, describe, expect, it } from 'vitest';
import * as purchase from '@/app/api/parcels/[id]/purchase/route';
import * as settlements from '@/app/api/settlements/route';
import * as settlementGet from '@/app/api/settlements/[id]/route';
import * as invites from '@/app/api/settlements/[id]/invites/route';
import * as respond from '@/app/api/invites/[id]/respond/route';
import * as remove from '@/app/api/settlements/[id]/members/[userId]/remove/route';
import * as role from '@/app/api/settlements/[id]/members/[userId]/role/route';
import * as donate from '@/app/api/settlements/[id]/parcels/route';
import * as projects from '@/app/api/settlements/[id]/projects/route';
import * as contribute from '@/app/api/projects/[id]/contribute/route';
import * as cancelProject from '@/app/api/projects/[id]/cancel/route';
import * as proposals from '@/app/api/settlements/[id]/proposals/route';
import * as vote from '@/app/api/proposals/[id]/vote/route';
import * as research from '@/app/api/research/[techId]/route';
import * as build from '@/app/api/buildings/route';
import { getPool } from '@/server/db';
import { processDueJobs } from '@/server/worker/handlers';
import { tallyPasses } from '@/shared/config/settlements';
import { parcelCenter, parcelIdAt } from '@/shared/grid';
import { metersToLngLat } from '@/shared/geo';
import { RURAL, assertLedgerConsistent, balance, call, registerUser, resetGame, setLevel, type TestUser } from './helpers';

const home = parcelIdAt(RURAL.lng, RURAL.lat);
const [hx, hy] = parcelCenter(home);
const second = parcelIdAt(...metersToLngLat([hx, hy], 120, 0));

async function founder() {
  const f = await registerUser();
  await setLevel(f.id, 3);
  expect((await call(purchase.POST, { body: { name: 'Test land' }, user: f, params: { id: home } })).status).toBe(200);
  const s = await call(settlements.POST, { user: f, body: { name: `Town ${f.username}`, description: 'test', parcelId: home } });
  expect(s.status, JSON.stringify(s.error)).toBe(200);
  return { f, sid: s.data.id as string };
}

async function join(sid: string, inviter: TestUser) {
  const m = await registerUser();
  const inv = await call(invites.POST, { user: inviter, params: { id: sid }, body: { username: m.username } });
  expect(inv.status, JSON.stringify(inv.error)).toBe(200);
  expect((await call(respond.POST, { user: m, params: { id: inv.data.inviteId }, body: { accept: true } })).status).toBe(200);
  return m;
}

describe('settlements', () => {
  beforeEach(resetGame);

  it('creates a settlement, seeds the treasury, and transfers the founding parcel', async () => {
    const { f, sid } = await founder();
    const s = await call(settlementGet.GET, { user: f, method: 'GET', params: { id: sid } });
    expect(s.data.myRole).toBe('founder');
    expect(s.data.treasury).toBe(5_000_00);
    expect(s.data.parcels.map((p: { id: string }) => p.id)).toContain(home);
    await assertLedgerConsistent();
  });

  it('enforces membership permissions', async () => {
    const { f, sid } = await founder();
    const m = await join(sid, f);
    const outsider = await registerUser();
    // A normal member cannot invite, remove, or change roles.
    expect((await call(invites.POST, { user: m, params: { id: sid }, body: { username: outsider.username } })).status).toBe(403);
    expect((await call(remove.POST, { user: m, params: { id: sid, userId: f.id } })).status).toBe(403);
    expect((await call(role.POST, { user: m, params: { id: sid, userId: m.id }, body: { role: 'leader' } })).status).toBe(403);
    // Outsiders cannot start votes or spend treasury.
    expect((await call(proposals.POST, { user: outsider, params: { id: sid }, body: { type: 'treasury_transfer', title: 'Give me money', payload: { toUserId: outsider.id, amount: 100 } } })).status).toBe(403);
    // Founder can promote and remove.
    expect((await call(role.POST, { user: f, params: { id: sid, userId: m.id }, body: { role: 'treasurer' } })).status).toBe(200);
    // A treasurer cannot appoint a leader without a vote.
    const m2 = await join(sid, f);
    expect((await call(role.POST, { user: m, params: { id: sid, userId: m2.id }, body: { role: 'leader' } })).status).toBe(403);
    expect((await call(remove.POST, { user: f, params: { id: sid, userId: m2.id } })).status).toBe(200);
    const s = await call(settlementGet.GET, { user: f, method: 'GET', params: { id: sid } });
    expect(s.data.members).toHaveLength(2);
  });

  it('records project contributions and completes the project as a persistent building', async () => {
    const { f, sid } = await founder();
    const m = await join(sid, f);
    const p = await call(projects.POST, { user: m, params: { id: sid }, body: { type: 'public_park', name: 'Central park', parcelId: home, lng: hx, lat: hy, rotation: 0 } });
    expect(p.status, JSON.stringify(p.error)).toBe(200);
    const pid = p.data.projectId;
    const cost = p.data.cost as number;
    const mBefore = await balance(m.id);
    const c1 = await call(contribute.POST, { user: m, params: { id: pid }, body: { currency: 1_000_00 } });
    expect(c1.status).toBe(200);
    expect(await balance(m.id)).toBe(mBefore - 1_000_00);
    // Treasurer-only: a member cannot spend treasury funds.
    expect((await call(contribute.POST, { user: m, params: { id: pid }, body: { currency: 100, fromTreasury: true } })).status).toBe(403);
    const c2 = await call(contribute.POST, { user: f, params: { id: pid }, body: { currency: cost, fromTreasury: true } });
    expect(c2.status).toBe(200);
    expect(c2.data.currency).toBe(cost - 1_000_00); // clamped to the remaining need
    expect(c2.data.completed).toBe(true);
    const s = await call(settlementGet.GET, { user: f, method: 'GET', params: { id: sid } });
    const proj = s.data.projects.find((x: { id: string }) => x.id === pid);
    expect(proj.status).toBe('completed');
    const b = await getPool().query('SELECT type, settlement_id FROM buildings WHERE id = $1', [proj.resultBuildingId]);
    expect(b.rows[0]).toEqual({ type: 'park', settlement_id: sid });
    const contribs = await getPool().query('SELECT count(*)::int AS n FROM project_contributions WHERE project_id = $1', [pid]);
    expect(contribs.rows[0].n).toBe(2);
    await assertLedgerConsistent();
  });

  it('cancelling a project refunds contributors', async () => {
    const { f, sid } = await founder();
    const p = await call(projects.POST, { user: f, params: { id: sid }, body: { type: 'road_connection', name: 'Main street', parcelId: home, lng: hx, lat: hy, rotation: 0 } });
    const before = await balance(f.id);
    await call(contribute.POST, { user: f, params: { id: p.data.projectId }, body: { currency: 100_00, resources: { stone: 3 } } });
    expect((await call(cancelProject.POST, { user: f, params: { id: p.data.projectId } })).status).toBe(200);
    expect(await balance(f.id)).toBe(before);
    await assertLedgerConsistent();
  });

  it('enforces voting rules: eligibility, no double voting, quorum, and executes passed proposals', async () => {
    const { f, sid } = await founder();
    const a = await join(sid, f);
    const b = await join(sid, f);
    const outsider = await registerUser();
    const prop = await call(proposals.POST, { user: f, params: { id: sid }, body: { type: 'treasury_transfer', title: 'Reward Alice', payload: { toUserId: a.id, amount: 1_000_00 } } });
    expect(prop.status, JSON.stringify(prop.error)).toBe(200);
    const id = prop.data.proposalId;
    expect((await call(vote.POST, { user: outsider, params: { id }, body: { choice: 'yes' } })).status).toBe(403);
    expect((await call(vote.POST, { user: f, params: { id }, body: { choice: 'yes' } })).status).toBe(200);
    expect((await call(vote.POST, { user: f, params: { id }, body: { choice: 'no' } })).status).toBe(409);
    expect((await call(vote.POST, { user: a, params: { id }, body: { choice: 'yes' } })).status).toBe(200);
    const aBefore = await balance(a.id);
    // Deadline passes (server time) -> worker finalises: 2/3 turnout >= 50% quorum, 2 yes > 50%.
    await getPool().query("UPDATE proposals SET closes_at = now() - interval '1 second', opens_at = now() - interval '2 seconds' WHERE id = $1", [id]);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE type = 'proposal.finalize'");
    await processDueJobs();
    const p = await getPool().query('SELECT status FROM proposals WHERE id = $1', [id]);
    expect(p.rows[0].status).toBe('executed');
    expect(await balance(a.id)).toBe(aBefore + 1_000_00);
    // Votes on a closed proposal are refused, and recorded votes are immutable.
    expect((await call(vote.POST, { user: b, params: { id }, body: { choice: 'no' } })).status).toBe(409);
    await expect(getPool().query("UPDATE votes SET choice = 'no' WHERE proposal_id = $1", [id])).rejects.toThrow(/append-only/);
    await assertLedgerConsistent();
  });

  it('rejects proposals that miss quorum', async () => {
    const { f, sid } = await founder();
    await join(sid, f);
    await join(sid, f);
    await join(sid, f);
    const prop = await call(proposals.POST, { user: f, params: { id: sid }, body: { type: 'governance_change', title: 'Faster votes', payload: { quorumPct: 30, approvalPct: 60, votingHours: 2 } } });
    await call(vote.POST, { user: f, params: { id: prop.data.proposalId }, body: { choice: 'yes' } });
    await getPool().query("UPDATE proposals SET closes_at = now() - interval '1 second', opens_at = now() - interval '2 seconds' WHERE id = $1", [prop.data.proposalId]);
    await getPool().query("INSERT INTO jobs (type) VALUES ('proposal.sweep')");
    await processDueJobs();
    const p = await getPool().query('SELECT status, result FROM proposals WHERE id = $1', [prop.data.proposalId]);
    expect(p.rows[0].status).toBe('rejected');
    expect(p.rows[0].result.quorumMet).toBe(false);
  });

  it('settlement land: members donate parcels; non-permitted members cannot build there', async () => {
    const { f, sid } = await founder();
    const m = await join(sid, f);
    await setLevel(m.id, 3);
    expect((await call(purchase.POST, { body: { name: 'Test land' }, user: m, params: { id: second } })).status).toBe(200);
    expect((await call(donate.POST, { user: m, params: { id: sid }, body: { parcelId: second } })).status).toBe(200);
    const [sx, sy] = parcelCenter(second);
    const denied = await call(build.POST, { user: m, body: { type: 'park', parcelId: second, lng: sx, lat: sy, rotation: 0 } });
    expect(denied.status).toBe(403);
    const ok = await call(build.POST, { user: f, body: { type: 'park', parcelId: second, lng: sx, lat: sy, rotation: 0 } });
    expect(ok.status).toBe(200);
    const zoning = await call(build.POST, { user: f, body: { type: 'lumber_camp', parcelId: home, lng: hx, lat: hy, rotation: 0 } });
    expect(zoning.error?.code).toBe('requirements_not_met');
  });
});

describe('governance rules', () => {
  it('tally', () => {
    expect(tallyPasses(2, 1, 0, 4, 50, 50)).toEqual({ quorumMet: true, passed: true });
    expect(tallyPasses(1, 1, 0, 4, 50, 50)).toEqual({ quorumMet: true, passed: false });
    expect(tallyPasses(1, 0, 0, 4, 50, 50)).toEqual({ quorumMet: false, passed: false });
    expect(tallyPasses(0, 0, 3, 4, 50, 50)).toEqual({ quorumMet: true, passed: false });
  });
});

describe('research', () => {
  beforeEach(resetGame);

  it('unlocks technologies that gate real functionality', async () => {
    const u = await registerUser();
    await setLevel(u.id, 3);
    expect((await call(purchase.POST, { body: { name: 'Test land' }, user: u, params: { id: home } })).status).toBe(200);
    const body = { type: 'restaurant', parcelId: home, lng: hx, lat: hy, rotation: 0 };
    expect((await call(build.POST, { user: u, body })).error?.code).toBe('requirements_not_met');
    expect((await call(research.POST, { user: u, params: { techId: 'retail_networks' } })).error?.code).toBe('requirements_not_met'); // prereq
    await getPool().query('UPDATE players SET research_points = 8 WHERE user_id = $1', [u.id]);
    expect((await call(research.POST, { user: u, params: { techId: 'commerce' } })).status).toBe(200);
    expect((await call(research.POST, { user: u, params: { techId: 'commerce' } })).status).toBe(409);
    expect((await call(build.POST, { user: u, body })).status).toBe(200);
  });

  it('rejects research without enough points', async () => {
    const u = await registerUser();
    const r = await call(research.POST, { user: u, params: { techId: 'mining' } });
    expect(r.error?.code).toBe('insufficient_resources');
  });
});
