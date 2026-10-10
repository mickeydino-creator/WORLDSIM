export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'insufficient_funds'
  | 'insufficient_resources'
  | 'storage_full'
  | 'unavailable'
  | 'restricted'
  | 'conflict'
  | 'requirements_not_met'
  | 'invalid_placement'
  | 'rate_limited'
  | 'idempotency_mismatch';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  insufficient_funds: 402,
  insufficient_resources: 409,
  storage_full: 409,
  unavailable: 409,
  restricted: 409,
  conflict: 409,
  requirements_not_met: 409,
  invalid_placement: 422,
  rate_limited: 429,
  idempotency_mismatch: 422,
};

/** Expected, user-facing game error. Anything else is reported as an internal error. */
export class GameError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.status = STATUS[code];
  }
}

export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new GameError(code, message, details);
};
