import { getRoute } from '@/server/http';
import { getInventory } from '@/server/services/inventory';
import { listBusinesses, recentRuns } from '@/server/services/production';

export const GET = getRoute(async ({ db, user }) => {
  const [wallet, inventory, businesses, runs, ledger] = await Promise.all([
    db.query<{ id: string; balance: number }>('SELECT id, balance FROM accounts WHERE user_id = $1', [user.id]),
    getInventory(db, user.id),
    listBusinesses(db, user.id),
    recentRuns(db, user.id),
    db.query(
      `SELECT l.id, l.tx_type AS type, l.amount, l.created_at AS "at", (l.to_account = a.id) AS incoming,
              l.parcel_id AS "parcelId", l.building_id AS "buildingId", l.trade_id AS "tradeId", l.project_id AS "projectId"
         FROM accounts a JOIN ledger_entries l ON l.from_account = a.id OR l.to_account = a.id
        WHERE a.user_id = $1 ORDER BY l.id DESC LIMIT 50`,
      [user.id],
    ),
  ]);
  return { balance: wallet.rows[0].balance, inventory, businesses, runs, ledger: ledger.rows };
});
