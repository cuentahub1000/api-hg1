/**
 * The wallet, reached ONLY through its API (never its database). Same
 * `{ headers, path, query, body }` payload and `{ ok, data }` envelope whether
 * the wallet runs as Lambdas (`lambda:Invoke` on `${prefix}<slug>`) or as an
 * HTTP service.
 *
 * Authentication is the CALLER's: every call made for a player or an operator
 * forwards that caller's JWT (`{ token }`), so the wallet applies the caller's
 * own permissions and a player can only ever touch their own account. The
 * service's `x-api-key` (`SERVICE`) is used only where there is no caller:
 * the provider webhook and the re-checks it triggers.
 *
 * Three calls, nothing else:
 *   accountFor(partyId, accountId, auth) parties-get   {id}?include=accounts, then the one account
 *   createOperation(..., auth)           operations-create
 *   transition(operationId, event, auth) operations-transition
 */

import { getConfig, type WalletConfig } from '../_common/config';
import { db } from '../_common/db';
import { ForbiddenError, InsufficientFundsError, NotConfiguredError, UpstreamError } from '../_common/errors';
import { upstream } from '../_common/http';
import { log } from '../_common/logger';

export type WalletEvent = 'COMPLETE' | 'CANCEL' | 'ACCEPT' | 'REJECT';

/** Who the wallet sees: the caller's JWT, or this service (webhook only). */
export type WalletAuth = { token: string } | 'service';
export const SERVICE: WalletAuth = 'service';
/** The caller of a JWT-authenticated function. */
export const asCaller = (ctx: { token: string }): WalletAuth => ({ token: ctx.token });

export interface WalletAccount {
  id: string;
  currencyId: string | null;
  availableBalance: number;
  payoutBalance: number;
  cashableBalance: number | null;
}

export interface WalletOperation {
  id: string | number;
  identifier: string;
  status: string;
  amount: number;
}

interface Envelope<T> { ok: boolean; data?: T; statusCode?: number; error?: { type?: string; message?: string } }

