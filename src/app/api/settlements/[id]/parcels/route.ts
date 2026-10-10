import { actionRoute } from '@/server/http';
import { donateParcel } from '@/server/services/settlements';
import { donateParcelSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'settlement.donate', schema: donateParcelSchema }, ({ tx, user, params, body }) => donateParcel(tx, user.id, params.id, body.parcelId));
