import { actionRoute } from '@/server/http';
import { demolishBuilding } from '@/server/services/buildings';

export const POST = actionRoute({ scope: 'building.demolish' }, ({ tx, user, params, opKey }) => demolishBuilding(tx, user.id, params.id, opKey));
