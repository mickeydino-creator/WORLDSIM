import { getRoute } from '@/server/http';
import { getPlayerState } from '@/server/services/players';

export const GET = getRoute(({ db, user }) => getPlayerState(db, user.id));
