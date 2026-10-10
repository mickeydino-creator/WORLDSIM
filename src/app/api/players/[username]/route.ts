import { getRoute } from '@/server/http';
import { GameError } from '@/server/errors';

// Public profile: no wallet balance or inventory is exposed.
export const GET = getRoute(async ({ db, params }) => {
  const r = await db.query(
    `SELECT u.username, u.display_name AS "displayName", p.level, p.reputation, p.specialization, u.created_at AS "joinedAt",
            (SELECT count(*)::int FROM parcels WHERE owner_user_id = u.id) AS parcels,
            (SELECT count(*)::int FROM buildings WHERE owner_user_id = u.id) AS buildings,
            (SELECT s.name FROM settlement_members m JOIN settlements s ON s.id = m.settlement_id WHERE m.user_id = u.id) AS settlement,
            (SELECT COALESCE(array_agg(achievement_id), '{}') FROM player_achievements WHERE user_id = u.id) AS achievements
       FROM users u JOIN players p ON p.user_id = u.id WHERE lower(u.username) = lower($1)`,
    [params.username],
  );
  if (!r.rows[0]) throw new GameError('not_found', 'Player not found');
  return r.rows[0];
});
