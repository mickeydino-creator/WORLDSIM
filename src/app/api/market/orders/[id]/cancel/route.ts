import { actionRoute } from '@/server/http';
import { cancelOrder } from '@/server/services/market';

export const POST = actionRoute({ scope: 'market.cancel' }, ({ tx, user, params }) => cancelOrder(tx, user.id, params.id));
