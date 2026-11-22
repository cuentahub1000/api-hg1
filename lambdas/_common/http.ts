/**
 * Outbound HTTP to the payment provider and (in HTTP mode) the wallet.
 *
 * Every call is bounded by a timeout, and every failure is logged with the
 * upstream status and body but surfaced to the caller as a bare
 * `UpstreamError(product)`: the body of a provider 500 is for our logs, not
 * for a player's browser.
 */

import { UpstreamError } from './errors';
import { log } from './logger';

export interface UpstreamRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Statuses that are an answer, not a failure (e.g. 404 on a lookup). */
  allow?: number[];
  /** Called once per call with the masked exchange, whatever the outcome. Must not throw. */
  observe?: (outcome: UpstreamOutcome) => void | Promise<void>;
}

/** What `observe` receives: the exchange with sensitive values masked. */
export interface UpstreamOutcome {
  /** HTTP status; 0 when the provider could not be reached. */
  status: number;
  ms: number;
  request: unknown;
  response: unknown;
  error?: string;
}

export interface UpstreamResponse<T = unknown> {
  status: number;
  data: T;
}

export async function upstream<T = unknown>(product: string, req: UpstreamRequest): Promise<UpstreamResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(req.headers ?? {}),
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    const failed = !res.ok && !(req.allow ?? []).includes(res.status);
    await observe(req, { status: res.status, ms: Date.now() - started, request: maskBody(req.body), response: maskBody(data), ...(failed ? { error: `HTTP ${res.status}` } : {}) });
    if (failed) {
      log.warn('upstream error', {
        product,
        method: req.method ?? 'GET',
        path: safePath(req.url),
        status: res.status,
        ms: Date.now() - started,
        request: req.body === undefined ? undefined : maskBody(req.body),
        body: typeof data === 'string' ? data.slice(0, 500) : data,
      });
      throw new UpstreamError(product, res.status, errorCode(data));
    }
    log.debug('upstream ok', { product, method: req.method ?? 'GET', path: safePath(req.url), status: res.status, ms: Date.now() - started });
    return { status: res.status, data: data as T };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    log.error('upstream unreachable', { product, path: safePath(req.url), err: String(err), ms: Date.now() - started });
    await observe(req, { status: 0, ms: Date.now() - started, request: maskBody(req.body), response: null, error: String(err).slice(0, 200) });
    throw new UpstreamError(product, 0);
  } finally {
    clearTimeout(timer);
  }
}

async function observe(req: UpstreamRequest, outcome: UpstreamOutcome): Promise<void> {
  if (!req.observe) return;
  try {
    await req.observe(outcome);
  } catch (err) {
    log.warn('upstream observer failed', { path: safePath(req.url), err: String(err) });
  }
}

/** Keys whose values never reach a log or the operator: credentials, national ids, contacts, bank accounts. */
const SENSITIVE = /token|secret|password|key|authorization|signature|document|cpf|cnpj|cuit|dni|email|phone|pix|cbu|cvu|iban|card/i;

/**
 * A request or response body as it may be stored or logged: same shape,
 * sensitive values replaced by `[redacted]`, long strings cut.
 */
export function maskBody(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (depth > 4) return '[...]';
  if (Array.isArray(value)) return value.map((v) => maskBody(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? (v === null || v === undefined ? v : '[redacted]') : maskBody(v, depth + 1);
    }
    return out;
  }
  return typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

/** The machine-readable code of an error body, when the upstream sends one (`code`, `errorCode`, `error.code`). */
function errorCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const direct = d.code ?? d.errorCode ?? (d.error && typeof d.error === 'object' ? (d.error as Record<string, unknown>).code : undefined);
  return typeof direct === 'string' ? direct : null;
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return '?';
  }
}

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.append(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}
