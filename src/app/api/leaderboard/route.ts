import { getRoute } from '@/server/http';

// Rankings deliberately include non-wealth measures (reputation, level, completed civic projects).
export const GET = getRoute(async ({ db }) => {
  const [reputation, level] = await Promise.all([
    db.query('SELECT u.username, u.display_name AS "displayName", p.reputation AS value FROM players p JOIN users u ON u.id = p.user_id ORDER BY p.reputation DESC, p.created_at LIMIT 10'),
    db.query('SELECT u.username, u.display_name AS "displayName", p.level AS value FROM players p JOIN users u ON u.id = p.user_id ORDER BY p.xp DESC, p.created_at LIMIT 10'),
  ]);
  return { reputation: reputation.rows, level: level.rows };
});
