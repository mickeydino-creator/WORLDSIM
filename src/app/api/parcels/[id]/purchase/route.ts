import { actionRoute } from '@/server/http';
import { purchaseParcel } from '@/server/services/land';
import { purchaseSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'parcel.purchase', schema: purchaseSchema }, ({ tx, user, params, body, opKey }) =>
  purchaseParcel(tx, user.id, params.id, opKey, { name: body.name, maxPrice: body.maxPrice }),
);
