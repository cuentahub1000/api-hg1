/**
 * Per-player rules an operator sets: limit overrides (per request and rolling
 * daily / weekly / monthly totals) and blocks (deposits, withdrawals or both;
 * permanent or until a date). Players never see the numbers: a cap that is hit
 * is a generic `LIMIT_EXCEEDED`, a block is `BLOCKED` ("contact support").
 *
 * Windows are rolling (last 24 h / 7 d / 30 d) over every payment of the kind
 * that is or may become money moved (`COUNTED_STATUSES`).
 */

import { db } from '../_common/db';
import { BlockedError, LimitError } from '../_common/errors';
import { log } from '../_common/logger';
import { rootOf } from '../_common/chain';
import type { SecurityContext } from '../_common/auth';
import { getSettings, mergeFields } from './settings';
import { COUNTED_STATUSES, money, moneyParam, type KindLimits, type PaymentKind, type Settings } from './types';

// ---- limits --------------------------------------------------------------------

export interface PlayerLimits {
  minDeposit: number | null;
  maxDeposit: number | null;
  minWithdrawal: number | null;
  maxWithdrawal: number | null;
  dailyDepositMax: number | null;
  weeklyDepositMax: number | null;
  monthlyDepositMax: number | null;
  dailyWithdrawalMax: number | null;
  weeklyWithdrawalMax: number | null;
  monthlyWithdrawalMax: number | null;
  maxOpenWithdrawals: number | null;
  note: string | null;
}

const EMPTY: PlayerLimits = {
  minDeposit: null, maxDeposit: null, minWithdrawal: null, maxWithdrawal: null,
  dailyDepositMax: null, weeklyDepositMax: null, monthlyDepositMax: null,
  dailyWithdrawalMax: null, weeklyWithdrawalMax: null, monthlyWithdrawalMax: null,
  maxOpenWithdrawals: null, note: null,
};

/** Field template for validation: the type of each writable field. */
const TEMPLATE: Record<string, unknown> = {
  minDeposit: 0, maxDeposit: 0, minWithdrawal: 0, maxWithdrawal: 0,
  dailyDepositMax: 0, weeklyDepositMax: 0, monthlyDepositMax: 0,
  dailyWithdrawalMax: 0, weeklyWithdrawalMax: 0, monthlyWithdrawalMax: 0,
  maxOpenWithdrawals: 1, note: '',
};

interface LimitsRow {
  party_id: string; tenant: string;
  min_deposit: string | null; max_deposit: string | null; min_withdrawal: string | null; max_withdrawal: string | null;
  daily_deposit_max: string | null; weekly_deposit_max: string | null; monthly_deposit_max: string | null;
  daily_withdrawal_max: string | null; weekly_withdrawal_max: string | null; monthly_withdrawal_max: string | null;
  max_open_withdrawals: number | null; note: string | null; updated_at: string; updated_by: string | null;
}

export interface PlayerLimitsView extends PlayerLimits { partyId: string; updatedAt: string | null; updatedBy: string | null }

