/**
 * Per-tenant hold and limit settings. The tenant is the root of the player's
 * (or operator's) chain, so one brand's holds never leak into another's. A
 * tenant with no row gets the defaults below until a root operator saves the
 * form once. Per-player overrides live in `players.ts`.
 */

import { db } from '../_common/db';
import { getConfig } from '../_common/config';
import { ValidationError } from '../_common/errors';
import { moneyParam, money, QUEUE_MODES, type Settings } from './types';

interface Row {
  tenant: string;
  deposits_enabled: boolean;
  withdrawals_enabled: boolean;
  hold_deposits: boolean;
  hold_deposits_above: string | null;
  hold_withdrawals: boolean;
  hold_withdrawals_above: string | null;
  min_deposit: string;
  max_deposit: string;
  min_withdrawal: string;
  max_withdrawal: string;
  daily_deposit_max: string | null;
  weekly_deposit_max: string | null;
  monthly_deposit_max: string | null;
  daily_withdrawal_max: string | null;
  weekly_withdrawal_max: string | null;
  monthly_withdrawal_max: string | null;
  max_open_withdrawals: number;
  withdrawal_account_id: string | null;
  deposit_account_id: string | null;
  withdrawal_queue_mode: string;
  updated_at: string;
  updated_by: string | null;
}

export type WritableSettings = Omit<Settings, 'currency' | 'updatedAt' | 'updatedBy'>;

export const DEFAULTS: WritableSettings = {
  depositsEnabled: true,
  withdrawalsEnabled: true,
  holdDeposits: false,
  holdDepositsAbove: null,
  holdWithdrawals: true,
  holdWithdrawalsAbove: null,
  minDeposit: 1000,
  maxDeposit: 2_000_000,
  minWithdrawal: 1000,
  maxWithdrawal: 1_000_000,
  dailyDepositMax: null,
  weeklyDepositMax: null,
  monthlyDepositMax: null,
  dailyWithdrawalMax: null,
  weeklyWithdrawalMax: null,
  monthlyWithdrawalMax: null,
  maxOpenWithdrawals: 1,
  withdrawalAccountId: null,
  depositAccountId: null,
  withdrawalQueueMode: 'fifo_stop_on_fail',
};

export const WRITABLE = Object.keys(DEFAULTS) as Array<keyof WritableSettings>;
/** Text fields that accept `null`. */
export const NULLABLE_TEXT: ReadonlyArray<keyof WritableSettings> = ['withdrawalAccountId', 'depositAccountId'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TEXT_RULES: Record<string, RegExp> = { withdrawalAccountId: ID, depositAccountId: ID, withdrawalQueueMode: new RegExp(`^(${QUEUE_MODES.join('|')})$`) };
/** Amount fields that accept `null` (= no cap). */
export const NULLABLE_AMOUNTS: ReadonlyArray<keyof WritableSettings> = [
  'holdDepositsAbove', 'holdWithdrawalsAbove',
  'dailyDepositMax', 'weeklyDepositMax', 'monthlyDepositMax', 'dailyWithdrawalMax', 'weeklyWithdrawalMax', 'monthlyWithdrawalMax',
];

export async function getSettings(tenant: string): Promise<Settings> {
  const cfg = await getConfig();
  const row = await db.one<Row>('SELECT * FROM payment_settings WHERE tenant = $1', [tenant]);
  if (!row) return { ...DEFAULTS, currency: cfg.currency, updatedAt: null, updatedBy: null };
  return {
    depositsEnabled: row.deposits_enabled,
    withdrawalsEnabled: row.withdrawals_enabled,
    holdDeposits: row.hold_deposits,
    holdDepositsAbove: money(row.hold_deposits_above),
    holdWithdrawals: row.hold_withdrawals,
    holdWithdrawalsAbove: money(row.hold_withdrawals_above),
    minDeposit: money(row.min_deposit) ?? DEFAULTS.minDeposit,
    maxDeposit: money(row.max_deposit) ?? DEFAULTS.maxDeposit,
    minWithdrawal: money(row.min_withdrawal) ?? DEFAULTS.minWithdrawal,
    maxWithdrawal: money(row.max_withdrawal) ?? DEFAULTS.maxWithdrawal,
    dailyDepositMax: money(row.daily_deposit_max),
    weeklyDepositMax: money(row.weekly_deposit_max),
    monthlyDepositMax: money(row.monthly_deposit_max),
    dailyWithdrawalMax: money(row.daily_withdrawal_max),
    weeklyWithdrawalMax: money(row.weekly_withdrawal_max),
    monthlyWithdrawalMax: money(row.monthly_withdrawal_max),
    maxOpenWithdrawals: row.max_open_withdrawals,
    withdrawalAccountId: row.withdrawal_account_id,
    depositAccountId: row.deposit_account_id,
    withdrawalQueueMode: QUEUE_MODES.includes(row.withdrawal_queue_mode as never) ? row.withdrawal_queue_mode as Settings['withdrawalQueueMode'] : DEFAULTS.withdrawalQueueMode,
    currency: cfg.currency,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * Validate a partial body of amount/boolean/integer fields against `defaults`
 * (the field list and types) and return the merged result. Shared with the
 * per-player overrides, where every field may also be `null` ("use tenant").
 */
export function mergeFields<T extends Record<string, unknown>>(current: T, body: Record<string, unknown>, template: Record<string, unknown>, nullable: ReadonlyArray<string>, allNullable = false): T {
  const next: Record<string, unknown> = { ...current };
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!(key in template)) { errors.push(`'${key}' is not a setting`); continue; }
    const def = template[key];
    if (raw === null && (allNullable || nullable.includes(key))) { next[key] = null; continue; }
    if (typeof def === 'boolean') {
      if (typeof raw !== 'boolean') errors.push(`'${key}' must be a boolean`);
      else next[key] = raw;
    } else if (key === 'maxOpenWithdrawals') {
      if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > 50) errors.push(`'${key}' must be an integer between 1 and 50`);
      else next[key] = raw;
    } else if (key === 'note') {
      if (typeof raw !== 'string' || raw.length > 500) errors.push(`'${key}' must be a string of at most 500 characters`);
      else next[key] = raw;
    } else if (key in TEXT_RULES) {
      if (typeof raw !== 'string' || !TEXT_RULES[key].test(raw)) errors.push(key === 'withdrawalQueueMode' ? `'${key}' must be one of ${QUEUE_MODES.join(', ')}` : `'${key}' is not a valid identifier`);
      else next[key] = raw;
    } else {
      const n = typeof raw === 'number' ? raw : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1e12) errors.push(`'${key}' must be a non-negative amount`);
      else next[key] = Math.round(n * 100) / 100;
    }
  }
  const num = (k: string) => (typeof next[k] === 'number' ? (next[k] as number) : null);
  if (num('minDeposit') !== null && num('maxDeposit') !== null && num('minDeposit')! > num('maxDeposit')!) errors.push("'minDeposit' must not exceed 'maxDeposit'");
  if (num('minWithdrawal') !== null && num('maxWithdrawal') !== null && num('minWithdrawal')! > num('maxWithdrawal')!) errors.push("'minWithdrawal' must not exceed 'maxWithdrawal'");
  if (errors.length) throw new ValidationError('Validation failed', errors);
  return next as T;
}

