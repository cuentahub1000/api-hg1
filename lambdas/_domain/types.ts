/**
 * Payment rows and the shapes callers see. Amounts are `numeric(18,2)` in
 * Postgres (strings on the wire from `pg`) and `number` here.
 *
 * The `payment` row is provider-agnostic; the provider's reference, status and
 * hosted page come from `payment_provider`, joined into `PaymentRow` as
 * `p_*` columns by `payments.ts`.
 */

export type PaymentKind = 'deposit' | 'withdrawal';

export type DepositStatus = 'pending' | 'under_review' | 'awaiting_approval' | 'completed' | 'rejected' | 'expired' | 'cancelled' | 'failed';
export type WithdrawalStatus = 'awaiting_approval' | 'queued' | 'processing' | 'completed' | 'rejected' | 'failed' | 'cancelled';
export type PaymentStatus = DepositStatus | WithdrawalStatus;

export const DEPOSIT_STATUSES: readonly DepositStatus[] = ['pending', 'under_review', 'awaiting_approval', 'completed', 'rejected', 'expired', 'cancelled', 'failed'];
export const WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = ['awaiting_approval', 'queued', 'processing', 'completed', 'rejected', 'failed', 'cancelled'];
export const ALL_STATUSES: readonly PaymentStatus[] = [...new Set<PaymentStatus>([...DEPOSIT_STATUSES, ...WITHDRAWAL_STATUSES])];
export const FINAL_STATUSES: readonly PaymentStatus[] = ['completed', 'rejected', 'expired', 'cancelled', 'failed'];
export const OPEN_STATUSES: readonly PaymentStatus[] = ALL_STATUSES.filter((s) => !FINAL_STATUSES.includes(s));
/** Statuses that count against a player's rolling caps: anything that is or may become money moved. */
export const COUNTED_STATUSES: readonly PaymentStatus[] = ['pending', 'under_review', 'awaiting_approval', 'queued', 'processing', 'completed'];

