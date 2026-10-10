import { getBuildingDef, upgradeCost } from '@/shared/config/buildings';
import { XP } from '@/shared/config/progression';
import { isResourceId, type ResourceId } from '@/shared/config/resources';
import {
  DEFAULT_GOVERNANCE, ROLE_RANK, SETTLEMENT_FOUNDING_COST, SETTLEMENT_MIN_LEVEL, getProjectType, hasPermission,
  settlementTier, tallyPasses, type SettlementPermission, type SettlementRole,
} from '@/shared/config/settlements';
import { parcelCenter, parcelIdAt } from '@/shared/grid';
import { footprintRing } from '@/shared/geo';
import type { Db, Tx } from '../db';
import { fail, GameError } from '../errors';
import { audit, notifyUser, publish } from '../events';
import { enqueue } from '../jobs';
import { playerAccountId, settlementAccountId, systemAccountId, transfer } from '../ledger';
import { addResources, removeResources, type ResourceMap } from './inventory';
import { buildingSummary, placeBuilding } from './buildings';
import { lockParcel, parcelEventPayload } from './land';
import { addXp, checkAchievements, publishWallet } from './players';

const MAX_SETTLEMENT_PARCELS = 60;

interface Governance { quorumPct: number; approvalPct: number; votingHours: number }

async function activity(tx: Tx, settlementId: string, actor: string | null, type: string, payload: Record<string, unknown> = {}) {
  await tx.query('INSERT INTO settlement_activity (settlement_id, actor_user_id, type, payload) VALUES ($1,$2,$3,$4)', [settlementId, actor, type, JSON.stringify(payload)]);
  await publish(tx, `settlement:${settlementId}`, 'activity', { type });
}

export async function memberRole(db: Db, settlementId: string, userId: string): Promise<SettlementRole | null> {
  const r = await db.query<{ role: SettlementRole }>('SELECT role FROM settlement_members WHERE settlement_id = $1 AND user_id = $2', [settlementId, userId]);
  return r.rows[0]?.role ?? null;
}

async function requirePermission(tx: Tx, settlementId: string, userId: string, perm: SettlementPermission): Promise<SettlementRole> {
  const role = await memberRole(tx, settlementId, userId);
  if (!role) fail('forbidden', 'You are not a member of this settlement');
  if (!hasPermission(role!, perm)) fail('forbidden', `Your role does not have the "${perm.replace(/_/g, ' ')}" permission`);
  return role!;
}

async function lockSettlement(tx: Tx, settlementId: string) {
  const r = await tx.query<{ id: string; name: string; founder_user_id: string; governance: Governance }>('SELECT id, name, founder_user_id, governance FROM settlements WHERE id = $1 FOR UPDATE', [settlementId]);
  if (!r.rows[0]) fail('not_found', 'Settlement not found');
  return r.rows[0];
}

async function memberIds(db: Db, settlementId: string): Promise<string[]> {
  const r = await db.query<{ user_id: string }>('SELECT user_id FROM settlement_members WHERE settlement_id = $1', [settlementId]);
  return r.rows.map((x) => x.user_id);
}

async function notifyMembers(tx: Tx, settlementId: string, type: string, title: string, body = '', except?: string) {
  for (const uid of await memberIds(tx, settlementId)) if (uid !== except) await notifyUser(tx, uid, type, title, body, { settlementId });
}

async function tierOf(db: Db, settlementId: string) {
  const r = await db.query<{ members: number; projects: number }>(
    `SELECT (SELECT count(*)::int FROM settlement_members WHERE settlement_id = $1) AS members,
            (SELECT count(*)::int FROM settlement_projects WHERE settlement_id = $1 AND status = 'completed') AS projects`,
    [settlementId],
  );
  return { ...r.rows[0], tier: settlementTier(r.rows[0].members, r.rows[0].projects) };
}

// ---------------------------------------------------------------------------
// Founding, discovery, details
// ---------------------------------------------------------------------------

export async function createSettlement(tx: Tx, userId: string, input: { name: string; description: string; parcelId?: string }, opKey: string) {
  const p = await tx.query<{ level: number; home_lng: number | null; home_lat: number | null }>('SELECT level, home_lng, home_lat FROM players WHERE user_id = $1 FOR UPDATE', [userId]);
  if (p.rows[0].level < SETTLEMENT_MIN_LEVEL) fail('requirements_not_met', `Founding a settlement requires level ${SETTLEMENT_MIN_LEVEL}`);
  if (await tx.query('SELECT 1 FROM settlement_members WHERE user_id = $1', [userId]).then((r) => r.rowCount)) fail('conflict', 'Leave your current settlement first');
  const dup = await tx.query('SELECT 1 FROM settlements WHERE lower(name) = lower($1)', [input.name]);
  if (dup.rowCount) fail('conflict', 'A settlement with that name already exists');

  let center: [number, number] | null = p.rows[0].home_lng != null ? [p.rows[0].home_lng, p.rows[0].home_lat!] : null;
  if (input.parcelId) {
    const parcel = await lockParcel(tx, input.parcelId);
    if (!parcel || parcel.owner_user_id !== userId) fail('forbidden', 'You can only found a settlement on a parcel you own');
    center = parcelCenter(input.parcelId);
  }
  if (!center) fail('requirements_not_met', 'Own at least one parcel before founding a settlement');

  const s = await tx.query<{ id: string }>(
    'INSERT INTO settlements (name, description, founder_user_id, center, governance) VALUES ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326), $6) RETURNING id',
    [input.name, input.description, userId, center![0], center![1], JSON.stringify(DEFAULT_GOVERNANCE)],
  );
  const sid = s.rows[0].id;
  await tx.query("INSERT INTO settlement_members (settlement_id, user_id, role) VALUES ($1,$2,'founder')", [sid, userId]);
  const treasury = await tx.query<{ id: string }>("INSERT INTO accounts (kind, settlement_id) VALUES ('settlement', $1) RETURNING id", [sid]);
  // The founding fee seeds the treasury.
  await transfer(tx, {
    from: await playerAccountId(tx, userId), to: treasury.rows[0].id, amount: SETTLEMENT_FOUNDING_COST, type: 'settlement_founding',
    idempotencyKey: `${opKey}:found`, refs: { actorUserId: userId, settlementId: sid }, insufficientMessage: 'Insufficient funds to found a settlement',
  });
  if (input.parcelId) await moveParcelToSettlement(tx, input.parcelId, userId, sid, 'founding_grant');
  await activity(tx, sid, userId, 'founded', { name: input.name });
  await audit(tx, userId, 'settlement.create', 'settlement', sid, { name: input.name });
  await addXp(tx, userId, XP.settlementFounded);
  await checkAchievements(tx, userId, ['settlement_founded']);
  await publishWallet(tx, userId);
  await publish(tx, `user:${userId}`, 'player', {});
  return { id: sid, name: input.name };
}

