import { getRoute } from '@/server/http';
import { getListings } from '@/server/services/land';

export const GET = getRoute(async ({ db }) => ({ listings: await getListings(db) }));
