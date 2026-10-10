import { actionRoute } from '@/server/http';
import { unlockTech } from '@/server/services/research';

export const POST = actionRoute({ scope: 'research.unlock' }, ({ tx, user, params }) => unlockTech(tx, user.id, params.techId));
