import { actionRoute } from '@/server/http';
import { buyListedParcel } from '@/server/services/land';
import { purchaseSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'parcel.buy_listing', schema: purchaseSchema }, ({ tx, user, params, body, opKey }) =>
  buyListedParcel(tx, user.id, params.id, opKey, { name: body.name, maxPrice: body.maxPrice }),
);
