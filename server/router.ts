/**
 * Maps an incoming HTTP request onto the same `{ headers, path, query, body }`
 * event a Lambda invocation carries, and the envelope back onto an HTTP
 * response. The Next.js transport layer in `callHttp` mode expects exactly
 * what the NestJS services produced: the data as the body on success, and a
 * `{ errorCode, message, description, detail, statusCode }` body on failure.
 */

import type { Envelope } from '../lambdas/_common/response';
import type { PaymentsEvent } from '../lambdas/_common/handler';
import { ROUTES, type RouteSpec } from '../lambdas/_routes';

export type Handler = (event: PaymentsEvent) => Promise<Envelope<unknown>>;

export interface CompiledRoute {
  spec: RouteSpec;
  pattern: RegExp;
  params: string[];
  handler: Handler;
}

export function compile(handlers: Record<string, Handler>): CompiledRoute[] {
  return ROUTES.map((spec) => {
    const params: string[] = [];
    const source = spec.resource
      .split('/')
      .map((seg) => {
        const m = /^\{([^}]+)\}$/.exec(seg);
        if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        params.push(m[1]);
        return '([^/]+)';
      })
      .join('/');
    const handler = handlers[spec.slug];
    if (!handler) throw new Error(`no handler registered for ${spec.slug}`);
    return { spec, pattern: new RegExp(`^${source}/?$`), params, handler };
  });
}

export interface Match {
  route: CompiledRoute;
  path: Record<string, string>;
}

export function match(routes: CompiledRoute[], method: string, pathname: string): Match | 'method' | null {
  let pathMatched = false;
  for (const route of routes) {
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (route.spec.method !== method) continue;
    const path: Record<string, string> = {};
    route.params.forEach((name, i) => {
      path[name] = decodeURIComponent(m[i + 1]);
    });
    return { route, path };
  }
  return pathMatched ? 'method' : null;
}

export interface HttpOut {
  status: number;
  body: unknown;
}

export function toHttp(envelope: Envelope<unknown>): HttpOut {
  if (envelope.ok) return { status: 200, body: envelope.data };
  return {
    status: envelope.statusCode,
    body: {
      errorCode: envelope.error.type,
      message: envelope.error.message,
      description: envelope.error.description,
      ...(envelope.error.detail !== undefined ? { detail: envelope.error.detail } : {}),
      statusCode: envelope.statusCode,
    },
  };
}

export function queryToRecord(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const all = search.getAll(key);
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}
