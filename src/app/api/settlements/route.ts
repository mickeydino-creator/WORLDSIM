import { actionRoute, getRoute } from '@/server/http';
import { createSettlement, listSettlements } from '@/server/services/settlements';
import { createSettlementSchema } from '@/shared/schemas';

export const GET = getRoute(async ({ db, url }) => {
  const lng = Number(url.searchParams.get('lng'));
  const lat = Number(url.searchParams.get('lat'));
  const near = url.searchParams.has('lng') && Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : undefined;
  return { settlements: await listSettlements(db, near) };
});

export const POST = actionRoute({ scope: 'settlement.create', schema: createSettlementSchema }, ({ tx, user, body, opKey }) => createSettlement(tx, user.id, body, opKey));
