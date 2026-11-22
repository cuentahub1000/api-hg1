/**
 * hg.cash — the first payment provider. Internal names only: nothing from this
 * module is ever shown to a player.
 *
 *   createCheckout / getCheckout / cancelCheckout   hosted checkout = deposit
 *   createPayout / getPayout                         transaction request = withdrawal (AR CBU/CVU)
 *   verifySignature                                  webhook HMAC-SHA256 (`X-HG-Webhook-Signature: sha256=<hex>`)
 *
 * Provider amounts: checkouts take a decimal *string*, transaction requests a
 * JSON number. `PROVIDER_MODE=mock` swaps every call for the local sandbox.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConfig, type ProviderConfig } from '../../_common/config';
import { NotConfiguredError, UpstreamError } from '../../_common/errors';
import { upstream } from '../../_common/http';
import { recordRequest } from '../provider-log';
import type { Checkout, CreateCheckoutInput, CreatePayoutInput, PaymentProvider, Payout } from './index';
import { sandboxCancelCheckout, sandboxCreateCheckout, sandboxCreatePayout, sandboxGetBalance, sandboxGetCheckout, sandboxGetPayout } from './sandbox';

async function cfg(): Promise<ProviderConfig> {
  const p = (await getConfig()).provider;
  if (!p) throw new NotConfiguredError('payments');
  return p;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, allow?: number[], paymentId?: string | null): Promise<{ status: number; data: T }> {
  const p = await cfg();
  const { upstreamTimeoutMs } = await getConfig();
  return upstream<T>('payment provider', {
    method, url: `${p.apiUrl}${path}`, body, timeoutMs: upstreamTimeoutMs, allow,
    headers: { authorization: `Bearer ${p.apiToken}` },
    // every exchange with the provider lands in provider_log (masked) for the back-office
    observe: (o) => recordRequest({ paymentId: paymentId ?? null, provider: 'hg', method, path, ...o }),
  });
}

export const hgProvider: PaymentProvider = {
  name: 'hg',

  async createCheckout(input) {
    const p = await cfg();
    if (p.mode === 'mock') return sandboxCreateCheckout({ amount: input.amount, successUrl: input.successUrl, cancelUrl: input.cancelUrl, country: input.country, payerDocument: input.payer?.document });
    const body: Record<string, unknown> = {
      country: input.country,
      amount: input.amount.toFixed(2),
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: input.paymentId,
      metadata: { paymentId: input.paymentId },
      expiresInSeconds: 86400,
      locale: input.locale === 'en' ? 'en' : 'es',
    };
    // The provider ties an account to a country and rejects checkouts for others,
    // so the account is sent only when the tenant chose one (depositAccountId).
    if (input.accountId) body.accountId = input.accountId;
    if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
    if (input.payer && (input.payer.document || input.payer.name || input.payer.email)) {
      body.payer = { document: input.payer.document, name: input.payer.name, email: input.payer.email };
    }
    const { data } = await call<Record<string, unknown>>('POST', '/checkouts', body, undefined, input.paymentId);
    return toCheckout(data);
  },

  async getCheckout(ref, paymentId) {
    if ((await cfg()).mode === 'mock') return sandboxGetCheckout(ref);
    const { status, data } = await call<Record<string, unknown>>('GET', `/checkouts/${encodeURIComponent(ref)}`, undefined, [404], paymentId);
    return status === 404 ? null : toCheckout(data);
  },

  async cancelCheckout(ref, paymentId) {
    if ((await cfg()).mode === 'mock') { await sandboxCancelCheckout(ref); return; }
    await call('POST', `/checkouts/${encodeURIComponent(ref)}/cancel`, undefined, [404, 409, 422], paymentId);
  },

  async createPayout(input) {
    const p = await cfg();
    if (p.mode === 'mock') return sandboxCreatePayout({ amount: input.amount, destination: `${input.destination.type}:${input.destination.value}` });
    const body: Record<string, unknown> = {
      accountId: input.accountId ?? p.accountId,
      amount: Number(input.amount.toFixed(2)),
      externalID: input.paymentId,
      concept: input.concept ?? 'Withdrawal',
      data: { paymentId: input.paymentId },
    };
    body[input.destination.type === 'cvu' ? 'toCVU' : 'toCBU'] = input.destination.value;
    if (input.destination.holderName) body.toName = input.destination.holderName;
    if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
    const { data } = await call<Record<string, unknown>>('POST', '/transactions', body, undefined, input.paymentId);
    return toPayout(data);
  },

  async getPayout(ref, paymentId) {
    if ((await cfg()).mode === 'mock') return sandboxGetPayout(ref);
    const { status, data } = await call<Record<string, unknown>>('GET', `/transaction/${encodeURIComponent(ref)}/status`, undefined, [404], paymentId);
    return status === 404 ? null : toPayout(data);
  },

  async getBalance(accountId) {
    const p = await cfg();
    if (p.mode === 'mock') return sandboxGetBalance();
    const id = accountId ?? p.accountId;
    const { data } = await call<Record<string, unknown>>('GET', `/account/${encodeURIComponent(id)}/balance`);
    // netBalance = balance minus pending fees: what a transfer request is checked against.
    const n = Number(data.netBalance ?? data.balance);
    if (!Number.isFinite(n)) throw new UpstreamError('payment provider', 502);
    return n;
  },

  mapCheckoutStatus(status) {
    switch (status.toLowerCase()) {
      case 'completed': return 'paid';
      case 'awaiting_manual_review': return 'under_review';
      case 'rejected': return 'rejected';
      case 'expired': return 'expired';
      case 'cancelled': return 'cancelled';
      case 'pending': return 'pending';
      default: return null;
    }
  },

  payoutFailure(err) {
    if (!(err instanceof UpstreamError)) return 'unknown';
    if (err.upstreamStatus === 409 && err.upstreamCode === 'DUPLICATE_EXTERNAL_ID') return 'duplicate';
    if (err.upstreamStatus >= 400 && err.upstreamStatus < 500 && /INSUFFICIENT|BALANCE/i.test(err.upstreamCode ?? '')) return 'insufficient';
    if (err.upstreamStatus >= 400 && err.upstreamStatus < 500) return 'refused';
    return 'unknown';
  },

  mapPayoutStatus(status) {
    switch (status.toUpperCase()) {
      case 'DONE': return 'done';
      case 'ERROR': return 'failed';
      case 'CANCELLED': return 'cancelled';
      default: return null; // PENDING, AWAITING_REVIEW, PROCESSING
    }
  },
};

/** `X-HG-Webhook-Signature: sha256=<hex>` over the raw body bytes. */
export function verifySignature(rawBody: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

function toCheckout(d: Record<string, unknown>): Checkout {
  return {
    id: String(d.id ?? ''),
    status: String(d.status ?? 'pending'),
    checkoutUrl: (d.checkoutUrl as string | undefined) ?? null,
    expiresAt: (d.expiresAt as string | undefined) ?? null,
    amount: d.amount === undefined ? null : Number(d.amount),
    transactionId: (d.transactionId as string | undefined) ?? null,
    raw: d,
  };
}

function toPayout(d: Record<string, unknown>): Payout {
  return {
    id: String(d.id ?? ''),
    status: String(d.status ?? 'PENDING').toUpperCase(),
    errorCode: (d.errorCode as string | undefined) ?? null,
    errorMessage: (d.errorMessage as string | undefined) ?? null,
    amount: d.amount === undefined ? null : Number(d.amount),
    raw: d,
  };
}
