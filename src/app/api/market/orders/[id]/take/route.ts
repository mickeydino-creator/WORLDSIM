import { actionRoute } from '@/server/http';
import { takeOrder } from '@/server/services/market';
import { takeOrderSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'market.take', schema: takeOrderSchema }, ({ tx, user, params, body, opKey }) => takeOrder(tx, user.id, params.id, body.quantity, opKey));
