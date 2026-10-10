import { actionRoute } from '@/server/http';
import { removeMember } from '@/server/services/settlements';

export const POST = actionRoute({ scope: 'settlement.remove' }, ({ tx, user, params }) => removeMember(tx, user.id, params.id, params.userId));
