/**
 * Response envelope, identical to the wallet/auth functions:
 *   { ok: true, data }                                    on success
 *   { ok: false, statusCode, error: { type, message, description, detail? } }
 *
 * `statusCode` travels in the body because a direct Lambda invocation has no
 * HTTP status. The HTTP runtime (`server/`) lifts it back into the response
 * status and reshapes the error to the legacy `{ errorCode, message }` body
 * the Next.js transport layer already understands.
 */

import { PaymentsError, ValidationError } from './errors';
import { clientMessage } from './redact';

export type Ok<T> = { ok: true; data: T };

export type Fail = {
  ok: false;
  statusCode: number;
  error: {
    type: string;
    message: string;
    description: string;
    detail?: unknown;
  };
};

export type Envelope<T> = Ok<T> | Fail;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data: jsonSafe(data) as T };
}

export function fail(err: PaymentsError): Fail {
  const status = err.httpErrorStatus;
  return {
    ok: false,
    statusCode: status,
    error: {
      type: err.name,
      message: clientMessage(status, err.message),
      description: clientMessage(status, err.description),
      ...(err instanceof ValidationError || err.detail !== undefined ? { detail: err.detail } : {}),
    },
  };
}

/** Dates to ISO strings, BigInt to number, undefined to null. */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}
