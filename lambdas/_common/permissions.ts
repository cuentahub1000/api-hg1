/**
 * Role features check for operator functions that change something.
 *
 * A call is allowed when at least one ACTIVE Feature reachable from the
 * caller's ACTIVE roles ALLOWs this function's `(api, resource, method)` —
 * the same rule and the same join the platform authorizer applies. The tuple
 * is the route's own (`_routes.ts`: `api-hg`, resource, method) and the rows
 * are seeded in api-security for the roles that may approve, reject, change
 * settings, reconcile, set limits or block players. The role name itself is
 * never compared.
 *
 * Features are cached per container and user for `FEATURES_CACHE_MS`
 * (default 60 s). When the database cannot answer the call fails with a 500.
 */
import type { SecurityContext } from './auth';
import { security } from './db';
import { ForbiddenError, PermissionsUnavailableError } from './errors';
import { log } from './logger';

export interface Feature { api: string; resource: string; action: string; effect: string }

const CACHE_MS = Number(process.env.FEATURES_CACHE_MS ?? '60000') || 60_000;
const cache = new Map<string, { until: number; features: Feature[] }>();

const COLUMNS = 'f.api AS api, f.resource AS resource, f.action AS action, f.effect AS effect';
const JOINS = `
    JOIN "_UserRoles" ur ON u.id = ur."B"
    JOIN "Role" r ON ur."A" = r.id
    JOIN "_RoleFeatures" rf ON r.id = rf."B"
    JOIN "Feature" f ON rf."A" = f.id`;
const ACTIVE = `AND u.status = 'ACTIVE' AND r.status = 'ACTIVE' AND f.status = 'ACTIVE'`;
const BY_USER_ID = `SELECT ${COLUMNS} FROM "User" u ${JOINS} WHERE u.id = $1 ${ACTIVE}`;
const BY_IDENTIFIER = `SELECT ${COLUMNS} FROM "User" u ${JOINS} WHERE u.identifier = $1 ${ACTIVE}`;

async function load(ctx: SecurityContext): Promise<Feature[]> {
  const key = ctx.userDbId !== undefined ? `id:${ctx.userDbId}` : `ident:${ctx.identifier}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.features;
  let rows: Array<{ api: string | null; resource: string | null; action: string | null; effect: string | null }>;
  try {
    rows = ctx.userDbId !== undefined
      ? await security.query(BY_USER_ID, [ctx.userDbId])
      : await security.query(BY_IDENTIFIER, [ctx.identifier]);
  } catch (err) {
    log.error('feature check unavailable', { err: String(err) });
    throw new PermissionsUnavailableError('feature check unavailable');
  }
  const features = rows.map((r) => ({ api: r.api ?? '', resource: r.resource ?? '', action: (r.action ?? '').toLowerCase(), effect: (r.effect ?? '').toUpperCase() }));
  cache.set(key, { until: Date.now() + CACHE_MS, features });
  return features;
}

/** True when some feature ALLOWs `(api, resource, method)`. Pure. */
export function check(features: Feature[], api: string, resource: string, method: string): boolean {
  const wanted = method.toLowerCase();
  return features.some((f) => f.api === api && f.effect === 'ALLOW' && f.action === wanted && resourceMatches(f.resource, resource));
}

/**
 * A seeded `Feature.resource` template against this function's resource. Both
 * are templates: `{id}` or `:id` on either side matches a placeholder or one
 * segment on the other, never more than one segment.
 */
export function resourceMatches(template: string, resource: string): boolean {
  const pattern = template
    .split(/(\{[^}]+\}|:[^/]+)/)
    .map((part) => (part.startsWith('{') || part.startsWith(':')) ? '(?:\\{[^}]+\\}|:[^/]+|[^/]+)' : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))
    .join('');
  return new RegExp(`^${pattern}$`).test(resource);
}

export async function assertFeature(ctx: SecurityContext, api: string, resource: string, method: string): Promise<void> {
  const features = await load(ctx);
  if (!check(features, api, resource, method)) {
    log.warn('feature denied', { caller: ctx.partyId, api, resource, method });
    throw new ForbiddenError('not allowed');
  }
}

/** Test seam. */
export function resetFeatureCache(): void { cache.clear(); }
