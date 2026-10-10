import { actionRoute } from '@/server/http';
import { respondInvite } from '@/server/services/settlements';
import { respondInviteSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'invite.respond', schema: respondInviteSchema }, ({ tx, user, params, body }) => respondInvite(tx, user.id, params.id, body.accept));
