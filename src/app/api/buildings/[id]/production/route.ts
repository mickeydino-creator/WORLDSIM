import { actionRoute } from '@/server/http';
import { startProduction } from '@/server/services/production';
import { productionSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'production.start', schema: productionSchema }, ({ tx, user, params, body, opKey }) =>
  startProduction(tx, user.id, params.id, body.recipeId, body.autoRepeat, opKey),
);
