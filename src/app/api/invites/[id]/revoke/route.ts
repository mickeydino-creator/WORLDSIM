import { actionRoute } from '@/server/http';
import { revokeInvite } from '@/server/services/settlements';

export const POST = actionRoute({ scope: 'invite.revoke' }, ({ tx, user, params }) => revokeInvite(tx, user.id, params.id));
