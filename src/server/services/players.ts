import { getBuildingDef } from '@/shared/config/buildings';
import { ACHIEVEMENTS, levelForXp, type AchievementDef } from '@/shared/config/progression';
import { computeModifiers, type Modifiers } from '@/shared/config/research';
import { STARTING_BALANCE, STARTING_RESEARCH_POINTS, STARTING_RESOURCES } from '@/shared/config/resources';
import type { Db, Tx } from '../db';
import { notifyUser, publishFromQuery } from '../events';
import { fail } from '../errors';
import { systemAccountId, transfer } from '../ledger';
import { addResources } from './inventory';

export async function createPlayer(tx: Tx, userId: string) {
  await tx.query('INSERT INTO players (user_id, research_points) VALUES ($1, $2)', [userId, STARTING_RESEARCH_POINTS]);
  const acct = await tx.query<{ id: string }>("INSERT INTO accounts (kind, user_id) VALUES ('player', $1) RETURNING id", [userId]);
  await transfer(tx, {
    from: await systemAccountId(tx, 'mint'),
    to: acct.rows[0].id,
    amount: STARTING_BALANCE,
    type: 'starting_grant',
    idempotencyKey: `starting_grant:${userId}`,
    refs: { actorUserId: userId },
  });
  await addResources(tx, userId, STARTING_RESOURCES, { ignoreCapacity: true });
}

export async function getModifiers(db: Db, userId: string): Promise<Modifiers> {
  const r = await db.query<{ specialization: string | null; techs: string[] }>(
    `SELECT p.specialization, COALESCE(array_agg(r.tech_id) FILTER (WHERE r.tech_id IS NOT NULL), '{}') AS techs
       FROM players p LEFT JOIN player_research r ON r.user_id = p.user_id
      WHERE p.user_id = $1 GROUP BY p.user_id`,
    [userId],
  );
  if (!r.rows[0]) fail('not_found', 'Player not found');
  return computeModifiers(r.rows[0].techs, r.rows[0].specialization);
}

export async function unlockedTechs(db: Db, userId: string): Promise<Set<string>> {
  const r = await db.query<{ tech_id: string }>('SELECT tech_id FROM player_research WHERE user_id = $1', [userId]);
  return new Set(r.rows.map((x) => x.tech_id));
}

export async function addXp(tx: Tx, userId: string, amount: number) {
  if (amount <= 0) return;
  const r = await tx.query<{ xp: number; level: number }>('UPDATE players SET xp = xp + $2 WHERE user_id = $1 RETURNING xp, level', [userId, Math.round(amount)]);
  const row = r.rows[0];
  if (!row) return;
  const newLevel = levelForXp(row.xp);
  if (newLevel > row.level) {
    await tx.query('UPDATE players SET level = $2 WHERE user_id = $1', [userId, newLevel]);
    await notifyUser(tx, userId, 'level_up', `Reached level ${newLevel}`, 'New buildings and options may now be available.', { level: newLevel });
  }
}

const METRIC_SQL: Record<AchievementDef['metric'], string> = {
  parcels: '(SELECT count(*) FROM parcels WHERE owner_user_id = $1)',
  buildings: '(SELECT count(*) FROM buildings WHERE built_by = $1)',
  production_runs: "(SELECT count(*) FROM production_runs WHERE owner_user_id = $1 AND status = 'completed')",
  trades: '(SELECT count(*) FROM trades WHERE buyer_user_id = $1 OR seller_user_id = $1)',
  settlement_founded: '(SELECT count(*) FROM settlements WHERE founder_user_id = $1)',
  contributed_credits: "(SELECT COALESCE(sum(amount),0) FROM project_contributions WHERE user_id = $1 AND kind = 'currency' AND source = 'player')",
  techs: '(SELECT count(*) FROM player_research WHERE user_id = $1)',
};

/**
 * Grants any newly satisfied achievements for the given metrics. Idempotent via primary key.
 * Reads owned achievements and all needed metrics in a single query.
 */
