import { actionRoute } from '@/server/http';
import { listParcel } from '@/server/services/land';
import { listParcelSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'parcel.list', schema: listParcelSchema }, ({ tx, user, params, body }) => listParcel(tx, user.id, params.id, body.price));