interface Call {
  auth: WalletAuth;
  slug: string;
  method: 'GET' | 'POST';
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

async function cfg(): Promise<WalletConfig> {
  const w = (await getConfig()).wallet;
  if (!w) throw new NotConfiguredError('wallet');
  return w;
}

let lambdaClient: import('@aws-sdk/client-lambda').LambdaClient | undefined;

async function invoke<T>(call: Call): Promise<Envelope<T>> {
  const w = await cfg();
  const timeoutMs = (await getConfig()).upstreamTimeoutMs;
  if (w.mode === 'mock') return mockInvoke<T>(call);
  if (w.mode === 'http') {
    const url = `${w.apiUrl}${call.path}${call.query ? `?${new URLSearchParams(call.query)}` : ''}`;
    const res = await upstream<unknown>('wallet', {
      method: call.method, url, body: call.body, timeoutMs,
      headers: authHeaders(w, call.auth),
      allow: [400, 401, 403, 404, 409, 422],
    });
    // The HTTP runtime unwraps the envelope; rebuild it so both modes look alike.
    if (res.status >= 400) {
      const b = (res.data ?? {}) as { errorCode?: string; message?: string };
      return { ok: false, statusCode: res.status, error: { type: b.errorCode, message: b.message } };
    }
    return { ok: true, data: res.data as T };
  }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  lambdaClient ??= new LambdaClient(w.region ? { region: w.region } : {});
  const payload = {
    headers: authHeaders(w, call.auth),
    ...(call.pathParams ? { path: call.pathParams } : {}),
    ...(call.query ? { query: call.query } : {}),
    ...(call.body !== undefined ? { body: call.body } : {}),
  };
  const started = Date.now();
  const fnName = `${w.functionPrefix}${call.slug}`;
  try {
    const out = await lambdaClient.send(new InvokeCommand({ FunctionName: fnName, Payload: Buffer.from(JSON.stringify(payload)) }));
    if (out.FunctionError) {
      log.error('wallet function error', { fn: call.slug, err: out.FunctionError, ms: Date.now() - started });
      throw new UpstreamError('wallet', 500);
    }
    const text = Buffer.from(out.Payload ?? new Uint8Array()).toString('utf8');
    const env = JSON.parse(text || '{}') as Envelope<T>;
    log.debug('wallet call', { fn: call.slug, ok: env.ok, status: env.statusCode, ms: Date.now() - started });
    return env;
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    log.error('wallet unreachable', { fn: call.slug, err: String(err), ms: Date.now() - started });
    throw new UpstreamError('wallet', 0);
  }
}

function authHeaders(w: WalletConfig, auth: WalletAuth): Record<string, string> {
  if (auth !== 'service') {
    if (!auth.token) throw new UpstreamError('wallet', 401);
    return { authorization: `Bearer ${auth.token}` };
  }
  if (!w.apiKey) throw new NotConfiguredError('wallet');
  return { 'x-api-key': w.apiKey };
}

function orThrow<T>(env: Envelope<T>, what: string): T {
  if (env.ok && env.data !== undefined) return env.data;
  const status = env.statusCode ?? 502;
  log.warn('wallet refused', { what, status, type: env.error?.type, message: env.error?.message });
  if (status === 422 || status === 409) {
    const type = (env.error?.type ?? '').toUpperCase();
    const msg = (env.error?.message ?? '').toLowerCase();
    if (type.includes('BALANCE') || type.includes('FUNDS') || msg.includes('balance')) throw new InsufficientFundsError();
  }
  throw new UpstreamError('wallet', status);
}

/** All accounts of a party, as the wallet answers the caller. */
export async function accounts(partyId: string, auth: WalletAuth): Promise<WalletAccount[]> {
  const party = orThrow(await invoke<{ accounts?: Array<Record<string, unknown>>; defaultCurrency?: string }>({
    auth, slug: 'parties-get', method: 'GET', path: `/api/v1/parties/${encodeURIComponent(partyId)}`,
    pathParams: { id: partyId }, query: { include: 'accounts' },
  }), 'parties-get');
  return (party.accounts ?? []).map((a) => ({
    id: String(a.id),
    currencyId: (a.currencyId as string | undefined) ?? party.defaultCurrency ?? null,
    availableBalance: Number(a.availableBalance ?? 0),
    payoutBalance: Number(a.payoutBalance ?? 0),
    cashableBalance: a.cashableBalance === undefined ? null : Number(a.cashableBalance),
  }));
}

/**
 * The one account a payment is made on. The party is the security boundary
 * (from the JWT); the account must be one of that party's, otherwise 403.
 * Nothing is ever picked for the caller.
 */
export async function accountFor(partyId: string, accountId: string, auth: WalletAuth): Promise<WalletAccount> {
  const all = await accounts(partyId, auth);
  const a = all.find((x) => x.id === String(accountId));
  if (!a) throw new ForbiddenError('account does not belong to the caller');
  return a;
}

export interface CreateOperationInput {
  kind: 'deposit' | 'withdrawal';
  accountId: string;
  amount: number;
  /** Our payment id; the wallet's idempotency key. */
  externalReference: string;
}

/**
 * CREDIT/deposit lands as PENDING (visible, not spendable) until COMPLETE;
 * DEBIT/withdrawal blocks the amount at once until COMPLETE or CANCEL.
 */
export async function createOperation(input: CreateOperationInput, auth: WalletAuth): Promise<WalletOperation> {
  const body = {
    amount: input.amount,
    operationType: input.kind === 'deposit' ? 'CREDIT' : 'DEBIT',
    subtype: input.kind,
    destinationAccountId: input.accountId,
    externalReference: input.externalReference,
    origin: 'payments',
  };
  const op = orThrow(await invoke<Record<string, unknown>>({ auth, slug: 'operations-create', method: 'POST', path: '/api/v1/operations', body }), 'operations-create');
  return toOperation(op);
}

/** The operation created for `externalReference`, or null. Resolves a retry after a lost answer. */
export async function findByReference(externalReference: string, auth: WalletAuth): Promise<WalletOperation | null> {
  const list = orThrow(await invoke<Array<Record<string, unknown>>>({ auth, slug: 'operations-find', method: 'POST', path: '/api/v1/operations/find', body: { externalReference, limit: 1 } }), 'operations-find');
  return list.length > 0 ? toOperation(list[0]) : null;
}

/**
 * `createOperation`, safe to repeat: the wallet resumes a `CREATED` operation
 * with the same reference and refuses one that already went further; in that
 * case the existing operation is looked up and returned instead of failing.
 */
export async function createOrFind(input: CreateOperationInput, auth: WalletAuth): Promise<WalletOperation> {
  try {
    return await createOperation(input, auth);
  } catch (err) {
    if (!(err instanceof UpstreamError) || (err.upstreamStatus !== 409 && err.upstreamStatus !== 422)) throw err;
    const existing = await findByReference(input.externalReference, auth);
    if (!existing) throw err;
    log.info('wallet operation already existed', { reference: input.externalReference, operation: existing.identifier, status: existing.status });
    return existing;
  }
}

const DONE: Record<WalletEvent, string[]> = {
  COMPLETE: ['COMPLETED'],
  CANCEL: ['CANCELED', 'CANCELLED', 'REJECTED'],
  ACCEPT: ['ACCEPTED', 'COMPLETED'],
  REJECT: ['REJECTED', 'CANCELED', 'CANCELLED'],
};

/**
 * `transition`, safe to repeat: when the wallet refuses because the operation
 * is no longer in a state that takes the event, and it already reached the
 * state the event leads to, that counts as done.
 */
export async function ensureTransition(operationId: string, event: WalletEvent, externalReference: string, auth: WalletAuth): Promise<WalletOperation> {
  try {
    return await transition(operationId, event, auth);
  } catch (err) {
    if (!(err instanceof UpstreamError) || (err.upstreamStatus !== 409 && err.upstreamStatus !== 422)) throw err;
    const current = await findByReference(externalReference, auth);
    if (current && DONE[event].includes(current.status.toUpperCase())) {
      log.info('wallet operation already transitioned', { operation: operationId, event, status: current.status });
      return current;
    }
    throw err;
  }
}

export async function transition(operationId: string, event: WalletEvent, auth: WalletAuth): Promise<WalletOperation> {
  const op = orThrow(await invoke<Record<string, unknown>>({
    auth, slug: 'operations-transition', method: 'POST',
    path: `/api/v1/operations/${encodeURIComponent(operationId)}/transition`,
    pathParams: { id: operationId }, body: { event },
  }), 'operations-transition');
  return toOperation(op);
}

function toOperation(op: Record<string, unknown>): WalletOperation {
  const inner = (op.operation as Record<string, unknown> | undefined) ?? op;
  return {
    id: (inner.id as string | number) ?? '',
    identifier: String(inner.identifier ?? inner.id ?? ''),
    status: String(inner.status ?? ''),
    amount: Number(inner.amount ?? 0),
  };
}

// ---- sandbox wallet ------------------------------------------------------------
//
// `WALLET_MODE=mock`: one account per party, created on first sight with
// `WALLET_MOCK_BALANCE` (default 100000) in the payout bucket, and the same
// PENDING -> COMPLETE | CANCEL operations the real wallet runs. State lives in
// two sandbox tables (`sql/003_sandbox_wallet.sql`) so every process sees it.

interface MockAccount { id: number; party_id: string; available: string; payout: string; blocked: string; pending: string }
interface MockOperation { identifier: string; account_id: number; type: 'CREDIT' | 'DEBIT'; subtype: string; amount: string; status: string; external_reference: string }

async function mockAccountFor(partyId: string): Promise<MockAccount> {
  const start = Number(process.env.WALLET_MOCK_BALANCE ?? '100000') || 100000;
  await db.execute('INSERT INTO sandbox_wallet_account (party_id, available, payout) VALUES ($1, $2, $2) ON CONFLICT (party_id) DO NOTHING', [partyId, start.toFixed(2)]);
  return (await db.one<MockAccount>('SELECT * FROM sandbox_wallet_account WHERE party_id = $1', [partyId]))!;
}

function opView(o: MockOperation): Record<string, unknown> {
  return { identifier: o.identifier, id: o.identifier, status: o.status, amount: Number(o.amount), operationType: o.type, subtype: o.subtype, externalReference: o.external_reference };
}

async function mockInvoke<T>(call: Call): Promise<Envelope<T>> {
  const fail = (statusCode: number, type: string, message: string): Envelope<T> => ({ ok: false, statusCode, error: { type, message } });
  if (call.slug === 'parties-get') {
    const partyId = call.pathParams?.id ?? '';
    const a = await mockAccountFor(partyId);
    return { ok: true, data: { id: partyId, identifier: partyId, defaultCurrency: 'ARS', accounts: [{ id: String(a.id), currencyId: 'ARS', availableBalance: Number(a.available), payoutBalance: Number(a.payout), blockedBalance: Number(a.blocked), pendingBalance: Number(a.pending), cashableBalance: Number(a.payout) }] } as T };
  }
  if (call.slug === 'operations-create') {
    const b = call.body as { amount: number; operationType: 'CREDIT' | 'DEBIT'; subtype: string; destinationAccountId: string; externalReference: string };
    const existing = await db.one<MockOperation>('SELECT * FROM sandbox_wallet_operation WHERE external_reference = $1', [b.externalReference]);
    if (existing) return { ok: true, data: opView(existing) as T };
    const a = await db.one<MockAccount>('SELECT * FROM sandbox_wallet_account WHERE id = $1', [Number(b.destinationAccountId)]);
    if (!a) return fail(404, 'ENTITY_NOT_FOUND', 'account not found');
    const amt = b.amount.toFixed(2);
    if (b.operationType === 'DEBIT') {
      if (Number(a.payout) < b.amount) return fail(422, 'NOT_ENOUGH_PAYOUT_BALANCE', `Not enough payout balance for account ${a.id}`);
      await db.execute('UPDATE sandbox_wallet_account SET payout = payout - $2, available = available - $2, blocked = blocked + $2 WHERE id = $1', [a.id, amt]);
    } else {
      await db.execute('UPDATE sandbox_wallet_account SET pending = pending + $2 WHERE id = $1', [a.id, amt]);
    }
    const identifier = `mockop${Date.now()}${Math.floor(Math.random() * 1e6)}`.padEnd(25, '0').slice(0, 25);
    const op = (await db.one<MockOperation>(
      `INSERT INTO sandbox_wallet_operation (identifier, account_id, type, subtype, amount, status, external_reference) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6) RETURNING *`,
      [identifier, a.id, b.operationType, b.subtype, amt, b.externalReference],
    ))!;
    log.info('sandbox wallet operation', { op: identifier, type: op.type, amount: b.amount, account: a.id });
    return { ok: true, data: opView(op) as T };
  }
  if (call.slug === 'operations-find') {
    const b = call.body as { externalReference?: string };
    const rows = await db.query<MockOperation>('SELECT * FROM sandbox_wallet_operation WHERE external_reference = $1', [b.externalReference ?? '']);
    return { ok: true, data: rows.map(opView) as T };
  }
  if (call.slug === 'operations-transition') {
    const op = await db.one<MockOperation>('SELECT * FROM sandbox_wallet_operation WHERE identifier = $1', [call.pathParams?.id ?? '']);
    if (!op) return fail(404, 'ENTITY_NOT_FOUND', 'operation not found');
    const event = (call.body as { event: WalletEvent }).event;
    if (op.status !== 'PENDING' && op.status !== 'ACCEPTED') return fail(422, 'INVALID_STATE', `operation is ${op.status}`);
    let status = op.status;
    if (event === 'ACCEPT') status = 'ACCEPTED';
    else if (event === 'COMPLETE') {
      if (op.type === 'DEBIT') await db.execute('UPDATE sandbox_wallet_account SET blocked = blocked - $2 WHERE id = $1', [op.account_id, op.amount]);
      else await db.execute('UPDATE sandbox_wallet_account SET pending = pending - $2, available = available + $2 WHERE id = $1', [op.account_id, op.amount]);
      status = 'COMPLETED';
    } else {
      if (op.type === 'DEBIT') await db.execute('UPDATE sandbox_wallet_account SET blocked = blocked - $2, payout = payout + $2, available = available + $2 WHERE id = $1', [op.account_id, op.amount]);
      else await db.execute('UPDATE sandbox_wallet_account SET pending = pending - $2 WHERE id = $1', [op.account_id, op.amount]);
      status = event === 'REJECT' ? 'REJECTED' : 'CANCELED';
    }
    await db.execute('UPDATE sandbox_wallet_operation SET status = $2 WHERE identifier = $1', [op.identifier, status]);
    log.info('sandbox wallet transition', { op: op.identifier, event, status });
    return { ok: true, data: opView({ ...op, status }) as T };
  }
  return fail(404, 'ENTITY_NOT_FOUND', `no sandbox function ${call.slug}`);
}
