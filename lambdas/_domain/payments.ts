/**
 * The payment lifecycle. Every state change goes through here, writes the
 * row and an event, and talks to the wallet / provider through their clients
 * only. The `payment` row is ours; the provider's side of it (reference,
 * status, hosted page) is `payment_provider`.
 *
 * Deposit:    pending -> (paid) -> awaiting_approval -> completed | rejected
 *                     -> under_review | expired | cancelled | failed
 *             wallet: CREDIT/deposit PENDING at creation; COMPLETE credits; CANCEL drops it.
 * Withdrawal: awaiting_approval -> queued -> processing -> completed | rejected | failed | cancelled
 *             (no hold: created directly as queued). `queue.ts` pays the queue
 *             from the provider account's balance, every minute.
 *             wallet: DEBIT/withdrawal PENDING blocks at creation; COMPLETE finalises;
 *             CANCEL (reject/fail/cancel) releases the blocked amount.
 *
 * Before anything is created the player's blocks and limits are checked
 * (`players.ts`). Decisions take an optimistic lock on `version`, so two
 * operators clicking at once produce one decision and one 409.
 */

import { randomUUID } from 'node:crypto';
import { db, type Queryable } from '../_common/db';
import { getConfig } from '../_common/config';
import { ConflictError, InvalidStateError, NotConfiguredError, NotFoundError, RequestInProgressError, UpstreamError } from '../_common/errors';
import { documentHash } from '../_common/hash';
import { log } from '../_common/logger';
import { rootOf } from '../_common/chain';
import type { SecurityContext } from '../_common/auth';
import { provider, type Checkout, type Payout } from './providers';
import * as wallet from './wallet';
import { SERVICE, asCaller } from './wallet';
import { logsFor, type ProviderLogView } from './provider-log';
import { getSettings, needsHold } from './settings';
import { checkBlock, checkLimits } from './players';
import {
  adminView, isFinal, moneyParam, playerView, PAYMENT_SELECT,
  type Destination, type Payer, type PaymentAdminView, type PaymentEventRow, type PaymentKind, type PaymentRow, type PaymentStatus, type PaymentView,
  OPEN_STATUSES,
} from './types';

// ---- reads -----------------------------------------------------------------

export interface ListFilter {
  kind?: PaymentKind;
  statuses?: PaymentStatus[];
  partyId?: string;
  accountId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export interface Page<T> { data: T[]; nextCursor: string | null }

interface Cursor { at: string; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.at === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.at))) return c;
  } catch { /* fall through */ }
  throw new InvalidStateError('invalid cursor');
}

