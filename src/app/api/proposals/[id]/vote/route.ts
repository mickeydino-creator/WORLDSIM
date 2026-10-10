import { actionRoute } from '@/server/http';
import { castVote } from '@/server/services/settlements';
import { voteSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'proposal.vote', schema: voteSchema }, ({ tx, user, params, body }) => castVote(tx, user.id, params.id, body.choice));
