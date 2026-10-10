import { actionRoute } from '@/server/http';
import { setAutoRepeat } from '@/server/services/production';
import { autoRepeatSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'production.auto', schema: autoRepeatSchema }, ({ tx, user, params, body }) => setAutoRepeat(tx, user.id, params.id, body.autoRepeat));