async function moveParcelToSettlement(tx: Tx, parcelId: string, fromUserId: string | null, settlementId: string, reason: string, price = 0, ledgerEntryId: number | null = null) {
  const cnt = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM parcels WHERE settlement_id = $1', [settlementId]);
  if (cnt.rows[0].n >= MAX_SETTLEMENT_PARCELS) fail('requirements_not_met', `Settlements may hold at most ${MAX_SETTLEMENT_PARCELS} parcels`);
  await tx.query('UPDATE parcels SET owner_user_id = NULL, settlement_id = $2, updated_at = now() WHERE id = $1', [parcelId, settlementId]);
  await tx.query(
    'INSERT INTO parcel_ownership_history (parcel_id, from_user_id, to_settlement_id, price, reason, ledger_entry_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [parcelId, fromUserId, settlementId, price, reason, ledgerEntryId],
  );
  const payload = await parcelEventPayload(tx, parcelId);
  const ck = await tx.query<{ chunk_key: string }>('SELECT chunk_key FROM parcels WHERE id = $1', [parcelId]);
  await publish(tx, `chunk:${ck.rows[0].chunk_key}`, 'parcel', payload as Record<string, unknown>);
}

export async function listSettlements(db: Db, near?: { lng: number; lat: number }) {
  const r = await db.query(
    `SELECT s.id, s.name, s.description, ST_X(s.center) AS lng, ST_Y(s.center) AS lat, u.display_name AS founder,
            (SELECT count(*)::int FROM settlement_members m WHERE m.settlement_id = s.id) AS members,
            (SELECT count(*)::int FROM settlement_projects p WHERE p.settlement_id = s.id AND p.status = 'completed') AS "completedProjects",
            CASE WHEN $1::float8 IS NULL THEN NULL ELSE ST_Distance(s.center::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) END AS "distanceM"
       FROM settlements s JOIN users u ON u.id = s.founder_user_id
      ORDER BY CASE WHEN $1::float8 IS NULL THEN 0 ELSE ST_Distance(s.center::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) END,
               s.created_at DESC
      LIMIT 50`,
    [near?.lng ?? null, near?.lat ?? null],
  );
  return r.rows.map((s) => ({ ...s, tier: settlementTier(s.members, s.completedProjects).name }));
}