export async function checkAchievements(tx: Tx, userId: string, metrics: AchievementDef['metric'][]) {
  const relevant = ACHIEVEMENTS.filter((a) => metrics.includes(a.metric));
  if (!relevant.length) return;
  const uniq = [...new Set(relevant.map((a) => a.metric))];
  const r = await tx.query<Record<string, string | number | string[]>>(
    `SELECT COALESCE((SELECT array_agg(achievement_id) FROM player_achievements WHERE user_id = $1), '{}') AS owned,
            ${uniq.map((m) => `${METRIC_SQL[m]}::bigint AS "${m}"`).join(', ')}`,
    [userId],
  );
  const row = r.rows[0];
  const owned = new Set(row.owned as string[]);
  for (const a of relevant) {
    if (owned.has(a.id) || Number(row[a.metric]) < a.threshold) continue;
    const ins = await tx.query('INSERT INTO player_achievements (user_id, achievement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, a.id]);
    if (ins.rowCount === 0) continue;
    await tx.query('UPDATE players SET research_points = research_points + $2, reputation = reputation + $3 WHERE user_id = $1', [
      userId, a.reward.researchPoints ?? 0, a.reward.reputation ?? 0,
    ]);
    await notifyUser(tx, userId, 'achievement', `Achievement unlocked: ${a.name}`, a.description, { achievementId: a.id });
  }
}

/** Everything about a player that construction/production checks need, in one round trip. */
export async function playerContext(db: Db, userId: string) {
  const r = await db.query<{ level: number; specialization: string | null; techs: string[]; owned: Record<string, number> | null }>(
    `SELECT p.level, p.specialization,
            COALESCE((SELECT array_agg(tech_id) FROM player_research WHERE user_id = $1), '{}') AS techs,
            (SELECT jsonb_object_agg(type, n) FROM (SELECT type, count(*)::int AS n FROM buildings WHERE owner_user_id = $1 GROUP BY type) t) AS owned
       FROM players p WHERE p.user_id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) fail('not_found', 'Player not found');
  return {
    level: row.level,
    techs: new Set(row.techs),
    ownedCounts: (row.owned ?? {}) as Record<string, number>,
    modifiers: computeModifiers(row.techs, row.specialization),
  };
}

/** Number of buildings of each type the player owns (for "requiresOwned" requirements). */
export async function ownedBuildingCounts(db: Db, userId: string): Promise<Record<string, number>> {
  const r = await db.query<{ type: string; n: number }>('SELECT type, count(*)::int AS n FROM buildings WHERE owner_user_id = $1 GROUP BY type', [userId]);
  return Object.fromEntries(r.rows.map((x) => [x.type, x.n]));
}

export function maxParcelsForLevel(level: number): number {
  return 4 + level * 2;
}

export async function getPlayerState(db: Db, userId: string) {
  const p = await db.query<{
    username: string; display_name: string; is_admin: boolean; xp: number; level: number; reputation: number;
    research_points: number; specialization: string | null; home_lng: number | null; home_lat: number | null; created_at: Date; balance: number;
  }>(
    `SELECT u.username, u.display_name, u.is_admin, p.xp, p.level, p.reputation, p.research_points, p.specialization,
            p.home_lng, p.home_lat, u.created_at, a.balance
       FROM users u JOIN players p ON p.user_id = u.id JOIN accounts a ON a.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const row = p.rows[0];
  if (!row) fail('not_found', 'Player not found');
  const [techs, achievements, membership, counts, unread] = await Promise.all([
    db.query<{ tech_id: string }>('SELECT tech_id FROM player_research WHERE user_id = $1 ORDER BY unlocked_at', [userId]),
    db.query<{ achievement_id: string; unlocked_at: Date }>('SELECT achievement_id, unlocked_at FROM player_achievements WHERE user_id = $1', [userId]),
    db.query<{ settlement_id: string; role: string; name: string }>(
      'SELECT m.settlement_id, m.role, s.name FROM settlement_members m JOIN settlements s ON s.id = m.settlement_id WHERE m.user_id = $1',
      [userId],
    ),
    db.query<{ parcels: number; buildings: number }>(
      `SELECT (SELECT count(*)::int FROM parcels WHERE owner_user_id = $1) AS parcels,
              (SELECT count(*)::int FROM buildings WHERE owner_user_id = $1) AS buildings`,
      [userId],
    ),
    db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]),
  ]);
  const modifiers = computeModifiers(techs.rows.map((t) => t.tech_id), row.specialization);
  return {
    id: userId,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    xp: row.xp,
    level: row.level,
    reputation: row.reputation,
    researchPoints: row.research_points,
    specialization: row.specialization,
    home: row.home_lng != null && row.home_lat != null ? [row.home_lng, row.home_lat] : null,
    createdAt: row.created_at,
    balance: row.balance,
    techs: techs.rows.map((t) => t.tech_id),
    achievements: achievements.rows.map((a) => ({ id: a.achievement_id, unlockedAt: a.unlocked_at })),
    settlement: membership.rows[0] ? { id: membership.rows[0].settlement_id, name: membership.rows[0].name, role: membership.rows[0].role } : null,
    parcelCount: counts.rows[0].parcels,
    buildingCount: counts.rows[0].buildings,
    maxParcels: maxParcelsForLevel(row.level),
    unreadNotifications: unread.rows[0].n,
    modifiers,
  };
}

/** Pushes a fresh wallet balance to the player's realtime channel (after commit). */
export async function publishWallet(tx: Tx, userId: string) {
  await publishFromQuery(tx, `'user:' || q.user_id::text`, 'wallet', 'SELECT user_id, balance FROM accounts WHERE user_id = $2', [userId]);
}

export function buildingName(type: string) {
  return getBuildingDef(type)?.name ?? type;
}
