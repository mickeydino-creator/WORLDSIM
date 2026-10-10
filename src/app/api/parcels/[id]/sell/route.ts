import { actionRoute } from '@/server/http';
import { sellToLandOffice } from '@/server/services/land';

// Instant sale of a parcel and its buildings to the land office.
export const POST = actionRoute({ scope: 'parcel.sell' }, ({ tx, user, params, opKey }) => sellToLandOffice(tx, user.id, params.id, opKey));
