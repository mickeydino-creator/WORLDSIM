import { XP } from '@/shared/config/progression';
import { SPECIALIZATIONS, SPECIALIZATION_CHANGE_COST_RP, getTech, techCost } from '@/shared/config/research';
import type { Tx } from '../db';
import { fail } from '../errors';
import { notifyUser, publish } from '../events';
import { addXp, checkAchievements } from './players';

export async function unlockTech(tx: Tx, userId: string, techId: string) {
  const tech = getTech(techId);
  if (!tech) fail('invalid_input', 'Unknown technology');
  const t = tech!;
  const p = await tx.query<{ research_points: number; specialization: string | null }>('SELECT research_points, specialization FROM players WHERE user_id = $1 FOR UPDATE', [userId]);
  const have = await tx.query<{ tech_id: string }>('SELECT tech_id FROM player_research WHERE user_id = $1', [userId]);
  const owned = new Set(have.rows.map((r) => r.tech_id));
  if (owned.has(t.id)) fail('conflict', 'Already researched');
  const missing = t.prereqs.filter((x) => !owned.has(x));
  if (missing.length) fail('requirements_not_met', `Research first: ${missing.map((m) => getTech(m)?.name ?? m).join(', ')}`);
  const cost = techCost(t, p.rows[0].specialization);
  const upd = await tx.query('UPDATE players SET research_points = research_points - $2 WHERE user_id = $1 AND research_points >= $2', [userId, cost]);
  if (upd.rowCount === 0) fail('insufficient_resources', `Requires ${cost} research points`, { required: cost, available: p.rows[0].research_points });
  await tx.query('INSERT INTO player_research (user_id, tech_id) VALUES ($1,$2)', [userId, t.id]);
  await addXp(tx, userId, XP.research);
  await checkAchievements(tx, userId, ['techs']);
  await notifyUser(tx, userId, 'research', `Researched ${t.name}`, t.description, { techId: t.id });
  await publish(tx, `user:${userId}`, 'player', {});
  return { techId: t.id, cost };
}

export async function setSpecialization(tx: Tx, userId: string, specialization: string) {
  if (!Object.prototype.hasOwnProperty.call(SPECIALIZATIONS, specialization)) fail('invalid_input', 'Unknown specialization');
  const p = await tx.query<{ specialization: string | null }>('SELECT specialization FROM players WHERE user_id = $1 FOR UPDATE', [userId]);
  const current = p.rows[0].specialization;
  if (current === specialization) fail('conflict', 'That is already your specialization');
  let cost = 0;
  if (current) {
    cost = SPECIALIZATION_CHANGE_COST_RP;
    const upd = await tx.query('UPDATE players SET research_points = research_points - $2 WHERE user_id = $1 AND research_points >= $2', [userId, cost]);
    if (upd.rowCount === 0) fail('insufficient_resources', `Changing specialization costs ${cost} research points`);
  }
  await tx.query('UPDATE players SET specialization = $2 WHERE user_id = $1', [userId, specialization]);
  await publish(tx, `user:${userId}`, 'player', {});
  return { specialization, cost };
}
