import { getRoute } from '@/server/http';
import { getSettlement } from '@/server/services/settlements';

export const GET = getRoute(({ db, user, params }) => getSettlement(db, params.id, user.id));
