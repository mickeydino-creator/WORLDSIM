import { getRoute } from '@/server/http';
import { getBuildingDetails } from '@/server/services/buildings';

export const GET = getRoute(({ db, user, params }) => getBuildingDetails(db, params.id, user.id));
