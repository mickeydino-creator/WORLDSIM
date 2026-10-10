import { getRoute } from '@/server/http';
import { myInvites } from '@/server/services/settlements';

export const GET = getRoute(async ({ db, user }) => ({ invites: await myInvites(db, user.id) }));