export async function getSettlement(db: Db, settlementId: string, viewerId: string) {
  const s = await db.query(
    `SELECT s.id, s.name, s.description, s.founder_user_id AS "founderId", s.governance, s.created_at AS "createdAt",
            ST_X(s.center) AS lng, ST_Y(s.center) AS lat, a.balance AS treasury
       FROM settlements s JOIN accounts a ON a.settlement_id = s.id WHERE s.id = $1`,
    [settlementId],
  );
  if (!s.rows[0]) fail('not_found', 'Settlement not found');
  const role = await memberRole(db, settlementId, viewerId);
  const [members, projects, proposals, activityRows, parcels, invites, tier] = await Promise.all([
    db.query(
      `SELECT m.user_id AS "userId", u.display_name AS name, u.username, m.role, m.joined_at AS "joinedAt", p.level, p.reputation
         FROM settlement_members m JOIN users u ON u.id = m.user_id JOIN players p ON p.user_id = m.user_id
        WHERE m.settlement_id = $1 ORDER BY m.joined_at`,
      [settlementId],
    ),
    db.query(
      `SELECT pr.id, pr.type, pr.name, pr.status, pr.status_note AS "statusNote", pr.parcel_id AS "parcelId", pr.cost_currency AS "costCurrency",
              pr.funded_currency AS "fundedCurrency", pr.required_resources AS "requiredResources", pr.funded_resources AS "fundedResources",
              u.display_name AS "proposedBy", pr.created_at AS "createdAt", pr.completed_at AS "completedAt", pr.result_building_id AS "resultBuildingId",
              ST_X(pr.position) AS lng, ST_Y(pr.position) AS lat
         FROM settlement_projects pr JOIN users u ON u.id = pr.proposed_by
        WHERE pr.settlement_id = $1 ORDER BY (pr.status = 'active') DESC, pr.created_at DESC LIMIT 50`,
      [settlementId],
    ),
    db.query(
      `SELECT p.id, p.type, p.title, p.payload, p.status, p.quorum_pct AS "quorumPct", p.approval_pct AS "approvalPct",
              array_length(p.eligible_voters, 1) AS eligible, p.closes_at AS "closesAt", p.result, u.display_name AS "proposedBy",
              $2 = ANY(p.eligible_voters) AS "canVote",
              (SELECT choice FROM votes v WHERE v.proposal_id = p.id AND v.user_id = $2) AS "myVote",
              (SELECT count(*)::int FROM votes v WHERE v.proposal_id = p.id AND v.choice = 'yes') AS yes,
              (SELECT count(*)::int FROM votes v WHERE v.proposal_id = p.id AND v.choice = 'no') AS no,
              (SELECT count(*)::int FROM votes v WHERE v.proposal_id = p.id AND v.choice = 'abstain') AS abstain
         FROM proposals p JOIN users u ON u.id = p.proposed_by
        WHERE p.settlement_id = $1 ORDER BY (p.status = 'open') DESC, p.created_at DESC LIMIT 30`,
      [settlementId, viewerId],
    ),
    db.query(
      `SELECT a.id, a.type, a.payload, a.created_at AS "at", u.display_name AS actor
         FROM settlement_activity a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.settlement_id = $1 ORDER BY a.id DESC LIMIT 40`,
      [settlementId],
    ),
    db.query(
      `SELECT p.id, ST_X(p.centroid) AS lng, ST_Y(p.centroid) AS lat, p.land_class AS "landClass",
              (SELECT count(*)::int FROM buildings b WHERE b.parcel_id = p.id) AS buildings
         FROM parcels p WHERE p.settlement_id = $1 ORDER BY p.updated_at`,
      [settlementId],
    ),
    role && hasPermission(role, 'invite')
      ? db.query(
          `SELECT i.id, u.display_name AS invitee, u.username, i.created_at AS "createdAt" FROM settlement_invites i JOIN users u ON u.id = i.invitee_user_id
            WHERE i.settlement_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`,
          [settlementId],
        )
      : Promise.resolve({ rows: [] }),
    tierOf(db, settlementId),
  ]);
  return {
    ...s.rows[0],
    tier: tier.tier,
    myRole: role,
    members: members.rows,
    projects: projects.rows,
    proposals: proposals.rows,
    activity: activityRows.rows,
    parcels: parcels.rows,
    invites: invites.rows,
  };
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export async function inviteMember(tx: Tx, actorId: string, settlementId: string, username: string) {
  const s = await lockSettlement(tx, settlementId);
  await requirePermission(tx, settlementId, actorId, 'invite');
  const u = await tx.query<{ id: string }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (!u.rows[0]) fail('not_found', 'No player with that username');
  const target = u.rows[0].id;
  if (await tx.query('SELECT 1 FROM settlement_members WHERE user_id = $1', [target]).then((r) => r.rowCount)) fail('conflict', 'That player already belongs to a settlement');
  const { members, tier } = await tierOf(tx, settlementId);
  if (members >= tier.memberCap) fail('requirements_not_met', `${tier.name} settlements are limited to ${tier.memberCap} members`);
  const ins = await tx.query<{ id: string }>(
    'INSERT INTO settlement_invites (settlement_id, invitee_user_id, invited_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',
    [settlementId, target, actorId],
  );
  if (!ins.rows[0]) fail('conflict', 'That player already has a pending invitation');
  await notifyUser(tx, target, 'settlement_invite', `Invitation to join ${s.name}`, 'Open Settlements to accept or decline.', { settlementId, inviteId: ins.rows[0].id });
  await activity(tx, settlementId, actorId, 'invited', { username });
  return { inviteId: ins.rows[0].id };
}

export async function myInvites(db: Db, userId: string) {
  const r = await db.query(
    `SELECT i.id, i.settlement_id AS "settlementId", s.name AS "settlementName", u.display_name AS "invitedBy", i.created_at AS "createdAt"
       FROM settlement_invites i JOIN settlements s ON s.id = i.settlement_id JOIN users u ON u.id = i.invited_by
      WHERE i.invitee_user_id = $1 AND i.status = 'pending' ORDER BY i.created_at DESC`,
    [userId],
  );
  return r.rows;
}

export async function respondInvite(tx: Tx, userId: string, inviteId: string, accept: boolean) {
  const r = await tx.query<{ settlement_id: string; invitee_user_id: string; status: string }>('SELECT settlement_id, invitee_user_id, status FROM settlement_invites WHERE id = $1 FOR UPDATE', [inviteId]);
  const inv = r.rows[0];
  if (!inv || inv.invitee_user_id !== userId) fail('not_found', 'Invitation not found');
  if (inv.status !== 'pending') fail('conflict', `Invitation already ${inv.status}`);
  if (!accept) {
    await tx.query("UPDATE settlement_invites SET status = 'declined', responded_at = now() WHERE id = $1", [inviteId]);
    return { status: 'declined' };
  }
  await lockSettlement(tx, inv.settlement_id);
  if (await tx.query('SELECT 1 FROM settlement_members WHERE user_id = $1', [userId]).then((x) => x.rowCount)) fail('conflict', 'Leave your current settlement first');
  const { members, tier } = await tierOf(tx, inv.settlement_id);
  if (members >= tier.memberCap) fail('requirements_not_met', 'This settlement is full');
  await tx.query("INSERT INTO settlement_members (settlement_id, user_id, role) VALUES ($1,$2,'member')", [inv.settlement_id, userId]);
  await tx.query("UPDATE settlement_invites SET status = 'accepted', responded_at = now() WHERE id = $1", [inviteId]);
  await tx.query("UPDATE settlement_invites SET status = 'revoked', responded_at = now() WHERE invitee_user_id = $1 AND status = 'pending'", [userId]);
  await activity(tx, inv.settlement_id, userId, 'joined');
  await publish(tx, `user:${userId}`, 'player', {});
  return { status: 'accepted', settlementId: inv.settlement_id };
}

export async function revokeInvite(tx: Tx, actorId: string, inviteId: string) {
  const r = await tx.query<{ settlement_id: string; status: string }>('SELECT settlement_id, status FROM settlement_invites WHERE id = $1 FOR UPDATE', [inviteId]);
  if (!r.rows[0]) fail('not_found', 'Invitation not found');
  await requirePermission(tx, r.rows[0].settlement_id, actorId, 'invite');
  if (r.rows[0].status !== 'pending') fail('conflict', 'Invitation is no longer pending');
  await tx.query("UPDATE settlement_invites SET status = 'revoked', responded_at = now() WHERE id = $1", [inviteId]);
  return { status: 'revoked' };
}

async function removeMembership(tx: Tx, settlementId: string, userId: string, actorId: string | null, type: string) {
  await tx.query('DELETE FROM settlement_members WHERE settlement_id = $1 AND user_id = $2', [settlementId, userId]);
  await activity(tx, settlementId, actorId, type, { userId });
  await publish(tx, `user:${userId}`, 'player', {});
}

export async function removeMember(tx: Tx, actorId: string, settlementId: string, targetId: string) {
  await lockSettlement(tx, settlementId);
  const actorRole = await requirePermission(tx, settlementId, actorId, 'manage_members');
  const targetRole = await memberRole(tx, settlementId, targetId);
  if (!targetRole) fail('not_found', 'That player is not a member');
  if (targetId === actorId) fail('invalid_input', 'Use "leave settlement" instead');
  if (ROLE_RANK[actorRole] <= ROLE_RANK[targetRole!]) fail('forbidden', 'You can only remove members of a lower rank');
  await removeMembership(tx, settlementId, targetId, actorId, 'removed');
  await audit(tx, actorId, 'settlement.remove_member', 'settlement', settlementId, { targetId });
  await notifyUser(tx, targetId, 'settlement_removed', 'You were removed from a settlement');
  return { removed: targetId };
}

export async function leaveSettlement(tx: Tx, userId: string, settlementId: string) {
  await lockSettlement(tx, settlementId);
  const role = await memberRole(tx, settlementId, userId);
  if (!role) fail('not_found', 'You are not a member of this settlement');
  if (role === 'founder') fail('forbidden', 'The founder cannot leave the settlement');
  await removeMembership(tx, settlementId, userId, userId, 'left');
  return { left: settlementId };
}

export async function setRole(tx: Tx, actorId: string, settlementId: string, targetId: string, role: SettlementRole, viaProposal = false) {
  await lockSettlement(tx, settlementId);
  if (role === 'founder') fail('forbidden', 'The founder role cannot be assigned');
  const targetRole = await memberRole(tx, settlementId, targetId);
  if (!targetRole) fail('not_found', 'That player is not a member');
  if (targetRole === 'founder') fail('forbidden', "The founder's role cannot be changed");
  if (!viaProposal) {
    const actorRole = await requirePermission(tx, settlementId, actorId, 'manage_roles');
    // Leadership changes need the founder or a passed governance vote.
    if (ROLE_RANK[actorRole] <= ROLE_RANK[targetRole!] || ROLE_RANK[actorRole] <= ROLE_RANK[role]) {
      fail('forbidden', 'This role change requires the founder or a passed governance proposal');
    }
  }
  await tx.query('UPDATE settlement_members SET role = $3 WHERE settlement_id = $1 AND user_id = $2', [settlementId, targetId, role]);
  await activity(tx, settlementId, actorId, 'role_changed', { userId: targetId, role });
  await audit(tx, actorId, 'settlement.set_role', 'settlement', settlementId, { targetId, role, viaProposal });
  await notifyUser(tx, targetId, 'settlement_role', `Your settlement role is now ${role.replace(/_/g, ' ')}`);
  return { userId: targetId, role };
}

// ---------------------------------------------------------------------------
// Settlement land
// ---------------------------------------------------------------------------

export async function donateParcel(tx: Tx, userId: string, settlementId: string, parcelId: string) {
  await lockSettlement(tx, settlementId);
  await requirePermission(tx, settlementId, userId, 'contribute');
  const parcel = await lockParcel(tx, parcelId);
  if (!parcel || parcel.owner_user_id !== userId) fail('forbidden', 'You can only donate parcels you own');
  const b = await tx.query('SELECT 1 FROM buildings WHERE parcel_id = $1', [parcelId]);
  if (b.rowCount) fail('requirements_not_met', 'Only empty parcels can be donated');
  await tx.query('DELETE FROM parcel_permissions WHERE parcel_id = $1', [parcelId]);
  await moveParcelToSettlement(tx, parcelId, userId, settlementId, 'donation');
  await activity(tx, settlementId, userId, 'parcel_donated', { parcelId });
  return { parcelId, settlementId };
}

// ---------------------------------------------------------------------------
// Shared projects
// ---------------------------------------------------------------------------

export interface ProjectInput {
  type: string;
  name: string;
  parcelId?: string;
  lng?: number;
  lat?: number;
  rotation?: number;
  targetBuildingId?: string;
}

export async function proposeProject(tx: Tx, userId: string, settlementId: string, input: ProjectInput) {
  await lockSettlement(tx, settlementId);
  await requirePermission(tx, settlementId, userId, 'propose_projects');
  const pt = getProjectType(input.type);
  if (!pt) fail('invalid_input', 'Unknown project type');
  const active = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM settlement_projects WHERE settlement_id = $1 AND status = 'active'", [settlementId]);
  if (active.rows[0].n >= 10) fail('requirements_not_met', 'At most 10 active projects per settlement');

  let cost = 0;
  let resources: ResourceMap = {};
  let parcelId: string | null = null;
  let position: [number, number] | null = null;
  let rotation = 0;
  let target: string | null = null;
  if (pt!.upgradeExisting) {
    if (!input.targetBuildingId) fail('invalid_input', 'Choose a settlement building to upgrade');
    const b = await tx.query<{ type: string; level: number; settlement_id: string | null }>('SELECT type, level, settlement_id FROM buildings WHERE id = $1', [input.targetBuildingId]);
    if (!b.rows[0] || b.rows[0].settlement_id !== settlementId) fail('invalid_input', 'Target must be a settlement-owned building');
    const def = getBuildingDef(b.rows[0].type)!;
    if (b.rows[0].level >= def.maxLevel) fail('requirements_not_met', `${def.name} is already at maximum level`);
    const uc = upgradeCost(def, b.rows[0].level + 1);
    cost = Math.round(uc.cost * pt!.costMultiplier);
    resources = Object.fromEntries(Object.entries(uc.resources).map(([r, q]) => [r, Math.ceil((q ?? 0) * pt!.costMultiplier)]));
    target = input.targetBuildingId!;
  } else {
    const def = getBuildingDef(pt!.building!)!;
    if (!input.parcelId || input.lng === undefined || input.lat === undefined) fail('invalid_input', 'Choose a site on settlement land');
    const parcel = await tx.query<{ settlement_id: string | null; land_class: string }>('SELECT settlement_id, land_class FROM parcels WHERE id = $1', [input.parcelId]);
    if (parcel.rows[0]?.settlement_id !== settlementId) fail('invalid_placement', 'The project site must be on settlement land');
    if (parcelIdAt(input.lng!, input.lat!) !== input.parcelId) fail('invalid_placement', 'The project centre must be inside the chosen parcel');
    rotation = ((Math.round(input.rotation ?? 0) % 360) + 360) % 360;
    const fp = JSON.stringify({ type: 'Polygon', coordinates: [footprintRing([input.lng!, input.lat!], def.width, def.depth, rotation)] });
    const ok = await tx.query<{ inside: boolean; clash: boolean }>(
      `SELECT ST_CoveredBy(ST_SetSRID(ST_GeomFromGeoJSON($1),4326), p.geom) AS inside,
              EXISTS (SELECT 1 FROM buildings b WHERE b.footprint && ST_SetSRID(ST_GeomFromGeoJSON($1),4326)
                        AND ST_Relate(b.footprint, ST_SetSRID(ST_GeomFromGeoJSON($1),4326), 'T********')) AS clash
         FROM parcels p WHERE p.id = $2`,
      [fp, input.parcelId],
    );
    if (!ok.rows[0].inside) fail('invalid_placement', 'The building must fit inside the parcel');
    if (ok.rows[0].clash) fail('invalid_placement', 'The site overlaps an existing building');
    cost = Math.round(def.cost * pt!.costMultiplier);
    resources = Object.fromEntries(Object.entries(def.resources).map(([r, q]) => [r, Math.ceil((q ?? 0) * pt!.costMultiplier)]));
    parcelId = input.parcelId!;
    position = [input.lng!, input.lat!];
  }
  const r = await tx.query<{ id: string }>(
    `INSERT INTO settlement_projects (settlement_id, type, name, parcel_id, position, rotation_deg, target_building_id, cost_currency, required_resources, proposed_by)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($5,$6),4326) END, $7,$8,$9,$10,$11) RETURNING id`,
    [settlementId, pt!.type, input.name, parcelId, position?.[0] ?? null, position?.[1] ?? null, rotation, target, cost, JSON.stringify(resources), userId],
  );
  await activity(tx, settlementId, userId, 'project_proposed', { projectId: r.rows[0].id, name: input.name });
  await notifyMembers(tx, settlementId, 'settlement_project', `New project: ${input.name}`, 'Contribute credits or resources to complete it.', userId);
  return { projectId: r.rows[0].id, cost, resources };
}

async function lockProject(tx: Tx, projectId: string) {
  const r = await tx.query<{
    id: string; settlement_id: string; type: string; name: string; status: string; parcel_id: string | null; lng: number | null; lat: number | null;
    rotation_deg: number; target_building_id: string | null; cost_currency: number; funded_currency: number;
    required_resources: ResourceMap; funded_resources: ResourceMap; proposed_by: string;
  }>(
    `SELECT id, settlement_id, type, name, status, parcel_id, ST_X(position) AS lng, ST_Y(position) AS lat, rotation_deg, target_building_id,
            cost_currency, funded_currency, required_resources, funded_resources, proposed_by
       FROM settlement_projects WHERE id = $1 FOR UPDATE`,
    [projectId],
  );
  if (!r.rows[0]) fail('not_found', 'Project not found');
  return r.rows[0];
}

export async function contribute(tx: Tx, userId: string, projectId: string, input: { currency?: number; resources?: Record<string, number>; fromTreasury?: boolean }, opKey: string) {
  const pr = await lockProject(tx, projectId);
  await requirePermission(tx, pr.settlement_id, userId, input.fromTreasury ? 'approve_spending' : 'contribute');
  if (pr.status !== 'active') fail('conflict', `Project is ${pr.status}`);

  const escrow = await systemAccountId(tx, 'project_escrow');
  const source = input.fromTreasury ? 'treasury' : 'player';
  let currency = 0;
  const neededCurrency = pr.cost_currency - pr.funded_currency;
  if (input.currency && input.currency > 0) {
    currency = Math.min(input.currency, neededCurrency);
    if (currency <= 0) fail('conflict', 'The credit requirement is already fully funded');
    const entry = await transfer(tx, {
      from: input.fromTreasury ? await settlementAccountId(tx, pr.settlement_id) : await playerAccountId(tx, userId),
      to: escrow, amount: currency, type: 'project_contribution', idempotencyKey: `${opKey}:project_currency`,
      refs: { actorUserId: userId, projectId, settlementId: pr.settlement_id },
      insufficientMessage: input.fromTreasury ? 'The treasury has insufficient funds' : 'Insufficient funds',
    });
    await tx.query('UPDATE settlement_projects SET funded_currency = funded_currency + $2 WHERE id = $1', [projectId, currency]);
    await tx.query("INSERT INTO project_contributions (project_id, user_id, source, kind, amount, ledger_entry_id) VALUES ($1,$2,$3,'currency',$4,$5)", [projectId, userId, source, currency, entry]);
  }
  const given: ResourceMap = {};
  if (input.resources && !input.fromTreasury) {
    const funded = { ...pr.funded_resources };
    for (const [res, q] of Object.entries(input.resources)) {
      if (!isResourceId(res) || !q || q <= 0) continue;
      const need = (pr.required_resources[res] ?? 0) - (funded[res] ?? 0);
      const amt = Math.min(Math.floor(q), need);
      if (amt <= 0) continue;
      given[res] = amt;
      funded[res] = (funded[res] ?? 0) + amt;
    }
    await removeResources(tx, userId, given);
    for (const [res, amt] of Object.entries(given)) {
      await tx.query("INSERT INTO project_contributions (project_id, user_id, source, kind, resource, amount) VALUES ($1,$2,'player','resource',$3,$4)", [projectId, userId, res, amt]);
    }
    await tx.query('UPDATE settlement_projects SET funded_resources = $2 WHERE id = $1', [projectId, JSON.stringify(funded)]);
  }
  if (currency === 0 && Object.keys(given).length === 0) fail('invalid_input', 'Nothing to contribute: the project does not need that');

  if (!input.fromTreasury) {
    await addXp(tx, userId, Math.floor(currency / 100_000) * XP.contributionPer1000Credits + Object.values(given).reduce((a, b) => a + (b ?? 0), 0));
    await tx.query('UPDATE players SET reputation = reputation + $2 WHERE user_id = $1', [userId, Math.floor(currency / 100_000)]);
    await checkAchievements(tx, userId, ['contributed_credits']);
    await publishWallet(tx, userId);
    await publish(tx, `user:${userId}`, 'inventory', {});
  }
  await activity(tx, pr.settlement_id, userId, 'contributed', { projectId, currency, resources: given, source });
  const done = await tryCompleteProject(tx, projectId);
  return { projectId, currency, resources: given, completed: done };
}

/** Completes a fully funded project, creating the persistent world change. */
async function tryCompleteProject(tx: Tx, projectId: string): Promise<boolean> {
  const pr = await lockProject(tx, projectId);
  if (pr.status !== 'active' || pr.funded_currency < pr.cost_currency) return false;
  for (const [res, q] of Object.entries(pr.required_resources)) if ((pr.funded_resources[res as ResourceId] ?? 0) < (q ?? 0)) return false;

  const pt = getProjectType(pr.type)!;
  await tx.query('SAVEPOINT complete_project');
  try {
    let buildingId: string;
    if (pt.upgradeExisting) {
      const b = await tx.query<{ id: string; type: string; level: number }>('SELECT id, type, level FROM buildings WHERE id = $1 AND settlement_id = $2 FOR UPDATE', [pr.target_building_id, pr.settlement_id]);
      if (!b.rows[0]) fail('invalid_placement', 'The target building no longer exists');
      if (b.rows[0].level >= getBuildingDef(b.rows[0].type)!.maxLevel) fail('requirements_not_met', 'Target is already at maximum level');
      await tx.query('UPDATE buildings SET level = level + 1, updated_at = now() WHERE id = $1', [b.rows[0].id]);
      buildingId = b.rows[0].id;
    } else {
      const placed = await placeBuilding(tx, pr.proposed_by, { type: pt.building!, parcelId: pr.parcel_id!, lng: pr.lng!, lat: pr.lat!, rotation: pr.rotation_deg }, `project:${projectId}`, {
        asSettlementProject: { settlementId: pr.settlement_id, projectId },
      });
      buildingId = placed.building.id;
    }
    if (pr.cost_currency > 0) {
      await transfer(tx, {
        from: await systemAccountId(tx, 'project_escrow'), to: await systemAccountId(tx, 'construction'), amount: pr.cost_currency,
        type: 'project_spend', idempotencyKey: `project:${projectId}:spend`, refs: { projectId, settlementId: pr.settlement_id, buildingId },
      });
    }
    await tx.query("UPDATE settlement_projects SET status = 'completed', completed_at = now(), result_building_id = $2, status_note = NULL WHERE id = $1", [projectId, buildingId]);
    await tx.query('RELEASE SAVEPOINT complete_project');
    if (pt.upgradeExisting) {
      const s = await buildingSummary(tx, buildingId);
      await publish(tx, `chunk:${s.chunkKey}`, 'building', { building: s.building });
    }
    await activity(tx, pr.settlement_id, null, 'project_completed', { projectId, name: pr.name, buildingId });
    await notifyMembers(tx, pr.settlement_id, 'settlement_project', `Project completed: ${pr.name}`);
    return true;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT complete_project');
    if (!(err instanceof GameError)) throw err;
    await tx.query("UPDATE settlement_projects SET status = 'blocked', status_note = $2 WHERE id = $1", [projectId, err.message]);
    await activity(tx, pr.settlement_id, null, 'project_blocked', { projectId, reason: err.message });
    return false;
  }
}

export async function cancelProject(tx: Tx, actorId: string, projectId: string) {
  const pr = await lockProject(tx, projectId);
  await requirePermission(tx, pr.settlement_id, actorId, 'approve_spending');
  if (pr.status !== 'active' && pr.status !== 'blocked') fail('conflict', `Project is ${pr.status}`);
  const escrow = await systemAccountId(tx, 'project_escrow');
  const contribs = await tx.query<{ id: number; user_id: string; source: string; kind: string; resource: string | null; amount: number }>(
    'SELECT id, user_id, source, kind, resource, amount FROM project_contributions WHERE project_id = $1 ORDER BY id',
    [projectId],
  );
  for (const c of contribs.rows) {
    if (c.kind === 'currency') {
      const to = c.source === 'treasury' ? await settlementAccountId(tx, pr.settlement_id) : await playerAccountId(tx, c.user_id);
      await transfer(tx, { from: escrow, to, amount: c.amount, type: 'project_refund', idempotencyKey: `project_refund:${c.id}`, refs: { projectId, settlementId: pr.settlement_id } });
      if (c.source === 'player') await publishWallet(tx, c.user_id);
    } else if (c.resource) {
      await addResources(tx, c.user_id, { [c.resource]: c.amount }, { ignoreCapacity: true });
      await publish(tx, `user:${c.user_id}`, 'inventory', {});
    }
  }
  await tx.query("UPDATE settlement_projects SET status = 'cancelled' WHERE id = $1", [projectId]);
  await activity(tx, pr.settlement_id, actorId, 'project_cancelled', { projectId, name: pr.name });
  await audit(tx, actorId, 'settlement.cancel_project', 'project', projectId, {});
  return { projectId, status: 'cancelled', refunded: contribs.rowCount };
}

export async function projectContributions(db: Db, projectId: string) {
  const r = await db.query(
    `SELECT c.id, u.display_name AS contributor, c.source, c.kind, c.resource, c.amount, c.created_at AS "at"
       FROM project_contributions c JOIN users u ON u.id = c.user_id WHERE c.project_id = $1 ORDER BY c.id DESC LIMIT 100`,
    [projectId],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export interface ProposalInput {
  type: 'treasury_transfer' | 'role_change' | 'remove_member' | 'governance_change';
  title: string;
  payload: Record<string, unknown>;
}

export async function createProposal(tx: Tx, userId: string, settlementId: string, input: ProposalInput) {
  const s = await lockSettlement(tx, settlementId);
  await requirePermission(tx, settlementId, userId, 'start_votes');
  const open = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM proposals WHERE settlement_id = $1 AND status = 'open'", [settlementId]);
  if (open.rows[0].n >= 10) fail('requirements_not_met', 'At most 10 open proposals');
  const p = input.payload;
  const isMember = async (id: unknown) => typeof id === 'string' && !!(await memberRole(tx, settlementId, id));
  switch (input.type) {
    case 'treasury_transfer':
      if (!(await isMember(p.toUserId))) fail('invalid_input', 'Recipient must be a member');
      if (!Number.isSafeInteger(p.amount) || (p.amount as number) <= 0) fail('invalid_input', 'Invalid amount');
      break;
    case 'role_change':
      if (!(await isMember(p.userId))) fail('invalid_input', 'Target must be a member');
      if (!['leader', 'treasurer', 'infrastructure_manager', 'member'].includes(p.role as string)) fail('invalid_input', 'Invalid role');
      if ((await memberRole(tx, settlementId, p.userId as string)) === 'founder') fail('forbidden', "The founder's role cannot be changed");
      break;
    case 'remove_member':
      if (!(await isMember(p.userId))) fail('invalid_input', 'Target must be a member');
      if ((await memberRole(tx, settlementId, p.userId as string)) === 'founder') fail('forbidden', 'The founder cannot be removed');
      break;
    case 'governance_change': {
      const ok = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
      if (!ok(p.quorumPct, 1, 100) || !ok(p.approvalPct, 50, 100) || !ok(p.votingHours, 1, 168)) fail('invalid_input', 'Quorum 1-100%, approval 50-100%, voting period 1-168 hours');
      break;
    }
    default:
      fail('invalid_input', 'Unknown proposal type');
  }
  const voters = await memberIds(tx, settlementId);
  const g = s.governance;
  const r = await tx.query<{ id: string; closes_at: Date }>(
    `INSERT INTO proposals (settlement_id, type, title, payload, proposed_by, eligible_voters, quorum_pct, approval_pct, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(hours => $9)) RETURNING id, closes_at`,
    [settlementId, input.type, input.title, JSON.stringify(p), userId, voters, g.quorumPct, g.approvalPct, g.votingHours],
  );
  await enqueue(tx, 'proposal.finalize', { proposalId: r.rows[0].id }, { runAt: r.rows[0].closes_at, dedupeKey: `proposal:${r.rows[0].id}` });
  await activity(tx, settlementId, userId, 'proposal_created', { proposalId: r.rows[0].id, title: input.title });
  await notifyMembers(tx, settlementId, 'settlement_vote', `Vote open: ${input.title}`, `Voting closes ${r.rows[0].closes_at.toISOString()}`, userId);
  return { proposalId: r.rows[0].id, closesAt: r.rows[0].closes_at };
}

export async function castVote(tx: Tx, userId: string, proposalId: string, choice: 'yes' | 'no' | 'abstain') {
  const r = await tx.query<{ settlement_id: string; status: string; open: boolean; eligible_voters: string[] }>(
    'SELECT settlement_id, status, closes_at > now() AS open, eligible_voters FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId],
  );
  const p = r.rows[0];
  if (!p) fail('not_found', 'Proposal not found');
  if (p.status !== 'open' || !p.open) fail('conflict', 'Voting on this proposal has closed');
  if (!p.eligible_voters.includes(userId)) fail('forbidden', 'You are not eligible to vote on this proposal');
  const role = await memberRole(tx, p.settlement_id, userId);
  if (!role || !hasPermission(role, 'vote')) fail('forbidden', 'Only current members may vote');
  const ins = await tx.query('INSERT INTO votes (proposal_id, user_id, choice) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [proposalId, userId, choice]);
  if (ins.rowCount === 0) fail('conflict', 'You have already voted on this proposal');
  await publish(tx, `settlement:${p.settlement_id}`, 'vote', { proposalId });
  const n = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM votes WHERE proposal_id = $1', [proposalId]);
  let finalized: string | null = null;
  if (n.rows[0].n >= p.eligible_voters.length) finalized = await finalizeProposal(tx, proposalId, true);
  return { proposalId, choice, finalized };
}

/** Tallies and executes a proposal. Runs from the worker at the deadline, or early once everyone voted. */
export async function finalizeProposal(tx: Tx, proposalId: string, allVoted = false): Promise<string | null> {
  const r = await tx.query<{ id: string; settlement_id: string; type: string; title: string; payload: Record<string, unknown>; status: string; due: boolean; eligible_voters: string[]; quorum_pct: number; approval_pct: number; proposed_by: string }>(
    'SELECT id, settlement_id, type, title, payload, status, closes_at <= now() AS due, eligible_voters, quorum_pct, approval_pct, proposed_by FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId],
  );
  const p = r.rows[0];
  if (!p || p.status !== 'open') return null;
  if (!p.due && !allVoted) return null;
  const v = await tx.query<{ choice: string; n: number }>('SELECT choice, count(*)::int AS n FROM votes WHERE proposal_id = $1 GROUP BY choice', [proposalId]);
  const count = (c: string) => v.rows.find((x) => x.choice === c)?.n ?? 0;
  const yes = count('yes');
  const no = count('no');
  const abstain = count('abstain');
  const t = tallyPasses(yes, no, abstain, p.eligible_voters.length, p.quorum_pct, p.approval_pct);
  let status = t.passed ? 'passed' : 'rejected';
  let note: string | null = t.passed ? null : t.quorumMet ? 'Not enough yes votes' : 'Quorum not reached';
  if (t.passed) {
    await tx.query('SAVEPOINT execute_proposal');
    try {
      await executeProposal(tx, p);
      await tx.query('RELEASE SAVEPOINT execute_proposal');
      status = 'executed';
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT execute_proposal');
      if (!(err instanceof GameError)) throw err;
      status = 'failed';
      note = `Passed but could not be executed: ${err.message}`;
    }
  }
  await tx.query('UPDATE proposals SET status = $2, result = $3, finalized_at = now() WHERE id = $1', [proposalId, status, JSON.stringify({ yes, no, abstain, eligible: p.eligible_voters.length, quorumMet: t.quorumMet, note })]);
  await activity(tx, p.settlement_id, null, 'proposal_finalized', { proposalId, title: p.title, status });
  await notifyMembers(tx, p.settlement_id, 'settlement_vote', `Proposal ${status}: ${p.title}`, note ?? '');
  return status;
}

async function executeProposal(tx: Tx, p: { id: string; settlement_id: string; type: string; payload: Record<string, unknown>; proposed_by: string }) {
  const sid = p.settlement_id;
  switch (p.type) {
    case 'treasury_transfer': {
      const to = p.payload.toUserId as string;
      if (!(await memberRole(tx, sid, to))) fail('conflict', 'Recipient is no longer a member');
      await transfer(tx, {
        from: await settlementAccountId(tx, sid), to: await playerAccountId(tx, to), amount: p.payload.amount as number,
        type: 'treasury_transfer', idempotencyKey: `proposal:${p.id}:transfer`, refs: { settlementId: sid }, metadata: { proposalId: p.id },
        insufficientMessage: 'The treasury has insufficient funds',
      });
      await publishWallet(tx, to);
      await audit(tx, null, 'settlement.treasury_transfer', 'settlement', sid, { proposalId: p.id, to, amount: p.payload.amount });
      break;
    }
    case 'role_change':
      await setRole(tx, p.proposed_by, sid, p.payload.userId as string, p.payload.role as SettlementRole, true);
      break;
    case 'remove_member': {
      const target = p.payload.userId as string;
      if (!(await memberRole(tx, sid, target))) fail('conflict', 'Target is no longer a member');
      await removeMembership(tx, sid, target, null, 'removed_by_vote');
      break;
    }
    case 'governance_change':
      await tx.query('UPDATE settlements SET governance = $2 WHERE id = $1', [sid, JSON.stringify({ quorumPct: p.payload.quorumPct, approvalPct: p.payload.approvalPct, votingHours: p.payload.votingHours })]);
      await audit(tx, null, 'settlement.governance_change', 'settlement', sid, p.payload);
      break;
  }
}

export async function treasuryHistory(db: Db, userId: string, settlementId: string) {
  if (!(await memberRole(db, settlementId, userId))) fail('forbidden', 'Members only');
  const r = await db.query(
    `SELECT l.id, l.tx_type AS type, l.amount, l.created_at AS "at", (l.to_account = a.id) AS incoming, u.display_name AS actor
       FROM ledger_entries l JOIN accounts a ON a.settlement_id = $1 LEFT JOIN users u ON u.id = l.actor_user_id
      WHERE l.from_account = a.id OR l.to_account = a.id ORDER BY l.id DESC LIMIT 50`,
    [settlementId],
  );
  return r.rows;
}

export type { ResourceId };