export async function getPlayerLimits(tenant: string, partyId: string): Promise<PlayerLimitsView> {
  const r = await db.one<LimitsRow>('SELECT * FROM player_limits WHERE tenant = $1 AND party_id = $2', [tenant, partyId]);
  if (!r) return { ...EMPTY, partyId, updatedAt: null, updatedBy: null };
  return {
    partyId,
    minDeposit: money(r.min_deposit), maxDeposit: money(r.max_deposit), minWithdrawal: money(r.min_withdrawal), maxWithdrawal: money(r.max_withdrawal),
    dailyDepositMax: money(r.daily_deposit_max), weeklyDepositMax: money(r.weekly_deposit_max), monthlyDepositMax: money(r.monthly_deposit_max),
    dailyWithdrawalMax: money(r.daily_withdrawal_max), weeklyWithdrawalMax: money(r.weekly_withdrawal_max), monthlyWithdrawalMax: money(r.monthly_withdrawal_max),
    maxOpenWithdrawals: r.max_open_withdrawals, note: r.note, updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

/** Any subset of the fields; `null` clears an override back to the tenant value. */
export async function updatePlayerLimits(partyId: string, tenant: string, body: Record<string, unknown>, by: string): Promise<PlayerLimitsView> {
  const current = await getPlayerLimits(tenant, partyId);
  const next = mergeFields(current as unknown as Record<string, unknown>, body, TEMPLATE, [], true) as unknown as PlayerLimits;
  const opt = (v: number | null) => (v === null ? null : moneyParam(v));
  await db.execute(
    `INSERT INTO player_limits (party_id, tenant, min_deposit, max_deposit, min_withdrawal, max_withdrawal,
       daily_deposit_max, weekly_deposit_max, monthly_deposit_max, daily_withdrawal_max, weekly_withdrawal_max, monthly_withdrawal_max,
       max_open_withdrawals, note, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), $15)
     ON CONFLICT (tenant, party_id) DO UPDATE SET
       min_deposit = EXCLUDED.min_deposit, max_deposit = EXCLUDED.max_deposit, min_withdrawal = EXCLUDED.min_withdrawal, max_withdrawal = EXCLUDED.max_withdrawal,
       daily_deposit_max = EXCLUDED.daily_deposit_max, weekly_deposit_max = EXCLUDED.weekly_deposit_max, monthly_deposit_max = EXCLUDED.monthly_deposit_max,
       daily_withdrawal_max = EXCLUDED.daily_withdrawal_max, weekly_withdrawal_max = EXCLUDED.weekly_withdrawal_max, monthly_withdrawal_max = EXCLUDED.monthly_withdrawal_max,
       max_open_withdrawals = EXCLUDED.max_open_withdrawals, note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [partyId, tenant, opt(next.minDeposit), opt(next.maxDeposit), opt(next.minWithdrawal), opt(next.maxWithdrawal),
      opt(next.dailyDepositMax), opt(next.weeklyDepositMax), opt(next.monthlyDepositMax),
      opt(next.dailyWithdrawalMax), opt(next.weeklyWithdrawalMax), opt(next.monthlyWithdrawalMax),
      next.maxOpenWithdrawals, next.note, by],
  );
  return getPlayerLimits(tenant, partyId);
}

/** The limits that apply to this player for this kind: override, else tenant. */
export function effectiveLimits(kind: PaymentKind, s: Settings, p: PlayerLimits): KindLimits & { maxOpenWithdrawals: number } {
  const d = kind === 'deposit';
  return {
    min: (d ? p.minDeposit : p.minWithdrawal) ?? (d ? s.minDeposit : s.minWithdrawal),
    max: (d ? p.maxDeposit : p.maxWithdrawal) ?? (d ? s.maxDeposit : s.maxWithdrawal),
    daily: (d ? p.dailyDepositMax : p.dailyWithdrawalMax) ?? (d ? s.dailyDepositMax : s.dailyWithdrawalMax),
    weekly: (d ? p.weeklyDepositMax : p.weeklyWithdrawalMax) ?? (d ? s.weeklyDepositMax : s.weeklyWithdrawalMax),
    monthly: (d ? p.monthlyDepositMax : p.monthlyWithdrawalMax) ?? (d ? s.monthlyDepositMax : s.monthlyWithdrawalMax),
    maxOpenWithdrawals: p.maxOpenWithdrawals ?? s.maxOpenWithdrawals,
  };
}

export interface Usage { day: number; week: number; month: number }

/** Amount of this kind the player moved (or is moving) in the last 24 h / 7 d / 30 d. */
export async function usage(tenant: string, partyId: string, kind: PaymentKind): Promise<Usage> {
  const r = await db.one<{ day: string; week: string; month: string }>(
    `SELECT coalesce(sum(amount) FILTER (WHERE created_at >= now() - interval '1 day'), 0)::text AS day,
            coalesce(sum(amount) FILTER (WHERE created_at >= now() - interval '7 days'), 0)::text AS week,
            coalesce(sum(amount) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::text AS month
       FROM payment WHERE tenant = $1 AND party_id = $2 AND kind = $3 AND status = ANY($4) AND created_at >= now() - interval '30 days'`,
    [tenant, partyId, kind, COUNTED_STATUSES],
  );
  return { day: Number(r?.day ?? 0), week: Number(r?.week ?? 0), month: Number(r?.month ?? 0) };
}

/**
 * Refuse an amount outside the player's effective limits. The message is the
 * same whichever rule fired: the player is not told which cap exists.
 */
export async function checkLimits(ctx: SecurityContext, kind: PaymentKind, amount: number, s: Settings): Promise<ReturnType<typeof effectiveLimits>> {
  const tenant = rootOf(ctx.fullChain);
  const lim = effectiveLimits(kind, s, await getPlayerLimits(tenant, ctx.partyId));
  const refuse = (rule: string) => {
    log.info('limit refused', { party: ctx.partyId, kind, amount, rule });
    return new LimitError('This amount is not available right now');
  };
  if (amount < lim.min) throw refuse('min');
  if (amount > lim.max) throw refuse('max');
  if (lim.daily !== null || lim.weekly !== null || lim.monthly !== null) {
    const u = await usage(tenant, ctx.partyId, kind);
    if (lim.daily !== null && u.day + amount > lim.daily) throw refuse('daily');
    if (lim.weekly !== null && u.week + amount > lim.weekly) throw refuse('weekly');
    if (lim.monthly !== null && u.month + amount > lim.monthly) throw refuse('monthly');
  }
  return lim;
}

// ---- blocks ----------------------------------------------------------------------

export type BlockKind = 'deposit' | 'withdrawal' | 'all';

export interface PlayerBlock {
  id: number;
  partyId: string;
  kind: BlockKind;
  /** null = permanent */
  until: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  active: boolean;
}

interface BlockRow { id: string; party_id: string; kind: BlockKind; until: string | null; reason: string; created_by: string; created_at: string; lifted_at: string | null; lifted_by: string | null }

function toBlock(r: BlockRow): PlayerBlock {
  const active = r.lifted_at === null && (r.until === null || Date.parse(r.until) > Date.now());
  return { id: Number(r.id), partyId: r.party_id, kind: r.kind, until: r.until, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, liftedAt: r.lifted_at, liftedBy: r.lifted_by, active };
}

export async function listBlocks(tenant: string, partyId: string): Promise<PlayerBlock[]> {
  const rows = await db.query<BlockRow>('SELECT * FROM player_block WHERE tenant = $1 AND party_id = $2 ORDER BY created_at DESC LIMIT 100', [tenant, partyId]);
  return rows.map(toBlock);
}

export async function activeBlock(tenant: string, partyId: string, kind: PaymentKind): Promise<PlayerBlock | null> {
  const row = await db.one<BlockRow>(
    `SELECT * FROM player_block WHERE tenant = $1 AND party_id = $2 AND lifted_at IS NULL AND kind IN ($3, 'all') AND (until IS NULL OR until > now())
      ORDER BY until IS NULL DESC, until DESC LIMIT 1`,
    [tenant, partyId, kind],
  );
  return row ? toBlock(row) : null;
}

/** Refuse when the player is blocked for this kind. The player learns only that support must be contacted. */
export async function checkBlock(ctx: SecurityContext, kind: PaymentKind): Promise<void> {
  const b = await activeBlock(rootOf(ctx.fullChain), ctx.partyId, kind);
  if (b) throw new BlockedError(kind);
}

export async function addBlock(partyId: string, tenant: string, kind: BlockKind, until: string | null, reason: string, by: string): Promise<PlayerBlock> {
  const row = await db.one<BlockRow>(
    'INSERT INTO player_block (party_id, tenant, kind, until, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [partyId, tenant, kind, until, reason, by],
  );
  return toBlock(row!);
}

export async function liftBlock(tenant: string, partyId: string, id: number, by: string): Promise<PlayerBlock | null> {
  const row = await db.one<BlockRow>(
    'UPDATE player_block SET lifted_at = now(), lifted_by = $4 WHERE id = $1 AND tenant = $2 AND party_id = $3 AND lifted_at IS NULL RETURNING *',
    [id, tenant, partyId, by],
  );
  return row ? toBlock(row) : null;
}

/** Everything an operator sees about one player: limits, usage, blocks. */
export async function playerOverview(partyId: string, tenant: string) {
  const [limits, blocks, deposits, withdrawals, settings] = await Promise.all([
    getPlayerLimits(tenant, partyId), listBlocks(tenant, partyId), usage(tenant, partyId, 'deposit'), usage(tenant, partyId, 'withdrawal'), getSettings(tenant),
  ]);
  return {
    partyId,
    limits,
    effective: { deposit: effectiveLimits('deposit', settings, limits), withdrawal: effectiveLimits('withdrawal', settings, limits) },
    usage: { deposit: deposits, withdrawal: withdrawals },
    blocks,
    blocked: { deposit: blocks.some((b) => b.active && b.kind !== 'withdrawal'), withdrawal: blocks.some((b) => b.active && b.kind !== 'deposit') },
  };
}
