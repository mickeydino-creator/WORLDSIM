import { actionRoute } from '@/server/http';
import { placeBuilding } from '@/server/services/buildings';
import { placeBuildingSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'building.place', schema: placeBuildingSchema }, ({ tx, user, body, opKey }) => placeBuilding(tx, user.id, body, opKey));