export function isFinal(status: PaymentStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export type DestinationType = 'cbu' | 'cvu';

export interface Destination {
  type: DestinationType;
  value: string;
  holderName?: string | null;
}

/** What the provider needs about the payer. `document` is sent on, never stored (see `document_hash`). */
export interface Payer {
  document?: string;
  name?: string;
  email?: string;
}

export interface ClientInfo { ip?: string; userAgent?: string }

/** A `payment` row joined with its `payment_provider` row (`p_*`). */
export interface PaymentRow {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  tenant: string;
  party_id: string;
  username: string | null;
  chain: string;
  account_id: string;
  currency: string;
  amount: string;
  fee: string | null;
  hold: boolean;
  provider: string;
  wallet_operation_id: string | null;
  wallet_status: string | null;
  destination: Destination | null;
  payer: Omit<Payer, 'document'> | null;
  document_hash: string | null;
  client: ClientInfo | null;
  note: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  error_code: string | null;
  /** Place in the withdrawal queue (lower first); null outside the queue. bigint, so a string from pg. */
  priority: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  version: number;
  // from payment_provider (null when the provider has not been involved yet)
  p_ref: string | null;
  p_status: string | null;
  p_checkout_url: string | null;
  p_expires_at: string | null;
  p_data: unknown;
}

/** `SELECT` list that produces a `PaymentRow`. */
export const PAYMENT_SELECT = `
  p.*, pp.ref AS p_ref, pp.status AS p_status, pp.checkout_url AS p_checkout_url, pp.expires_at AS p_expires_at, pp.data AS p_data
  FROM payment p LEFT JOIN payment_provider pp ON pp.payment_id = p.id`;

export interface PaymentEventRow {
  id: string;
  payment_id: string;
  at: string;
  actor: string;
  actor_name: string | null;
  type: string;
  data: unknown;
}

/** What a player sees. */
export interface PaymentView {
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount: number;
  currency: string;
  fee: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  hold: boolean;
  checkoutUrl: string | null;
  expiresAt: string | null;
  destination: Destination | null;
  note: string | null;
}

/** What an operator sees: the player view plus the internals. */
export interface PaymentAdminView extends PaymentView {
  partyId: string;
  username: string | null;
  chain: string;
  accountId: string;
  provider: string;
  walletOperationId: string | null;
  walletStatus: string | null;
  providerRef: string | null;
  providerStatus: string | null;
  providerData: unknown;
  payer: Omit<Payer, 'document'> | null;
  /** Keyed hash of the national id the player gave; compare, never reverse. */
  documentHash: string | null;
  client: ClientInfo | null;
  decidedBy: string | null;
  /** The operator's display name / username at decision time. */
  decidedByName: string | null;
  decidedAt: string | null;
  errorCode: string | null;
  /** Withdrawals: place in the queue, lower first. */
  priority: number | null;
}

export function money(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** `numeric` literal for a parameter: fixed two decimals, no float noise. */
export function moneyParam(n: number): string {
  return n.toFixed(2);
}

export function maskDestination(d: Destination | null): Destination | null {
  if (!d) return null;
  return { type: d.type, value: `•••• ${d.value.slice(-4)}`, holderName: d.holderName ?? null };
}

export function playerView(r: PaymentRow): PaymentView {
  return {
    id: r.id,
    kind: r.kind,
    // A queued withdrawal is "in process" to the player; the queue is an operator concern.
    status: r.status === 'queued' ? 'processing' : r.status,
    amount: money(r.amount) ?? 0,
    currency: r.currency,
    fee: money(r.fee),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    hold: r.hold,
    checkoutUrl: r.kind === 'deposit' && r.status === 'pending' ? r.p_checkout_url : null,
    expiresAt: r.kind === 'deposit' ? r.p_expires_at : null,
    destination: maskDestination(r.destination),
    // Only a rejection reason is for the player; internal notes stay inside.
    note: r.status === 'rejected' ? r.note : null,
  };
}

export function adminView(r: PaymentRow): PaymentAdminView {
  return {
    ...playerView(r),
    status: r.status,
    checkoutUrl: r.p_checkout_url,
    expiresAt: r.p_expires_at,
    destination: r.destination,
    note: r.note,
    partyId: r.party_id,
    username: r.username,
    chain: r.chain,
    accountId: r.account_id,
    provider: r.provider,
    walletOperationId: r.wallet_operation_id,
    walletStatus: r.wallet_status,
    providerRef: r.p_ref,
    providerStatus: r.p_status,
    providerData: r.p_data ?? null,
    payer: r.payer,
    documentHash: r.document_hash,
    client: r.client,
    decidedBy: r.decided_by,
    decidedByName: r.decided_by_name,
    decidedAt: r.decided_at,
    errorCode: r.error_code,
    priority: r.priority === null ? null : Number(r.priority),
  };
}

/** Caps that apply to one kind of movement. `null` = no cap. */
export interface KindLimits {
  min: number;
  max: number;
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
}

/**
 * `fifo_stop_on_fail`: in queue order, stop at the first that does not fit.
 * `fit`: in queue order, pay every one that fits, skip the rest.
 */
export type WithdrawalQueueMode = 'fifo_stop_on_fail' | 'fit';
export const QUEUE_MODES: readonly WithdrawalQueueMode[] = ['fifo_stop_on_fail', 'fit'];

export interface Settings {
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  holdDeposits: boolean;
  holdDepositsAbove: number | null;
  holdWithdrawals: boolean;
  holdWithdrawalsAbove: number | null;
  minDeposit: number;
  maxDeposit: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  dailyDepositMax: number | null;
  weeklyDepositMax: number | null;
  monthlyDepositMax: number | null;
  dailyWithdrawalMax: number | null;
  weeklyWithdrawalMax: number | null;
  monthlyWithdrawalMax: number | null;
  maxOpenWithdrawals: number;
  /** Provider account the bank transfers are paid from; null = the deployment's account. */
  withdrawalAccountId: string | null;
  /** Provider account deposits are opened on; null = not sent (the provider picks by country). */
  depositAccountId: string | null;
  /** How the queue run pays queued withdrawals from the account's balance. */
  withdrawalQueueMode: WithdrawalQueueMode;
  currency: string;
  updatedAt: string | null;
  updatedBy: string | null;
}
