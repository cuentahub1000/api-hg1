/**
 * Error taxonomy. Same shape as the wallet, auth and engagement functions so
 * the front-ends' `errorCode` switches keep working, with the payment cases
 * added. Each class carries the HTTP status the envelope reports.
 */

export enum ErrorCodes {
  PAYMENTS_ERROR = 'PAYMENTS_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTH_ERROR = 'AUTH_ERROR',
  FORBIDDEN = 'FORBIDDEN',
  PERMISSIONS_UNAVAILABLE = 'PERMISSIONS_UNAVAILABLE',
  ENTITY_NOT_FOUND = 'ENTITY_NOT_FOUND',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  INVALID_STATE = 'INVALID_STATE',
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  CONFLICT = 'CONFLICT',
  REQUEST_IN_PROGRESS = 'REQUEST_IN_PROGRESS',
  BLOCKED = 'BLOCKED',
}

export class PaymentsError extends Error {
  httpErrorStatus = 500;
  description = 'There was an error processing the request';
  /** Structured, caller-safe data about the refusal (ids, amounts, statuses); never internals. */
  detail?: unknown;

  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.PAYMENTS_ERROR;
  }
}

/** 400 — bad input. `detail` lists every failing field. */
export class ValidationError extends PaymentsError {
  override detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = ErrorCodes.VALIDATION_ERROR;
    this.description = message;
    this.detail = detail;
    this.httpErrorStatus = 400;
  }
}

/** 401 — no usable credential, or the credential did not verify. */
export class AuthError extends PaymentsError {
  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.AUTH_ERROR;
    this.description = message;
    this.httpErrorStatus = 401;
  }
}

/**
 * 500 — the session or feature check could not be made (security database
 * unreachable). Not a 401/403: the caller may be perfectly legitimate and we
 * simply cannot tell. Fails closed.
 */
export class PermissionsUnavailableError extends PaymentsError {
  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.PERMISSIONS_UNAVAILABLE;
    this.description = message;
    this.httpErrorStatus = 500;
  }
}

/** 403 — authenticated, but not allowed to do this (wrong audience, chain, feature or account). */
export class ForbiddenError extends PaymentsError {
  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.FORBIDDEN;
    this.description = message;
    this.httpErrorStatus = 403;
  }
}

export class NotFoundError extends PaymentsError {
  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.ENTITY_NOT_FOUND;
    this.description = message;
    this.httpErrorStatus = 404;
  }
}

/**
 * 502 — the payment provider or the wallet answered with an error. The
 * upstream body goes to the log only; the caller learns that the step failed
 * and nothing else (see `redact.ts`). `product` is a neutral label ("payment
 * provider", "wallet"), never a vendor name.
 */
export class UpstreamError extends PaymentsError {
  constructor(readonly product: string, readonly upstreamStatus: number, readonly upstreamCode: string | null = null) {
    super(`${product} request failed`);
    this.name = ErrorCodes.UPSTREAM_ERROR;
    this.description = `${product} request failed`;
    this.httpErrorStatus = 502;
  }
}

/** 503 — the integration behind this endpoint is not configured in this environment. */
export class NotConfiguredError extends PaymentsError {
  constructor(product: string) {
    super(`${product} is not configured`);
    this.name = ErrorCodes.NOT_CONFIGURED;
    this.description = `${product} is not configured`;
    this.httpErrorStatus = 503;
  }
}

/** 422 — the payment is not in a state that allows this action. */
export class InvalidStateError extends PaymentsError {
  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.INVALID_STATE;
    this.description = message;
    this.httpErrorStatus = 422;
  }
}

/** 422 — amount outside the player's limits. The message never names the limit; `detail.rule` is for operators' logs only. */
export class LimitError extends PaymentsError {
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = ErrorCodes.LIMIT_EXCEEDED;
    this.description = message;
    this.detail = detail;
    this.httpErrorStatus = 422;
  }
}

/** 403 — an operator blocked this kind of movement for the player; the player is told to contact support. */
export class BlockedError extends PaymentsError {
  constructor(kind: 'deposit' | 'withdrawal') {
    super(`${kind}s are not available for this account`);
    this.name = ErrorCodes.BLOCKED;
    this.description = 'This option is not available for your account. Please contact support.';
    this.httpErrorStatus = 403;
  }
}

/** 422 — the wallet refused the withdrawal for lack of withdrawable balance. */
export class InsufficientFundsError extends PaymentsError {
  constructor(message = 'Insufficient withdrawable balance') {
    super(message);
    this.name = ErrorCodes.INSUFFICIENT_FUNDS;
    this.description = message;
    this.httpErrorStatus = 422;
  }
}

/**
 * 422 — the player already has a request in flight that blocks this one.
 * `detail` names it (`{ id, kind, status, amount, currency, cancellable }`) so
 * the front-end can say exactly what is blocking and what to do.
 */
export class RequestInProgressError extends PaymentsError {
  constructor(message: string, detail: unknown) {
    super(message);
    this.name = ErrorCodes.REQUEST_IN_PROGRESS;
    this.description = message;
    this.detail = detail;
    this.httpErrorStatus = 422;
  }
}

/** 409 — a concurrent change already decided this payment. */
export class ConflictError extends PaymentsError {
  constructor(message: string) {
    super(message);
    this.name = ErrorCodes.CONFLICT;
    this.description = message;
    this.httpErrorStatus = 409;
  }
}
