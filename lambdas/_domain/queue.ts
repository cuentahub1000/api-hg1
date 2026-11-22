/**
 * The withdrawal queue. Approved (or never held) withdrawals wait as `queued`;
 * every minute (`queue-run`, scheduled; the HTTP runtime's timer; or an
 * operator's `admin-queue-run`) each tenant's queue is paid from its provider
 * account's balance, in `priority` order (lower first, then creation):
 *
 *   fifo_stop_on_fail  stop at the first one the balance does not cover
 *   fit                pay every one the balance covers, skip the others
 *
 * The balance is read once per run and reduced by each transfer sent; the
 * provider's own refusal for funds (`provider_funds_short`) also counts as
 * "does not fit". One run per tenant at a time (advisory lock); a second
 * caller skips the tenant and reports it busy.
 */

import { db } from '../_common/db';
import { log } from '../_common/logger';
import { rootOf } from '../_common/chain';
import type { SecurityContext } from '../_common/auth';
import { provider } from './providers';
import { getSettings } from './settings';
import { submitPayout } from './payments';
import { adminView, PAYMENT_SELECT, type PaymentAdminView, type PaymentRow, type WithdrawalQueueMode } from './types';

export interface QueueRunResult {
  tenant: string;
  mode: WithdrawalQueueMode;
  /** Balance read before the run; null when the provider did not answer (nothing was sent). */
  balance: number | null;
  queued: number;
  submitted: number;
  skipped: number;
  /** `fifo_stop_on_fail`: the run stopped at a withdrawal the balance did not cover. */
  stopped: boolean;
  /** Another run of this tenant was in progress. */
  busy: boolean;
}

const QUEUE_ORDER = `ORDER BY p.priority NULLS LAST, p.created_at, p.id`;

async function queuedRows(tenant: string, limit = 500): Promise<PaymentRow[]> {
  return db.query<PaymentRow>(`SELECT ${PAYMENT_SELECT} WHERE p.tenant = $1 AND p.kind = 'withdrawal' AND p.status = 'queued' ${QUEUE_ORDER} LIMIT $2`, [tenant, limit]);
}

/** Every tenant with something queued, or just the given one. */
export async function runQueue(onlyTenant?: string): Promise<QueueRunResult[]> {
  const tenants = onlyTenant
    ? [onlyTenant]
    : (await db.query<{ tenant: string }>(`SELECT DISTINCT tenant FROM payment WHERE kind = 'withdrawal' AND status = 'queued' ORDER BY tenant`)).map((r) => r.tenant);
  const results: QueueRunResult[] = [];
  for (const tenant of tenants) {
    try {
      results.push(await runTenant(tenant));
    } catch (err) {
      log.error('queue run failed', { tenant, err: String(err) });
    }
  }
  return results;
}

async function runTenant(tenant: string): Promise<QueueRunResult> {
  const s = await getSettings(tenant);
  const result: QueueRunResult = { tenant, mode: s.withdrawalQueueMode, balance: null, queued: 0, submitted: 0, skipped: 0, stopped: false, busy: false };
  // The lock lives for this transaction only; the work itself uses the pool.
  return db.transaction(async (tx) => {
    const lock = await tx.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`withdrawal-queue:${tenant}`]);
    if (!lock?.ok) { result.busy = true; return result; }
    const rows = await queuedRows(tenant);
    result.queued = rows.length;
    if (rows.length === 0) return result;

    const prov = await provider();
    let available: number;
    try {
      available = await prov.getBalance(s.withdrawalAccountId);
    } catch (err) {
      log.warn('queue: provider balance unavailable', { tenant, err: String(err) });
      return result;
    }
    result.balance = available;

    for (const row of rows) {
      const amount = Number(row.amount);
      let fits = amount <= available;
      if (fits) {
        try {
          const after = await submitPayout(row, 'system');
          if (after.status === 'processing') { result.submitted++; available -= amount; }
          // back to queued = the provider itself found the account short (fees, a concurrent transfer)
          else if (after.status === 'queued') fits = false;
        } catch (err) {
          // a lost race or a wallet/database hiccup on this one: the next run sees it again
          log.warn('queue: withdrawal not sent', { tenant, id: row.id, err: String(err) });
          continue;
        }
      }
      if (!fits) {
        if (s.withdrawalQueueMode === 'fifo_stop_on_fail') { result.stopped = true; break; }
        result.skipped++;
      }
    }
    log.info('queue run', { ...result });
    return result;
  });
}

export interface QueueView {
  mode: WithdrawalQueueMode;
  /** Provider account balance; root operators only (null otherwise or when the provider did not answer). */
  balance: number | null;
  items: PaymentAdminView[];
}

/** The queue as the operator sees it: the subtree's queued withdrawals in payment order. */
export async function listQueue(ctx: SecurityContext): Promise<QueueView> {
  const tenant = rootOf(ctx.fullChain);
  const s = await getSettings(tenant);
  const rows = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_SELECT} WHERE p.tenant = $1 AND p.kind = 'withdrawal' AND p.status = 'queued' AND (p.chain = $2 OR p.chain LIKE $3) ${QUEUE_ORDER} LIMIT 500`,
    [tenant, ctx.fullChain, `${ctx.fullChain}-%`],
  );
  let balance: number | null = null;
  if (ctx.chain === '') {
    try { balance = await (await provider()).getBalance(s.withdrawalAccountId); } catch (err) { log.warn('queue: provider balance unavailable', { tenant, err: String(err) }); }
  }
  return { mode: s.withdrawalQueueMode, balance, items: rows.map(adminView) };
}