export async function updateSettings(tenant: string, body: Record<string, unknown>, by: string): Promise<Settings> {
  const current = await getSettings(tenant);
  const next = mergeFields(current as unknown as Record<string, unknown>, body, DEFAULTS as unknown as Record<string, unknown>, [...NULLABLE_AMOUNTS, ...NULLABLE_TEXT] as string[]) as unknown as Settings;
  const opt = (v: number | null) => (v === null ? null : moneyParam(v));
  await db.execute(
    `INSERT INTO payment_settings (tenant, deposits_enabled, withdrawals_enabled, hold_deposits, hold_deposits_above,
       hold_withdrawals, hold_withdrawals_above, min_deposit, max_deposit, min_withdrawal, max_withdrawal,
       daily_deposit_max, weekly_deposit_max, monthly_deposit_max, daily_withdrawal_max, weekly_withdrawal_max, monthly_withdrawal_max,
       max_open_withdrawals, withdrawal_account_id, deposit_account_id, withdrawal_queue_mode, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$20,$21,$22, now(), $19)
     ON CONFLICT (tenant) DO UPDATE SET
       deposits_enabled = EXCLUDED.deposits_enabled, withdrawals_enabled = EXCLUDED.withdrawals_enabled,
       hold_deposits = EXCLUDED.hold_deposits, hold_deposits_above = EXCLUDED.hold_deposits_above,
       hold_withdrawals = EXCLUDED.hold_withdrawals, hold_withdrawals_above = EXCLUDED.hold_withdrawals_above,
       min_deposit = EXCLUDED.min_deposit, max_deposit = EXCLUDED.max_deposit,
       min_withdrawal = EXCLUDED.min_withdrawal, max_withdrawal = EXCLUDED.max_withdrawal,
       daily_deposit_max = EXCLUDED.daily_deposit_max, weekly_deposit_max = EXCLUDED.weekly_deposit_max, monthly_deposit_max = EXCLUDED.monthly_deposit_max,
       daily_withdrawal_max = EXCLUDED.daily_withdrawal_max, weekly_withdrawal_max = EXCLUDED.weekly_withdrawal_max, monthly_withdrawal_max = EXCLUDED.monthly_withdrawal_max,
       max_open_withdrawals = EXCLUDED.max_open_withdrawals, withdrawal_account_id = EXCLUDED.withdrawal_account_id,
       deposit_account_id = EXCLUDED.deposit_account_id, withdrawal_queue_mode = EXCLUDED.withdrawal_queue_mode,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tenant, next.depositsEnabled, next.withdrawalsEnabled, next.holdDeposits, opt(next.holdDepositsAbove),
      next.holdWithdrawals, opt(next.holdWithdrawalsAbove), moneyParam(next.minDeposit), moneyParam(next.maxDeposit),
      moneyParam(next.minWithdrawal), moneyParam(next.maxWithdrawal),
      opt(next.dailyDepositMax), opt(next.weeklyDepositMax), opt(next.monthlyDepositMax),
      opt(next.dailyWithdrawalMax), opt(next.weeklyWithdrawalMax), opt(next.monthlyWithdrawalMax),
      next.maxOpenWithdrawals, by, next.withdrawalAccountId, next.depositAccountId, next.withdrawalQueueMode],
  );
  return getSettings(tenant);
}

/** Does this amount wait for an operator, under these settings? */
export function needsHold(kind: 'deposit' | 'withdrawal', amount: number, s: Settings): boolean {
  const always = kind === 'deposit' ? s.holdDeposits : s.holdWithdrawals;
  const above = kind === 'deposit' ? s.holdDepositsAbove : s.holdWithdrawalsAbove;
  return always || (above !== null && amount >= above);
}
