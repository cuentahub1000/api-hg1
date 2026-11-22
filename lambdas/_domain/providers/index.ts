/**
 * The payment provider behind deposits and withdrawals, behind one interface
 * so another integration can be added next to hg.cash without touching the
 * payment lifecycle. `PAYMENT_PROVIDER` picks the implementation; today `hg`
 * (which also hosts the `PROVIDER_MODE=mock` sandbox).
 *
 * Everything provider-specific — references, statuses, hosted page URLs, raw
 * payloads — lives in `payment_provider`, never on the `payment` row.
 */

import { NotConfiguredError } from '../../_common/errors';
import type { Destination, Payer } from '../types';

export type CheckoutStatus = 'pending' | 'awaiting_manual_review' | 'completed' | 'rejected' | 'cancelled' | 'expired';
export type PayoutStatus = 'PENDING' | 'AWAITING_REVIEW' | 'PROCESSING' | 'DONE' | 'ERROR' | 'CANCELLED';

/** A hosted-checkout deposit at the provider, in the provider's own terms. */
export interface Checkout {
  id: string;
  status: CheckoutStatus | string;
  checkoutUrl: string | null;
  expiresAt: string | null;
  amount: number | null;
  transactionId: string | null;
  /** The rest of the provider's response, kept verbatim for operators. */
  raw?: unknown;
}

/** A bank transfer out at the provider, in the provider's own terms. */
export interface Payout {
  id: string;
  status: PayoutStatus | string;
  errorCode: string | null;
  errorMessage: string | null;
  amount: number | null;
  raw?: unknown;
}

export interface CreateCheckoutInput { paymentId: string; amount: number; payer?: Payer; locale?: string; country: string; successUrl: string; cancelUrl: string; /** provider account to open the checkout on; null = let the provider pick */ accountId?: string | null }
export interface CreatePayoutInput { paymentId: string; amount: number; destination: Destination; concept?: string; /** provider account to pay from; default = the deployment's */ accountId?: string | null }

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CreateCheckoutInput): Promise<Checkout>;
  /** `paymentId` is only for the exchange log (`provider_log`). */
  getCheckout(ref: string, paymentId?: string): Promise<Checkout | null>;
  cancelCheckout(ref: string, paymentId?: string): Promise<void>;
  createPayout(input: CreatePayoutInput): Promise<Payout>;
  getPayout(ref: string, paymentId?: string): Promise<Payout | null>;
  /** Balance usable for payouts on a provider account (null = the deployment's). */
  getBalance(accountId: string | null): Promise<number>;
  /** Our status for one of the provider's checkout statuses; null = no change. */
  mapCheckoutStatus(status: string): 'paid' | 'under_review' | 'rejected' | 'expired' | 'cancelled' | 'pending' | null;
  /** Our outcome for one of the provider's payout statuses; null = still on its way. */
  mapPayoutStatus(status: string): 'done' | 'failed' | 'cancelled' | null;
  /**
   * What a failed `createPayout` means: `refused` = the provider said no and holds
   * nothing (safe to release the money); `insufficient` = refused because the
   * provider account lacks the funds (nothing exists; worth repeating once the
   * account is funded); `duplicate` = it already holds this transfer from an
   * earlier attempt (same payment id); `unknown` = no usable answer (timeout,
   * 5xx), the transfer may or may not exist.
   */
  payoutFailure(err: unknown): 'refused' | 'insufficient' | 'duplicate' | 'unknown';
}

let selected: PaymentProvider | undefined;

export async function provider(): Promise<PaymentProvider> {
  if (selected) return selected;
  const name = (process.env.PAYMENT_PROVIDER ?? 'hg').toLowerCase();
  if (name === 'hg') {
    const { hgProvider } = await import('./hg');
    selected = hgProvider;
    return selected;
  }
  throw new NotConfiguredError('payments');
}

/** Test seam. */
export function resetProvider(): void {
  selected = undefined;
}
