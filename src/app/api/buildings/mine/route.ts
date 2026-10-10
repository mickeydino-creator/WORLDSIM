import { getRoute } from '@/server/http';
import { listMyBuildings } from '@/server/services/buildings';

export const GET = getRoute(async ({ db, user }) => ({ buildings: await listMyBuildings(db, user.id) }));
