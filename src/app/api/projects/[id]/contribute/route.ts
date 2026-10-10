import { actionRoute } from '@/server/http';
import { contribute } from '@/server/services/settlements';
import { contributeSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'project.contribute', schema: contributeSchema }, ({ tx, user, params, body, opKey }) => contribute(tx, user.id, params.id, body, opKey));
