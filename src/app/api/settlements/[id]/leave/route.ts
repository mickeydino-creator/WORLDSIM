import { actionRoute } from '@/server/http';
import { leaveSettlement } from '@/server/services/settlements';

export const POST = actionRoute({ scope: 'settlement.leave' }, ({ tx, user, params }) => leaveSettlement(tx, user.id, params.id));
