import { getRoute } from '@/server/http';
import { getOrderBook } from '@/server/services/market';

export const GET = getRoute(({ db, user, params }) => getOrderBook(db, params.resource, user.id));
