import { actionRoute } from '@/server/http';
import { upgradeBuilding } from '@/server/services/buildings';

export const POST = actionRoute({ scope: 'building.upgrade' }, ({ tx, user, params, opKey }) => upgradeBuilding(tx, user.id, params.id, opKey));
