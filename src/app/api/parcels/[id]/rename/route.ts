import { actionRoute } from '@/server/http';
import { renameParcel } from '@/server/services/land';
import { renameParcelSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'parcel.rename', schema: renameParcelSchema }, ({ tx, user, params, body }) => renameParcel(tx, user.id, params.id, body.name));
