/**
 * The source of truth for which endpoints exist.
 *
 * Each entry is one Lambda function (`${env}-hg-<slug>`) AND one HTTP
 * route of the Kubernetes service. `audience` is enforced by the handler
 * wrapper (`webhook` = provider callback, HMAC-verified, no JWT);
 * `resource`/`method` are the `(api-hg, resource, method)` tuple to
 * seed as Feature rows when the security-DB gate is adopted.
 *
 * Adding an endpoint means: an entry here, `lambdas/<slug>/index.ts`
 * exporting `handler`, a `tests/events/<slug>.json`, a line in `server/index.ts`
 * and a `deploy:` script in `cdk/package.json`.
 */

export type Audience = 'player' | 'operator' | 'webhook' | 'any';

export interface RouteSpec {
  slug: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** HTTP path, `{param}` placeholders become `event.path[param]`. */
  resource: string;
  audience: Audience;
  timeoutSec?: number;
  /** Lambda memory; default 128 MB. */
  memoryMb?: number;
  /** Lambda only: expose a public Function URL (the provider calls it). */
  publicUrl?: boolean;
}

export const API_NAME = 'api-hg';

export const ROUTES: readonly RouteSpec[] = [
  // --- player ----------------------------------------------------------
  { slug: 'deposits-create',    method: 'POST', resource: '/api/v1/payments/deposits',                    audience: 'player', timeoutSec: 30 },
  { slug: 'withdrawals-create', method: 'POST', resource: '/api/v1/payments/withdrawals',                 audience: 'player', timeoutSec: 30 },
  { slug: 'withdrawals-cancel', method: 'POST', resource: '/api/v1/payments/withdrawals/{id}/cancel',     audience: 'player', timeoutSec: 30 },
  { slug: 'payments-list',      method: 'GET',  resource: '/api/v1/payments',                             audience: 'player' },
  { slug: 'payments-get',       method: 'GET',  resource: '/api/v1/payments/{id}',                        audience: 'player', timeoutSec: 20 },

  // --- operator (back-office) -----------------------------------------
  { slug: 'admin-payments-list',    method: 'GET',  resource: '/api/v1/payments/admin/payments',              audience: 'operator' },
  { slug: 'admin-payments-get',     method: 'GET',  resource: '/api/v1/payments/admin/payments/{id}',         audience: 'operator' },
  { slug: 'admin-payments-approve', method: 'POST', resource: '/api/v1/payments/admin/payments/{id}/approve', audience: 'operator', timeoutSec: 30 },
  { slug: 'admin-payments-reject',  method: 'POST', resource: '/api/v1/payments/admin/payments/{id}/reject',  audience: 'operator', timeoutSec: 30 },
  { slug: 'admin-settings-get',     method: 'GET',  resource: '/api/v1/payments/admin/settings',              audience: 'operator' },
  { slug: 'admin-settings-update',  method: 'PUT',  resource: '/api/v1/payments/admin/settings',              audience: 'operator' },
  { slug: 'admin-payments-cancel',  method: 'POST', resource: '/api/v1/payments/admin/payments/{id}/cancel',  audience: 'operator', timeoutSec: 30 },
  { slug: 'admin-reconcile',        method: 'POST', resource: '/api/v1/payments/admin/reconcile',             audience: 'operator', timeoutSec: 60 },
  { slug: 'admin-payments-resolve', method: 'POST', resource: '/api/v1/payments/admin/payments/{id}/resolve', audience: 'operator', timeoutSec: 30 },

  // --- operator: withdrawal queue ---------------------------------------
  { slug: 'admin-queue-list',          method: 'GET',  resource: '/api/v1/payments/admin/withdrawals/queue',          audience: 'operator', timeoutSec: 20 },
  { slug: 'admin-queue-run',           method: 'POST', resource: '/api/v1/payments/admin/withdrawals/queue/run',      audience: 'operator', timeoutSec: 60 },
  { slug: 'admin-payments-prioritize', method: 'PUT',  resource: '/api/v1/payments/admin/payments/{id}/priority',     audience: 'operator' },

  // --- operator: per-player limits and blocks ---------------------------
  { slug: 'admin-player-get',           method: 'GET',  resource: '/api/v1/payments/admin/players/{partyId}',         audience: 'operator' },
  { slug: 'admin-player-limits-update', method: 'PUT',  resource: '/api/v1/payments/admin/players/{partyId}/limits',  audience: 'operator' },
  { slug: 'admin-player-block',         method: 'POST', resource: '/api/v1/payments/admin/players/{partyId}/blocks',  audience: 'operator' },
  { slug: 'admin-player-unblock',       method: 'POST', resource: '/api/v1/payments/admin/players/{partyId}/blocks/{blockId}/lift', audience: 'operator' },

  // --- provider callback -------------------------------------------------
  { slug: 'webhook', method: 'POST', resource: '/api/v1/payments/webhook', audience: 'webhook', timeoutSec: 30, publicUrl: true },
];

/**
 * Operator functions that change something need a Feature row for the caller's
 * role (`_common/permissions.ts`): every operator route that is not a GET.
 * Player routes act on the caller's own party only and need no feature.
 */
export function requiresFeature(r: RouteSpec): boolean {
  return r.audience === 'operator' && r.method !== 'GET';
}

export function routeFor(slug: string): RouteSpec {
  const r = ROUTES.find((x) => x.slug === slug);
  if (!r) throw new Error(`unknown route slug ${slug}`);
  return r;
}
