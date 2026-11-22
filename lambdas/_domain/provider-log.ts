/**
 * `provider_log`: every exchange with the payment provider, masked, so an
 * operator can see what was sent and what came back without reading Lambda
 * logs. Two kinds of row:
 *
 *   request  — a call this service made (`_common/http.ts` `observe` hook)
 *   webhook  — a delivery the provider made to `/payments/webhook`
 *
 * Writing never fails the business call: an insert error is logged and dropped.
 * Bodies are passed through `maskBody` here as well, so a caller cannot store
 * an unmasked value by mistake.
 */

import { db } from '../_common/db';
import { maskBody } from '../_common/http';
import { log } from '../_common/logger';

export type ProviderLogKind = 'request' | 'webhook';

/** One row as the back-office receives it (`admin-payments-get` → `logs`). */
export interface ProviderLogView {
  id: string;
  at: string;
  kind: ProviderLogKind;
  method: string | null;
  path: string | null;
  status: number | null;
  ms: number | null;
  request: unknown;
  response: unknown;
  error: string | null;
}

interface Entry {
  kind: ProviderLogKind;
  provider: string;
  paymentId: string | null;
  method?: string;
  path?: string;
  status: number;
  ms: number;
  request: unknown;
  response: unknown;
  error?: string;
}

export async function recordRequest(e: Omit<Entry, 'kind'> & { method: string; path: string }): Promise<void> {
  return record({ ...e, kind: 'request' });
}

export async function recordWebhook(e: Omit<Entry, 'kind' | 'method' | 'path'>): Promise<void> {
  return record({ ...e, kind: 'webhook' });
}

async function record(e: Entry): Promise<void> {
  try {
    await db.execute(
      `INSERT INTO provider_log (kind, provider, payment_id, method, path, status, ms, request, response, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [e.kind, e.provider, e.paymentId, e.method ?? null, e.path ?? null, e.status, Math.round(e.ms), json(maskBody(e.request)), json(maskBody(e.response)), e.error ?? null],
    );
  } catch (err) {
    log.warn('provider log not written', { kind: e.kind, paymentId: e.paymentId, err: String(err) });
  }
}

/** The payment behind a provider reference, for tagging a webhook; null when unknown. */
export async function paymentIdForRef(provider: string, ref: string): Promise<string | null> {
  const row = await db.one<{ payment_id: string }>('SELECT payment_id FROM payment_provider WHERE provider = $1 AND ref = $2', [provider, ref]);
  return row?.payment_id ?? null;
}

interface LogRow { id: string; at: string; kind: ProviderLogKind; method: string | null; path: string | null; status: number | null; ms: number | null; request: unknown; response: unknown; error: string | null }

/** Newest first. */
export async function logsFor(paymentId: string, limit = 100): Promise<ProviderLogView[]> {
  const rows = await db.query<LogRow>(
    'SELECT id, at, kind, method, path, status, ms, request, response, error FROM provider_log WHERE payment_id = $1 ORDER BY id DESC LIMIT $2',
    [paymentId, limit],
  );
  return rows.map((r) => ({ id: String(r.id), at: r.at, kind: r.kind, method: r.method, path: r.path, status: r.status, ms: r.ms, request: r.request, response: r.response, error: r.error }));
}

function json(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}
