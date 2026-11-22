/**
 * The skeleton every JWT-authenticated function shares, in both runtimes.
 *
 *   1. Identity   — Bearer JWT verified locally. 401 on failure.
 *   2. Audience   — player or operator, from the token and the route. 403 on mismatch.
 *   3. Session    — the token's session is still open (api-security). 401 if not,
 *                   500 if the check cannot be made.
 *   4. Feature    — operator routes that change something: the caller's role
 *                   carries the route's feature. 403 if not.
 *   5. Body       — the handler. A thrown PaymentsError becomes its status;
 *                   anything else is a 500 with a generic message.
 *
 * Checks 3 and 4 can be switched off ONLY for the local sandbox
 * (`PROVIDER_MODE=mock` and `SANDBOX_SKIP_SECURITY_DB=1`), never elsewhere.
 *
 * A handler never rejects: the envelope carries `statusCode`, and the HTTP
 * runtime lifts it into the response status. The provider webhook has its own
 * wrapper (`lambdas/webhook`): no JWT, HMAC instead.
 */

import { API_NAME, requiresFeature, routeFor } from '../_routes';
import { contextFromEvent, requireAudience, type PaymentsEvent, type SecurityContext } from './auth';
import { PaymentsError, AuthError } from './errors';
import { log } from './logger';
import { assertFeature } from './permissions';
import { assertSessionValid } from './session';
import { GENERIC_MESSAGE } from './redact';
import { fail, ok, type Envelope } from './response';

export type { PaymentsEvent, SecurityContext };

export type Run<T> = (ctx: SecurityContext, event: PaymentsEvent) => Promise<T>;

function securityChecksSkipped(): boolean {
  const skip = process.env.SANDBOX_SKIP_SECURITY_DB === '1' && (process.env.PROVIDER_MODE ?? '').toLowerCase() === 'mock';
  if (skip && !warned) { warned = true; log.warn('session and feature checks are OFF (local sandbox only)'); }
  return skip;
}
let warned = false;

/** `slug` is the route in `_routes.ts`; audience and feature come from it. */
export function paymentsHandler<T>(slug: string, run: Run<T>): (event: PaymentsEvent) => Promise<Envelope<T>> {
  const route = routeFor(slug);
  const audience = route.audience === 'webhook' ? 'any' : route.audience;
  return async (event: PaymentsEvent = {}) => {
    let ctx: SecurityContext;
    try {
      ctx = await contextFromEvent(event);
    } catch (err) {
      const wrapped = err instanceof PaymentsError ? err : new AuthError('authentication failed');
      log.warn('auth failed', { err: String(err) });
      return fail(wrapped);
    }

    try {
      requireAudience(ctx, audience);
    } catch (err) {
      log.warn('audience check failed', { caller: ctx.partyId, audience: ctx.audience, wanted: audience });
      return fail(err as PaymentsError);
    }

    if (!securityChecksSkipped()) {
      try {
        await assertSessionValid(ctx);
        if (requiresFeature(route)) await assertFeature(ctx, API_NAME, route.resource, route.method);
      } catch (err) {
        const wrapped = err instanceof PaymentsError ? err : new PaymentsError(GENERIC_MESSAGE);
        log.warn('security check failed', { caller: ctx.partyId, route: slug, type: wrapped.name });
        return fail(wrapped);
      }
    }

    try {
      return ok(await run(ctx, event));
    } catch (err) {
      if (err instanceof PaymentsError) {
        const level = err.httpErrorStatus >= 500 ? 'error' : 'warn';
        log[level]('request failed', { type: err.name, err: err.message, detail: err.detail, caller: ctx.partyId });
        return fail(err);
      }
      log.error('unhandled failure', { err: String(err), stack: (err as Error)?.stack });
      return fail(new PaymentsError(GENERIC_MESSAGE));
    }
  };
}
