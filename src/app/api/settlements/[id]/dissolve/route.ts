import { actionRoute } from '@/server/http';
import { dissolveSettlement } from '@/server/services/settlements';
import { dissolveSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settlement.dissolve', schema: dissolveSchema }, ({ tx, user, params, body }) => dissolveSettlement(tx, user.id, params.id, body.confirmName));
