/**
 * Per-call session validity, the same rule the auth service applies on every
 * guarded call: the `Session` row the token names (in the api-auth database,
 * read through its read-only endpoint) must exist, be `active` and not expired. A revoked session is a 401 even though the token still verifies.
 *
 * A token with no `sessionId` claim passes this check (nothing to look up); a
 * row missing for a token younger than `FRESH_TOKEN_GRACE_SECONDS` also passes,
 * because the row is written moments after the token is issued and a replica
 * may lag. When the database cannot answer the call fails with a 500, never
 * with a pass.
 *
 * Results are cached per container for `SESSION_CACHE_MS` (default 30 s) so a
 * burst of calls from one session costs one query.
 */
import type { SecurityContext } from './auth';
import { auth } from './db';
import { AuthError, PermissionsUnavailableError } from './errors';
import { log } from './logger';

export const ACTIVE_STATUS = 'active';
export const FRESH_TOKEN_GRACE_SECONDS = 10;
const CACHE_MS = Number(process.env.SESSION_CACHE_MS ?? '30000') || 30_000;

export type SessionState = 'valid' | 'revoked' | 'expired' | 'missing';

const cache = new Map<string, { until: number; state: SessionState }>();

export async function sessionState(sessionId: string, userId: string | undefined): Promise<SessionState> {
  const row = await auth.one<{ status: string; expires: string | Date | null }>(
    `SELECT status, expires FROM "Session" WHERE id = $1 AND ($2::text IS NULL OR "userId" = $2::text)`,
    [sessionId, userId ?? null],
  );
  if (!row) return 'missing';
  if (row.status !== ACTIVE_STATUS) return 'revoked';
  const exp = row.expires ? new Date(row.expires).getTime() : null;
  if (exp !== null && exp <= Date.now()) return 'expired';
  return 'valid';
}

/** Pure: state -> decision. Exported for the unit test. */
export function judge(state: SessionState, issuedAt: number | undefined, nowSeconds = Math.floor(Date.now() / 1000)): void {
  switch (state) {
    case 'valid': return;
    case 'missing':
      if (issuedAt !== undefined && nowSeconds - issuedAt <= FRESH_TOKEN_GRACE_SECONDS) return;
      throw new AuthError('session not found');
    case 'revoked':
    case 'expired':
      throw new AuthError('session is no longer valid');
  }
}

export async function assertSessionValid(ctx: SecurityContext): Promise<void> {
  if (!ctx.sessionId) return;
  const key = `${ctx.sessionId}:${ctx.userDbId ?? ''}`;
  const hit = cache.get(key);
  let state: SessionState;
  if (hit && hit.until > Date.now() && hit.state === 'valid') {
    state = hit.state;
  } else {
    try {
      state = await sessionState(ctx.sessionId, ctx.userDbId === undefined ? undefined : String(ctx.userDbId));
    } catch (err) {
      log.error('session check unavailable', { err: String(err) });
      throw new PermissionsUnavailableError('session check unavailable');
    }
    if (state === 'valid') cache.set(key, { until: Date.now() + CACHE_MS, state });
    else cache.delete(key);
  }
  judge(state, ctx.issuedAt);
}

/** Test seam. */
export function resetSessionCache(): void { cache.clear(); }
