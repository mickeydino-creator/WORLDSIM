import { actionRoute } from '@/server/http';
import { setRole } from '@/server/services/settlements';
import { roleSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settlement.role', schema: roleSchema }, ({ tx, user, params, body }) => setRole(tx, user.id, params.id, params.userId, body.role));
