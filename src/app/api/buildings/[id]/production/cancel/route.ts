import { actionRoute } from '@/server/http';
import { cancelProduction } from '@/server/services/production';

export const POST = actionRoute({ scope: 'production.cancel' }, ({ tx, user, params }) => cancelProduction(tx, user.id, params.id));
