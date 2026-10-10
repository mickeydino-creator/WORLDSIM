import { actionRoute } from '@/server/http';
import { grantBuildPermission } from '@/server/services/land';
import { permissionSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'parcel.permissions', schema: permissionSchema }, ({ tx, user, params, body }) =>
  grantBuildPermission(tx, user.id, params.id, body.username, body.grant),
);
