/**
 * Caller identity and audience (same model as api-engagement).
 *
 * One way in: `headers.authorization = "Bearer <jwt>"`, verified locally with
 * the platform secret. Pre-decoded shapes (`x-auth-decoded-token`,
 * `securityContext`) are rejected: nothing sits in front of these functions,
 * so believing one would let any caller with invoke rights assert any
 * identity. `x-api-key` is not accepted: the webhook is the only caller
 * without a user, and it is verified by HMAC.
 *
 * After the signature, two more checks run on every call (`_common/handler.ts`):
 * the token's session must still be open (`_common/session.ts`) and, for an
 * operator changing something, the caller's role must carry the function's
 * feature (`_common/permissions.ts`). Both read the api-security database.
 *
 * Audience comes from the token's `metadata.partyType`:
 *
 *   player    — partyType `person` / `P`. Acts only on its own payments and
 *               its own wallet account, both resolved from `ctx.partyId`.
 *   operator  — any other party type. Sees and decides payments of parties
 *               inside its own subtree (`isDescendant` / `chainScope`).
 *
 * The provider webhook is a third caller with no JWT at all; it is verified by
 * HMAC in `lambdas/webhook` and never goes through this module.
 */

import { AuthError, ForbiddenError } from './errors';
import { fullChainOf } from './chain';
import * as token from './token';

export type Audience = 'player' | 'operator';

export interface SecurityContext {
  identifier: string;
  username: string;
  /** Party identifier (cuid). The subscriber id everywhere downstream. */
  partyId: string;
  chain: string;
  fullChain: string;
  partyType: string;
  audience: Audience;
  displayName: string;
  locale?: string;
  brand?: string;
  /** The player's address and browser as the front-end saw them (`x-player-ip`, `x-player-user-agent`); hints for the record, never identity. */
  ip?: string;
  userAgent?: string;
  /** The caller's JWT, verbatim: forwarded to the wallet so it enforces the caller's own permissions. */
  token: string;
  /** `User.id` in api-security (`payload.id`), when the token carries it. */
  userDbId?: number;
  /** The `Session` row the token names; checked on every call. Absent = a credential with no session row. */
  sessionId?: string;
  /** Token `iat`, seconds. */
  issuedAt?: number;
}

export interface PaymentsEvent {
  headers?: Record<string, unknown>;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  [key: string]: unknown;
}

export async function contextFromEvent(event: PaymentsEvent): Promise<SecurityContext> {
  const headers = normalizeHeaders(event.headers);
  const authorization = headers.authorization ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const raw = authorization.slice(7).trim();
    const payload = await token.verify(raw);
    return fromDecodedToken(payload, headers, raw);
  }
  if (event.securityContext !== undefined || event.x_decoded_token !== undefined || headers['x-auth-decoded-token']) {
    throw new AuthError('pre-decoded identities are not accepted: pass a Bearer JWT');
  }
  throw new AuthError('no auth provided: pass Authorization');
}

export function fromDecodedToken(payload: Record<string, unknown>, headers: Record<string, string> = {}, raw = ''): SecurityContext {
  if (!payload || typeof payload !== 'object') throw new AuthError('decoded token is not an object');
  const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new AuthError('decoded token metadata is not an object');

  const partyId = str(metadata.partyId) || str(payload.partyId);
  if (!partyId) throw new AuthError('decoded token missing partyId');
  const chain = str(metadata.chain);
  const partyType = str(metadata.partyType);
  const audience: Audience = partyType === 'person' || partyType === 'P' ? 'player' : 'operator';

  return {
    identifier: str(payload.identifier) || str(payload.username),
    username: str(payload.username),
    partyId,
    chain,
    fullChain: str(payload.fullChain) || fullChainOf(chain, partyId),
    partyType,
    audience,
    displayName: str(payload.name) || str(payload.username) || partyId,
    // Locale and brand are not claims today; the front-end forwards what it
    // knows (cookie-derived) as plain headers. Both are hints, never identity.
    locale: headers['x-player-locale'] || undefined,
    brand: headers['x-player-brand'] || undefined,
    ip: (headers['x-player-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64) || undefined,
    userAgent: (headers['x-player-user-agent'] || headers['user-agent'] || '').slice(0, 300) || undefined,
    token: raw,
    userDbId: optionalInt(payload.id),
    sessionId: str(payload.sessionId) || undefined,
    issuedAt: optionalInt(payload.iat),
  };
}

export function requireAudience(ctx: SecurityContext, audience: Audience | 'any'): void {
  if (audience === 'any') return;
  if (ctx.audience !== audience) throw new ForbiddenError(`this endpoint is for ${audience}s`);
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (v !== null && v !== undefined) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function optionalInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
}
