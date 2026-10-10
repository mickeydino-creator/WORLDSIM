import { getRoute } from '@/server/http';
import { marketSummary } from '@/server/services/market';

export const GET = getRoute(async ({ db }) => ({ resources: await marketSummary(db) }));
