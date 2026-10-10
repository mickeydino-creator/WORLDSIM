import { getRoute } from '@/server/http';
import { listOwnedParcels } from '@/server/services/land';

export const GET = getRoute(async ({ db, user }) => ({ parcels: await listOwnedParcels(db, user.id) }));
