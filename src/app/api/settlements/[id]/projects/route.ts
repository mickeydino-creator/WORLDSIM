import { actionRoute } from '@/server/http';
import { proposeProject } from '@/server/services/settlements';
import { projectSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settlement.project', schema: projectSchema }, ({ tx, user, params, body }) => proposeProject(tx, user.id, params.id, body));
