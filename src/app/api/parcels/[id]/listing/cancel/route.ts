import { actionRoute } from '@/server/http';
import { cancelListing } from '@/server/services/land';

export const POST = actionRoute({ scope: 'parcel.unlist' }, ({ tx, user, params }) => cancelListing(tx, user.id, params.id));
