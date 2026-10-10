import { getRoute } from '@/server/http';
import { getParcelDetails } from '@/server/services/land';

export const GET = getRoute(({ db, user, params }) => getParcelDetails(db, params.id, user.id));
