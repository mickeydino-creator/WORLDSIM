import { actionRoute } from '@/server/http';
import { inviteMember } from '@/server/services/settlements';
import { inviteSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settlement.invite', schema: inviteSchema }, ({ tx, user, params, body }) => inviteMember(tx, user.id, params.id, body.username));
