import { actionRoute } from '@/server/http';
import { placeOrder } from '@/server/services/market';
import { orderSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'market.order', schema: orderSchema }, ({ tx, user, body, opKey }) => placeOrder(tx, user.id, body, opKey));
