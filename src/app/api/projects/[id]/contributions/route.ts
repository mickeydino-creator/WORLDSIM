import { getRoute } from '@/server/http';
import { projectContributions } from '@/server/services/settlements';

export const GET = getRoute(async ({ db, params }) => ({ contributions: await projectContributions(db, params.id) }));