/** Rows of the caller's own party (player) or of the caller's subtree (operator). */
async function listRows(scope: { partyId?: string; fullChain?: string }, f: ListFilter): Promise<Page<PaymentRow>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (scope.partyId) where.push(`p.party_id = ${p(scope.partyId)}`);
  if (scope.fullChain) where.push(`(p.chain = ${p(scope.fullChain)} OR p.chain LIKE ${p(`${scope.fullChain}-%`)})`);
  if (f.kind) where.push(`p.kind = ${p(f.kind)}`);
  if (f.statuses?.length) where.push(`p.status = ANY(${p(f.statuses)})`);
  if (f.partyId) where.push(`p.party_id = ${p(f.partyId)}`);
  if (f.from) where.push(`p.created_at >= ${p(f.from)}`);
  if (f.to) where.push(`p.created_at <= ${p(f.to)}`);
  const cur = decodeCursor(f.cursor);
  if (cur) where.push(`(p.created_at, p.id) < (${p(cur.at)}, ${p(cur.id)})`);
  const rows = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.created_at DESC, p.id DESC LIMIT ${p(f.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return { data: page, nextCursor: rows.length > f.limit && last ? encodeCursor({ at: last.created_at, id: last.id }) : null };
}

export async function listForPlayer(ctx: SecurityContext, f: ListFilter): Promise<Page<PaymentView>> {
  const page = await listRows({ partyId: ctx.partyId }, f);
  return { data: page.data.map(playerView), nextCursor: page.nextCursor };
}

export async function listForOperator(ctx: SecurityContext, f: ListFilter): Promise<Page<PaymentAdminView>> {
  const page = await listRows({ fullChain: ctx.fullChain }, f);
  return { data: page.data.map(adminView), nextCursor: page.nextCursor };
}

async function rowById(id: string, q: Queryable = db): Promise<PaymentRow | null> {
  return q.one<PaymentRow>(`SELECT ${PAYMENT_SELECT} WHERE p.id = $1`, [id]);
}

async function rowFor(id: string, scope: { partyId?: string; fullChain?: string }): Promise<PaymentRow> {
  const params: unknown[] = [id];
  let where = 'p.id = $1';
  if (scope.partyId) { params.push(scope.partyId); where += ` AND p.party_id = $${params.length}`; }
  if (scope.fullChain) { params.push(scope.fullChain, `${scope.fullChain}-%`); where += ` AND (p.chain = $${params.length - 1} OR p.chain LIKE $${params.length})`; }
  const row = await db.one<PaymentRow>(`SELECT ${PAYMENT_SELECT} WHERE ${where}`, params);
  if (!row) throw new NotFoundError('Payment not found');
  return row;
}

async function rowByProviderRef(providerName: string, ref: string, kind: PaymentKind): Promise<PaymentRow | null> {
  return db.one<PaymentRow>(`SELECT ${PAYMENT_SELECT} WHERE pp.provider = $1 AND pp.ref = $2 AND p.kind = $3`, [providerName, ref, kind]);
}

export async function getForPlayer(ctx: SecurityContext, id: string): Promise<PaymentView> {
  let row = await rowFor(id, { partyId: ctx.partyId });
  row = await recheckIfStale(row);
  return playerView(row);
}

export async function getForOperator(ctx: SecurityContext, id: string): Promise<{ payment: PaymentAdminView; events: Array<{ at: string; actor: string; actorName: string | null; type: string; data: unknown }>; logs: ProviderLogView[] }> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  const events = await db.query<PaymentEventRow>('SELECT * FROM payment_event WHERE payment_id = $1 ORDER BY id', [row.id]);
  const logs = await logsFor(row.id);
  return { payment: adminView(row), events: events.map((e) => ({ at: e.at, actor: e.actor, actorName: e.actor_name, type: e.type, data: e.data })), logs };
}

/**
 * Operator scope for the per-player endpoints. Rules are per tenant, so the
 * answer is always the operator's own tenant; the party must sit inside the
 * operator's subtree (known from its payments) and must not belong to another
 * tenant. A party with no payment yet can only be managed by a root operator,
 * and the rules then wait under this tenant until the player's first payment.
 */
export async function assertPartyInScope(ctx: SecurityContext, partyId: string): Promise<string> {
  const tenant = rootOf(ctx.fullChain);
  const elsewhere = await db.one<{ n: string }>('SELECT count(*)::text AS n FROM payment WHERE party_id = $1 AND tenant <> $2', [partyId, tenant]);
  if (Number(elsewhere?.n ?? 0) > 0) throw new NotFoundError('Player not found');
  const inScope = await db.one<{ n: string }>(
    'SELECT count(*)::text AS n FROM payment WHERE party_id = $1 AND tenant = $2 AND (chain = $3 OR chain LIKE $4)',
    [partyId, tenant, ctx.fullChain, `${ctx.fullChain}-%`],
  );
  if (Number(inScope?.n ?? 0) === 0 && ctx.chain !== '') throw new NotFoundError('Player not found');
  return tenant;
}

// ---- writes ------------------------------------------------------------------

async function addEvent(q: Queryable, paymentId: string, actor: string, type: string, data?: unknown, actorName?: string | null): Promise<void> {
  await q.execute('INSERT INTO payment_event (payment_id, actor, actor_name, type, data) VALUES ($1, $2, $3, $4, $5)', [paymentId, actor, actorName ?? null, type, data === undefined ? null : JSON.stringify(data)]);
}

/** `operator:<partyId>` plus the name the back-office shows. */
function operatorActor(ctx: SecurityContext): { actor: string; name: string } {
  return { actor: `operator:${ctx.partyId}`, name: ctx.displayName || ctx.username || ctx.partyId };
}

interface Patch {
  status?: PaymentStatus;
  decided_by_name?: string | null;
  hold?: boolean;
  wallet_operation_id?: string | null;
  wallet_status?: string | null;
  fee?: number | null;
  note?: string | null;
  decided_by?: string | null;
  error_code?: string | null;
  priority?: number;
  completed?: boolean;
}

