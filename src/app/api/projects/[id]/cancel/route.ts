import { actionRoute } from '@/server/http';
import { cancelProject } from '@/server/services/settlements';

export const POST = actionRoute({ scope: 'project.cancel' }, ({ tx, user, params }) => cancelProject(tx, user.id, params.id));
