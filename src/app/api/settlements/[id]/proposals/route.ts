import { actionRoute } from '@/server/http';
import { createProposal } from '@/server/services/settlements';
import { proposalSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settlement.proposal', schema: proposalSchema }, ({ tx, user, params, body }) => createProposal(tx, user.id, params.id, body));
