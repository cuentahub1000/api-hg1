/**
 * The Kubernetes runtime: one Node process serving every route in
 * `lambdas/_routes.ts` through the same handlers the Lambda deployment uses.
 *
 * No framework: a dozen JSON endpoints and a health check, with the contract
 * already fixed by the envelope. Body size is capped, every request is logged
 * as one line, the webhook route keeps its raw body for the HMAC check, and
 * the process drains on SIGTERM so a rolling update loses no request.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from '../lambdas/_common/logger';
import { getConfig } from '../lambdas/_common/config';
import { checkEnv } from '../lambdas/_common/db';
import { compile, match, queryToRecord, toHttp, type Handler } from './router';
import { handleSandbox } from '../lambdas/_domain/providers/sandbox';

import { handler as depositsCreate } from '../lambdas/deposits-create';
import { handler as withdrawalsCreate } from '../lambdas/withdrawals-create';
import { handler as withdrawalsCancel } from '../lambdas/withdrawals-cancel';
import { handler as paymentsList } from '../lambdas/payments-list';
import { handler as paymentsGet } from '../lambdas/payments-get';
import { handler as adminPaymentsList } from '../lambdas/admin-payments-list';
import { handler as adminPaymentsGet } from '../lambdas/admin-payments-get';
import { handler as adminPaymentsApprove } from '../lambdas/admin-payments-approve';
import { handler as adminPaymentsReject } from '../lambdas/admin-payments-reject';
import { handler as adminSettingsGet } from '../lambdas/admin-settings-get';
import { handler as adminSettingsUpdate } from '../lambdas/admin-settings-update';
import { handler as adminReconcile } from '../lambdas/admin-reconcile';
import { handler as adminPaymentsCancel } from '../lambdas/admin-payments-cancel';
import { handler as adminPlayerGet } from '../lambdas/admin-player-get';
import { handler as adminPlayerLimitsUpdate } from '../lambdas/admin-player-limits-update';
import { handler as adminPlayerBlock } from '../lambdas/admin-player-block';
import { handler as adminPlayerUnblock } from '../lambdas/admin-player-unblock';
import { handler as adminPaymentsResolve } from '../lambdas/admin-payments-resolve';
import { handler as adminQueueList } from '../lambdas/admin-queue-list';
import { handler as adminQueueRun } from '../lambdas/admin-queue-run';
import { handler as adminPaymentsPrioritize } from '../lambdas/admin-payments-prioritize';
import { runQueue } from '../lambdas/_domain/queue';
import { handler as webhook } from '../lambdas/webhook';

const HANDLERS: Record<string, Handler> = {
  'deposits-create': depositsCreate as Handler,
  'withdrawals-create': withdrawalsCreate as Handler,
  'withdrawals-cancel': withdrawalsCancel as Handler,
  'payments-list': paymentsList as Handler,
  'payments-get': paymentsGet as Handler,
  'admin-payments-list': adminPaymentsList as Handler,
  'admin-payments-get': adminPaymentsGet as Handler,
  'admin-payments-approve': adminPaymentsApprove as Handler,
  'admin-payments-reject': adminPaymentsReject as Handler,
  'admin-settings-get': adminSettingsGet as Handler,
  'admin-settings-update': adminSettingsUpdate as Handler,
  'admin-reconcile': adminReconcile as Handler,
  'admin-payments-cancel': adminPaymentsCancel as Handler,
  'admin-player-get': adminPlayerGet as Handler,
  'admin-player-limits-update': adminPlayerLimitsUpdate as Handler,
  'admin-player-block': adminPlayerBlock as Handler,
  'admin-player-unblock': adminPlayerUnblock as Handler,
  'admin-payments-resolve': adminPaymentsResolve as Handler,
  'admin-queue-list': adminQueueList as Handler,
  'admin-queue-run': adminQueueRun as Handler,
  'admin-payments-prioritize': adminPaymentsPrioritize as Handler,
  webhook: webhook as unknown as Handler,
};

/** Routes whose body must reach the handler as the raw text (signature checks). */
const RAW_BODY = new Set(['webhook']);

const MAX_BODY_BYTES = 64 * 1024;
const PORT = Number(process.env.PORT ?? '8080');
const PREFIX = (process.env.PAYMENTS_PATH_PREFIX ?? '').replace(/\/+$/, '');

const routes = compile(HANDLERS);

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = url.pathname;
  if (PREFIX && pathname.startsWith(PREFIX)) pathname = pathname.slice(PREFIX.length) || '/';
  const method = (req.method ?? 'GET').toUpperCase();

  if (pathname === '/healthz' || pathname === '/readyz') {
    send(res, 200, { ok: true });
    return;
  }
  if (pathname.startsWith('/sandbox')) {
    const sb = (await getConfig()).provider?.mode === 'mock' ? await handleSandbox(method, pathname) : null;
    if (sb) {
      res.writeHead(sb.status, { 'content-type': sb.contentType, 'cache-control': 'no-store', ...(sb.location ? { location: sb.location } : {}) });
      res.end(sb.body);
      return;
    }
  }

  const found = match(routes, method, pathname);
  if (found === null) { send(res, 404, { errorCode: 'NOT_FOUND', message: 'Not found', statusCode: 404 }); return; }
  if (found === 'method') { send(res, 405, { errorCode: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', statusCode: 405 }); return; }

  let raw: string | undefined;
  try {
    raw = await readBody(req);
  } catch {
    send(res, 413, { errorCode: 'PAYLOAD_TOO_LARGE', message: 'Body too large', statusCode: 413 });
    return;
  }
  let body: unknown = raw;
  if (raw !== undefined && !RAW_BODY.has(found.route.spec.slug)) {
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, { errorCode: 'VALIDATION_ERROR', message: 'Body is not valid JSON', statusCode: 400 });
      return;
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const envelope = await found.route.handler({ headers, path: found.path, query: queryToRecord(url.searchParams), body });
  const out = toHttp(envelope);
  send(res, out.status, out.body);
  log.info('request', { method, path: pathname, fn: found.route.spec.slug, status: out.status, ms: Date.now() - started });
}

async function main(): Promise<void> {
  checkEnv();
  await getConfig();
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('request crashed', { err: String(err) });
      if (!res.headersSent) send(res, 500, { errorCode: 'PAYMENTS_ERROR', message: 'There was an error processing the request', statusCode: 500 });
    });
  });
  server.listen(PORT, () => log.info('listening', { port: PORT, prefix: PREFIX || '/' }));
  // What EventBridge does for the Lambda deployment: pay the withdrawal queues every minute.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runQueue().catch((err) => log.error('queue run crashed', { err: String(err) })).finally(() => { running = false; });
  }, 60_000);
  const drain = () => {
    log.info('draining');
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);
}

main().catch((err) => {
  log.error('startup failed', { err: String(err) });
  process.exit(1);
});
