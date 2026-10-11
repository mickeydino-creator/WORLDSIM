import { getRoute } from '@/server/http';
import { storageInfo } from '@/server/services/inventory';
import { RESOURCE_IDS } from '@/shared/config/resources';

// Lightweight inventory read (one query) for the always-visible resource bar.
export const GET = getRoute(async ({ db, user }) => {
  const { capacity, stock } = await storageInfo(db, user.id);
  const items = Object.fromEntries(RESOURCE_IDS.map((r) => [r, Number(stock[r] ?? 0)]));
  return { inventory: { items, capacity } };
});