/** UPDATE the payment row; with `expectVersion` it is an optimistic lock (0 rows = 409). */
async function patch(id: string, p: Patch, expectVersion?: number): Promise<PaymentRow> {
  const sets: string[] = ['updated_at = now()', 'version = version + 1'];
  const params: unknown[] = [id];
  const add = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'completed') { if (v) sets.push('completed_at = now()'); continue; }
    if (k === 'fee') { add('fee', v === null || v === undefined ? null : moneyParam(v as number)); continue; }
    if (k === 'decided_by') { add('decided_by', v); sets.push('decided_at = now()'); continue; }
    add(k, v);
  }
  let where = 'id = $1';
  if (expectVersion !== undefined) { params.push(expectVersion); where += ` AND version = $${params.length}`; }
  const n = await db.execute(`UPDATE payment SET ${sets.join(', ')} WHERE ${where}`, params);
  if (n === 0) throw new ConflictError('The payment was changed by someone else');
  return (await rowById(id))!;
}

/** Upsert the provider's side of a payment. */
async function setProvider(paymentId: string, providerName: string, p: { ref: string; status?: string | null; checkoutUrl?: string | null; expiresAt?: string | null; data?: unknown }): Promise<void> {
  await db.execute(
    `INSERT INTO payment_provider (payment_id, provider, ref, status, checkout_url, expires_at, data, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (payment_id) DO UPDATE SET provider = EXCLUDED.provider, ref = EXCLUDED.ref,
       status = coalesce(EXCLUDED.status, payment_provider.status), checkout_url = coalesce(EXCLUDED.checkout_url, payment_provider.checkout_url),
       expires_at = coalesce(EXCLUDED.expires_at, payment_provider.expires_at), data = coalesce(EXCLUDED.data, payment_provider.data), updated_at = now()`,
    [paymentId, providerName, p.ref, p.status ?? null, p.checkoutUrl ?? null, p.expiresAt ?? null, p.data === undefined ? null : JSON.stringify(p.data)],
  );
}

async function setProviderStatus(paymentId: string, status: string, data?: unknown): Promise<void> {
  await db.execute('UPDATE payment_provider SET status = $2, data = coalesce($3, data), updated_at = now() WHERE payment_id = $1', [paymentId, status, data === undefined ? null : JSON.stringify(data)]);
}

function assertStatus(row: PaymentRow, allowed: PaymentStatus[]): void {
  if (!allowed.includes(row.status)) throw new InvalidStateError(`A ${row.kind} in status '${row.status}' cannot take this action`);
}

function clientOf(ctx: SecurityContext): string | null {
  return ctx.ip || ctx.userAgent ? JSON.stringify({ ip: ctx.ip, userAgent: ctx.userAgent }) : null;
}

export interface CreateDepositInput { amount: number; accountId: string; payer?: Payer; locale?: string }

