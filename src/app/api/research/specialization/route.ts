import { actionRoute } from '@/server/http';
import { setSpecialization } from '@/server/services/research';
import { specializationSchema } from '@/shared/schemas';

export const POST = actionRoute({ scope: 'research.specialization', schema: specializationSchema }, ({ tx, user, body }) => setSpecialization(tx, user.id, body.specialization));
