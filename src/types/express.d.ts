import type { Types } from 'mongoose';
import type { Role } from '../shared/roles';

/**
 * What the middleware chain hangs on the request, in the order it is set:
 * requestId -> requireAuth -> resolvePractice -> resolveLocation.
 */
declare global {
  namespace Express {
    interface AuthContext {
      userId: Types.ObjectId;
      phone: string;
      name: string;
    }

    interface PracticeContext {
      practiceId: Types.ObjectId;
      membershipId: Types.ObjectId;
      actorId: Types.ObjectId;
      role: Role;
      /**
       * Which locations this member may touch: a list for a PA, 'all' for a
       * doctor. The base repository turns this into the location filter, so no
       * route has to remember to.
       */
      allowedLocationIds: Types.ObjectId[] | 'all';
      /** Set by resolveLocation from X-Location-Id, on location-scoped routes only. */
      locationId?: Types.ObjectId;
    }

    interface Request {
      id?: string;
      auth?: AuthContext;
      ctx?: PracticeContext;
    }
  }
}

export {};