export async function createDeposit(ctx: SecurityContext, input: CreateDepositInput): Promise<PaymentView> {
  const cfg = await getConfig();
  if (!cfg.provider) throw new NotConfiguredError('payments');
  const tenant = rootOf(ctx.fullChain);
  const s = await getSettings(tenant);
  if (!s.depositsEnabled) throw new NotConfiguredError('deposits');
  await checkBlock(ctx, 'deposit');
  await checkLimits(ctx, 'deposit', input.amount, s);

  const auth = asCaller(ctx);
  const account = await wallet.accountFor(ctx.partyId, input.accountId, auth);
  const prov = await provider();
  const id = randomUUID();
  const storedPayer = input.payer ? { name: input.payer.name, email: input.payer.email } : null;
  // 1. our row, so the provider reference always has a home
  await db.execute(
    `INSERT INTO payment (id, kind, status, tenant, party_id, username, chain, account_id, currency, amount, provider, payer, document_hash, client)
     VALUES ($1, 'deposit', 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, tenant, ctx.partyId, ctx.username || null, ctx.chain, account.id, account.currencyId ?? cfg.currency, moneyParam(input.amount), prov.name,
      storedPayer && (storedPayer.name || storedPayer.email) ? JSON.stringify(storedPayer) : null, documentHash(input.payer?.document, cfg.documentHashKey), clientOf(ctx)],
  );
  await addEvent(db, id, 'player', 'created', { amount: input.amount, ip: ctx.ip, userAgent: ctx.userAgent });

  // 2. the hosted checkout. No wallet operation yet: the wallet is credited
  // only when the provider confirms the payment (completeDeposit).
  let row: PaymentRow;
  try {
    const q = `payment=${encodeURIComponent(id)}`;
    const co = await prov.createCheckout({
      paymentId: id, amount: input.amount, payer: input.payer, locale: input.locale, country: cfg.provider.country,
      successUrl: `${cfg.returnUrl}?${q}`, cancelUrl: `${cfg.cancelUrl}?${q}&cancelled=1`, accountId: s.depositAccountId,
    });
    await setProvider(id, prov.name, { ref: co.id, status: co.status, checkoutUrl: co.checkoutUrl, expiresAt: co.expiresAt, data: co.raw });
    await addEvent(db, id, 'system', 'checkout_opened', { ref: co.id });
    row = (await rowById(id))!;
  } catch (err) {
    await patch(id, { status: 'failed', error_code: 'PROVIDER' });
    await addEvent(db, id, 'system', 'failed', { step: 'provider' });
    throw err;
  }
  return playerView(row);
}

export interface CreateWithdrawalInput { amount: number; accountId: string; destination: Destination; document?: string }

export async function createWithdrawal(ctx: SecurityContext, input: CreateWithdrawalInput): Promise<PaymentView> {
  const cfg = await getConfig();
  if (!cfg.provider) throw new NotConfiguredError('payments');
  const tenant = rootOf(ctx.fullChain);
  const s = await getSettings(tenant);
  if (!s.withdrawalsEnabled) throw new NotConfiguredError('withdrawals');
  await checkBlock(ctx, 'withdrawal');
  const lim = await checkLimits(ctx, 'withdrawal', input.amount, s);
  const open = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT} WHERE p.party_id = $1 AND p.kind = 'withdrawal' AND p.status = ANY($2) ORDER BY p.created_at DESC`,
    [ctx.partyId, OPEN_STATUSES],
  );
  if (open.length >= lim.maxOpenWithdrawals) {
    const blocking = open[0];
    throw new RequestInProgressError('You already have a withdrawal in progress', {
      id: blocking.id, kind: blocking.kind, status: blocking.status, amount: Number(blocking.amount), currency: blocking.currency,
      createdAt: blocking.created_at, cancellable: blocking.status === 'awaiting_approval',
    });
  }

  const auth = asCaller(ctx);
  const account = await wallet.accountFor(ctx.partyId, input.accountId, auth);
  const prov = await provider();
  const hold = needsHold('withdrawal', input.amount, s);
  const id = randomUUID();
  await db.execute(
    `INSERT INTO payment (id, kind, status, tenant, party_id, username, chain, account_id, currency, amount, hold, provider, destination, document_hash, client)
     VALUES ($1, 'withdrawal', 'awaiting_approval', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, tenant, ctx.partyId, ctx.username || null, ctx.chain, account.id, account.currencyId ?? cfg.currency, moneyParam(input.amount), hold, prov.name,
      JSON.stringify(input.destination), documentHash(input.document, cfg.documentHashKey), clientOf(ctx)],
  );
  await addEvent(db, id, 'player', 'created', { amount: input.amount, destination: { type: input.destination.type, last4: input.destination.value.slice(-4) }, ip: ctx.ip, userAgent: ctx.userAgent });

  // Block the money now. The wallet refuses when the payout bucket is short.
  let row: PaymentRow;
  try {
    // The account was just verified as the caller's with the caller's own token
    // (accountFor); the block itself is created as the service, since a player
    // has no permission to create wallet operations.
    const op = await wallet.createOrFind({ kind: 'withdrawal', accountId: account.id, amount: input.amount, externalReference: `pay-${id}` }, SERVICE);
    row = await patch(id, { wallet_operation_id: op.identifier, wallet_status: op.status });
    await addEvent(db, id, 'system', 'wallet_blocked', { operation: op.identifier });
  } catch (err) {
    await patch(id, { status: 'failed', error_code: 'WALLET' });
    await addEvent(db, id, 'system', 'failed', { step: 'wallet' });
    throw err;
  }

  if (hold) {
    await addEvent(db, id, 'system', 'held');
    return playerView(row);
  }
  return playerView(await enqueue(row, 'system'));
}

/** Player cancels a withdrawal that has not been approved yet. */
export async function cancelWithdrawal(ctx: SecurityContext, id: string): Promise<PaymentView> {
  const row = await rowFor(id, { partyId: ctx.partyId });
  if (row.kind !== 'withdrawal') throw new InvalidStateError('Only withdrawals can be cancelled');
  assertStatus(row, ['awaiting_approval']);
  return playerView(await release(row, 'cancelled', 'player', null));
}

export async function approve(ctx: SecurityContext, id: string, note: string | undefined): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  assertStatus(row, ['awaiting_approval']);
  const actor = `operator:${ctx.partyId}`;
  if (row.kind === 'deposit') return adminView(await completeDeposit(row, actor, note ?? null));
  // withdrawal: mark the decision (lock), then into the queue; the queue run
  // sends the bank transfer once the provider account covers it.
  const { name } = operatorActor(ctx);
  const decided = await patch(row.id, { note: note ?? null, decided_by: ctx.partyId, decided_by_name: name }, row.version);
  await addEvent(db, id, actor, 'approved', note ? { note } : undefined, name);
  return adminView(await enqueue(decided, actor, name));
}

/** Operator moves a queued withdrawal: lower `priority` is paid first; steps of 1000 leave room between two. */
export async function setPriority(ctx: SecurityContext, id: string, priority: number): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  if (row.kind !== 'withdrawal') throw new InvalidStateError('Only withdrawals have a queue position');
  assertStatus(row, ['queued']);
  const { actor, name } = operatorActor(ctx);
  const updated = await patch(row.id, { priority }, row.version);
  await addEvent(db, row.id, actor, 'reprioritized', { from: row.priority === null ? null : Number(row.priority), to: priority }, name);
  return adminView(updated);
}

export async function reject(ctx: SecurityContext, id: string, note: string): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  // a queued withdrawal has not reached the provider: it can still be refused
  assertStatus(row, row.kind === 'withdrawal' ? ['awaiting_approval', 'queued'] : ['awaiting_approval']);
  const { actor, name } = operatorActor(ctx);
  return adminView(await release(row, 'rejected', actor, note, ctx.partyId, undefined, name));
}

/** Operator cancels a deposit nobody has paid yet: the checkout is cancelled and the pending wallet deposit dropped. */
export async function cancelDeposit(ctx: SecurityContext, id: string, note: string): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  if (row.kind !== 'deposit') throw new InvalidStateError('Only deposits can be cancelled here');
  assertStatus(row, ['pending']);
  return adminView(await release(row, 'cancelled', `operator:${ctx.partyId}`, note, ctx.partyId));
}

export interface ResolveInput { providerRef?: string; outcome?: 'failed'; note: string }

/**
 * Operator closes a withdrawal whose transfer request got no usable answer
 * (`processing` without a provider reference, after `submit_unknown` /
 * `submit_duplicate` and the automatic re-submissions). Either the provider's
 * reference is attached, found by the payment id the provider holds as its
 * external id, and the transfer's state is read from the provider; or the
 * operator, having confirmed no transfer exists, marks it failed and the
 * blocked amount returns to the player.
 */
export async function resolveWithdrawal(ctx: SecurityContext, id: string, input: ResolveInput): Promise<PaymentAdminView> {
  const row = await rowFor(id, { fullChain: ctx.fullChain });
  if (row.kind !== 'withdrawal') throw new InvalidStateError('Only withdrawals can be resolved');
  assertStatus(row, ['processing']);
  if (row.p_ref) throw new InvalidStateError('This withdrawal already has a provider reference; it resolves on its own');
  const { actor, name } = operatorActor(ctx);
  if (input.providerRef) {
    const prov = await provider();
    await setProvider(row.id, prov.name, { ref: input.providerRef, status: null });
    await addEvent(db, row.id, actor, 'provider_ref_attached', { ref: input.providerRef, note: input.note }, name);
    const after = await recheck((await rowById(row.id))!);
    return adminView(after ?? (await rowById(row.id))!);
  }
  if (input.outcome === 'failed') {
    return adminView(await release(row, 'failed', actor, input.note, ctx.partyId, 'OPERATOR_RESOLVED', name));
  }
  throw new InvalidStateError('resolve needs providerRef or outcome');
}

// ---- transitions shared by handlers, webhook and reconcile -----------------

/**
 * Deposit -> completed: credit the wallet, then close the row. The wallet
 * operation is created here, once the provider has confirmed the money, and
 * completed in the same step; both calls run as the service (the trigger is
 * a webhook, a re-check or an operator approval, never the player).
 */
async function completeDeposit(row: PaymentRow, actor: string, note: string | null): Promise<PaymentRow> {
  const reference = `pay-${row.id}`;
  let operationId = row.wallet_operation_id;
  if (!operationId) {
    const created = await wallet.createOrFind({ kind: 'deposit', accountId: row.account_id, amount: Number(row.amount), externalReference: reference }, SERVICE);
    operationId = created.identifier;
    await patch(row.id, { wallet_operation_id: operationId, wallet_status: created.status });
    await addEvent(db, row.id, 'system', 'wallet_created', { operation: operationId });
  }
  const op = await wallet.ensureTransition(operationId, 'COMPLETE', reference, SERVICE);
  const updated = await patch(row.id, {
    status: 'completed', wallet_status: op.status, completed: true, note,
    ...(actor.startsWith('operator:') ? { decided_by: actor.slice('operator:'.length) } : {}),
  }, row.version);
  await addEvent(db, row.id, actor, 'completed', { operation: op.identifier });
  return updated;
}

/**
 * Withdrawal or deposit leaves the pipeline without money moving: a withdrawal's
 * blocked amount is released by cancelling its wallet operation; a deposit has
 * no wallet operation before completion, so only the checkout is cancelled.
 */
async function release(row: PaymentRow, status: 'rejected' | 'cancelled' | 'failed' | 'expired', actor: string, note: string | null, decidedBy?: string, errorCode?: string, actorName?: string): Promise<PaymentRow> {
  let walletStatus = row.wallet_status;
  if (row.wallet_operation_id) {
    const op = await wallet.ensureTransition(row.wallet_operation_id, 'CANCEL', `pay-${row.id}`, SERVICE);
    walletStatus = op.status;
  }
  if (row.kind === 'deposit' && row.p_ref && row.status === 'pending' && status === 'cancelled' && actor !== 'provider') {
    await (await provider()).cancelCheckout(row.p_ref, row.id).catch((err) => log.warn('checkout cancel failed', { id: row.id, err: String(err) }));
  }
  const updated = await patch(row.id, {
    status, wallet_status: walletStatus, note: note ?? row.note, error_code: errorCode ?? null,
    ...(decidedBy ? { decided_by: decidedBy, decided_by_name: actorName ?? null } : {}),
  }, row.version);
  await addEvent(db, row.id, actor, status, note ? { note } : undefined, actorName);
  return updated;
}

/**
 * Withdrawal into the queue. Its place is the end of the tenant's queue (max
 * priority + 1000) unless it already had one (a request the provider could
 * not cover keeps its turn).
 */
async function enqueue(row: PaymentRow, actor: string, actorName?: string, errorCode: string | null = null): Promise<PaymentRow> {
  const n = await db.execute(
    `UPDATE payment SET status = 'queued', error_code = $3, updated_at = now(), version = version + 1,
       priority = coalesce(priority, (SELECT coalesce(max(priority), 0) + 1000 FROM payment WHERE tenant = $2 AND kind = 'withdrawal' AND status = 'queued'))
     WHERE id = $1 AND version = $4`,
    [row.id, row.tenant, errorCode, row.version],
  );
  if (n === 0) throw new ConflictError('The payment was changed by someone else');
  const updated = (await rowById(row.id))!;
  await addEvent(db, row.id, actor, 'queued', { priority: Number(updated.priority) }, actorName);
  return updated;
}

/**
 * Queued withdrawal, its turn come (`queue.ts`), or a `processing` one without
 * an answer: ask the provider for the bank transfer.
 *
 * The row goes to `processing` *before* the provider is called, so a
 * `processing` withdrawal without a provider reference always means "transfer
 * requested, answer not recorded". The payment id travels as the provider's
 * external id, which it keeps unique per account, so repeating the request can
 * never create a second transfer: it either succeeds (the first one never
 * existed), is refused (nothing exists, the money is released) or is reported
 * as a duplicate (the first one exists; its reference arrives by webhook or an
 * operator attaches it with `admin-payments-resolve`).
 */
export async function submitPayout(row: PaymentRow, actor: string, actorName?: string): Promise<PaymentRow> {
  if (!row.destination) throw new InvalidStateError('withdrawal has no destination');
  const prov = await provider();
  let current = row;
  if (row.status !== 'processing') {
    current = await patch(row.id, { status: 'processing' }, row.version);
    await addEvent(db, row.id, actor, 'submitting', undefined, actorName);
  }
  try {
    const { withdrawalAccountId } = await getSettings(row.tenant);
    const po = await prov.createPayout({ paymentId: row.id, amount: Number(row.amount), destination: row.destination, accountId: withdrawalAccountId });
    await setProvider(row.id, prov.name, { ref: po.id, status: po.status, data: po.raw });
    await addEvent(db, row.id, actor, 'submitted', { ref: po.id }, actorName);
    return (await rowById(row.id))!;
  } catch (err) {
    const outcome = prov.payoutFailure(err);
    if (outcome === 'insufficient') {
      // The provider account cannot cover it right now. Not the player's
      // failure: back into the queue at its own place, money still blocked;
      // the next queue run with enough balance sends it.
      log.warn('payout needs funds at the provider', { id: row.id, err: String(err) });
      await addEvent(db, row.id, 'system', 'provider_funds_short');
      return enqueue(current, 'system', undefined, 'PROVIDER_FUNDS');
    }
    if (outcome === 'refused') {
      // The provider holds nothing: give the money back and surface the failure.
      log.warn('payout refused', { id: row.id, err: String(err) });
      return release(current, 'failed', 'system', null, undefined, 'PROVIDER');
    }
    // duplicate: the provider already has this transfer; unknown: no answer. The
    // money stays blocked; the re-check resubmits until the reference is known.
    log.error('payout outcome unresolved', { id: row.id, outcome, err: String(err) });
    await addEvent(db, row.id, 'system', outcome === 'duplicate' ? 'submit_duplicate' : 'submit_unknown');
    return (await rowById(row.id))!;
  }
}

/**
 * A provider webhook named a transfer we have no reference for. When it also
 * carries the payment id (sent as the provider's external id), the reference
 * is attached to the withdrawal still waiting for it, so the status can be
 * applied.
 */
export async function adoptPayoutRef(paymentId: string, ref: string): Promise<boolean> {
  const row = await rowById(paymentId);
  if (!row || row.kind !== 'withdrawal' || row.status !== 'processing' || row.p_ref) return false;
  const prov = await provider();
  await setProvider(row.id, prov.name, { ref, status: null });
  await addEvent(db, row.id, 'provider', 'provider_ref_attached', { ref });
  return true;
}

/** Apply a provider checkout status to a deposit (webhook or re-check). */
export async function applyCheckout(ref: string, status: string, actor: 'provider' | 'system', extra?: Record<string, unknown>): Promise<PaymentRow | null> {
  const prov = await provider();
  const row = await rowByProviderRef(prov.name, ref, 'deposit');
  if (!row) { log.warn('checkout for unknown payment', { ref, status }); return null; }
  if (isFinal(row.status)) return row;
  const mapped = prov.mapCheckoutStatus(status);
  if (mapped === null) { log.warn('unknown checkout status', { ref, status }); return row; }
  // Same provider status as last time and nothing left to do here: no-op. A
  // final outcome is applied again on purpose (the earlier attempt may have
  // stopped before the wallet or the row was updated); every step is idempotent.
  const same = status.toLowerCase() === (row.p_status ?? '').toLowerCase();
  if (same && (mapped === 'pending' || (mapped === 'under_review' && row.status === 'under_review') || (mapped === 'paid' && row.status === 'awaiting_approval'))) return row;
  await setProviderStatus(row.id, status, extra);
  switch (mapped) {
    case 'paid': {
      if (row.status === 'awaiting_approval') return row;
      const settings = await getSettings(row.tenant);
      if (needsHold('deposit', Number(row.amount), settings)) {
        const held = await patch(row.id, { status: 'awaiting_approval', hold: true });
        await addEvent(db, row.id, actor, 'paid', extra);
        await addEvent(db, row.id, 'system', 'held');
        return held;
      }
      await addEvent(db, row.id, actor, 'paid', extra);
      return completeDeposit((await rowById(row.id))!, 'system', null);
    }
    case 'under_review': {
      const r = await patch(row.id, { status: 'under_review' });
      await addEvent(db, row.id, actor, 'under_review');
      return r;
    }
    case 'rejected': return release(row, 'rejected', actor, null, undefined, 'PROVIDER_REJECTED');
    case 'expired': return release(row, 'expired', actor, null);
    case 'cancelled': return release(row, 'cancelled', actor, null);
    case 'pending': return row;
  }
}

/** Apply a provider payout status to a withdrawal (webhook or re-check). */
export async function applyPayout(ref: string, status: string, actor: 'provider' | 'system', extra?: { errorCode?: string | null; fee?: number | null }): Promise<PaymentRow | null> {
  const prov = await provider();
  const row = await rowByProviderRef(prov.name, ref, 'withdrawal');
  if (!row) { log.warn('payout for unknown payment', { ref, status }); return null; }
  if (isFinal(row.status)) return row;
  const mapped = prov.mapPayoutStatus(status);
  // An unchanged, non-final provider status is a no-op. A final one is applied
  // again on purpose: the row is not final, so an earlier attempt stopped
  // before the wallet or the row was updated; every step is idempotent.
  if (mapped === null && status.toUpperCase() === (row.p_status ?? '').toUpperCase()) return row;
  await setProviderStatus(row.id, status, extra);
  if (extra?.fee !== undefined && extra.fee !== null) await patch(row.id, { fee: extra.fee });
  switch (mapped) {
    case 'done': {
      if (!row.wallet_operation_id) throw new UpstreamError('wallet', 500);
      const op = await wallet.ensureTransition(row.wallet_operation_id, 'COMPLETE', `pay-${row.id}`, SERVICE);
      const r = await patch(row.id, { status: 'completed', wallet_status: op.status, completed: true });
      await addEvent(db, row.id, actor, 'completed', { operation: op.identifier });
      return r;
    }
    case 'failed': return release(row, 'failed', actor, null, undefined, extra?.errorCode ?? 'PROVIDER_ERROR');
    case 'cancelled': return release(row, 'cancelled', actor, null);
    default: return (await rowById(row.id))!; // still on its way
  }
}

// ---- reconciliation ------------------------------------------------------------

async function recheckIfStale(row: PaymentRow): Promise<PaymentRow> {
  const open = (row.kind === 'deposit' && row.status === 'pending' && Boolean(row.p_ref)) || (row.kind === 'withdrawal' && row.status === 'processing');
  if (!open) return row;
  const { recheckAfterMs } = await getConfig();
  if (Date.now() - Date.parse(row.updated_at) < recheckAfterMs) return row;
  try {
    return (await recheck(row)) ?? row;
  } catch (err) {
    log.warn('re-check failed', { id: row.id, err: String(err) });
    return row;
  }
}

/**
 * Ask the provider for the current state of one open payment. A `processing`
 * withdrawal without a reference is re-submitted instead (see `submitPayout`).
 */
export async function recheck(row: PaymentRow): Promise<PaymentRow | null> {
  if (isFinal(row.status)) return row;
  if (row.kind === 'withdrawal' && row.status === 'processing' && !row.p_ref) return submitPayout(row, 'system');
  if (!row.p_ref) return row;
  const prov = await provider();
  if (row.kind === 'deposit') {
    const co: Checkout | null = await prov.getCheckout(row.p_ref, row.id);
    if (!co) return row;
    const mapped = prov.mapCheckoutStatus(co.status);
    const same = co.status.toLowerCase() === (row.p_status ?? '').toLowerCase();
    // Unchanged and already reflected: only mark the row as checked. A final
    // status is re-applied until the row is final too.
    if (same && (mapped === 'pending' || mapped === 'under_review' || (mapped === 'paid' && row.status === 'awaiting_approval'))) { await patch(row.id, {}); return row; }
    return applyCheckout(row.p_ref, co.status, 'system', { transactionId: co.transactionId, source: 'recheck' });
  }
  if (row.status !== 'processing') return row;
  const po: Payout | null = await prov.getPayout(row.p_ref, row.id);
  if (!po) return row;
  if (po.status === row.p_status && prov.mapPayoutStatus(po.status) === null) { await patch(row.id, {}); return row; }
  return applyPayout(row.p_ref, po.status, 'system', { errorCode: po.errorCode });
}

export async function reconcile(ctx: SecurityContext, staleMs = 10 * 60_000): Promise<{ checked: number; updated: number }> {
  const rows = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT}
      WHERE (p.chain = $1 OR p.chain LIKE $2) AND p.status = ANY($3) AND (pp.ref IS NOT NULL OR p.kind = 'withdrawal')
        AND p.updated_at < now() - ($4::text || ' milliseconds')::interval
      ORDER BY p.updated_at LIMIT 200`,
    [ctx.fullChain, `${ctx.fullChain}-%`, ['pending', 'under_review', 'processing'], String(staleMs)],
  );
  let updated = 0;
  for (const row of rows) {
    try {
      const after = await recheck(row);
      if (after && after.status !== row.status) updated++;
    } catch (err) {
      log.warn('reconcile item failed', { id: row.id, err: String(err) });
    }
  }
  return { checked: rows.length, updated };
}
