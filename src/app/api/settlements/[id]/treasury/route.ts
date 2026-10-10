import { getRoute } from '@/server/http';
import { treasuryHistory } from '@/server/services/settlements';

export const GET = getRoute(async ({ db, user, params }) => ({ entries: await treasuryHistory(db, user.id, params.id) }));
