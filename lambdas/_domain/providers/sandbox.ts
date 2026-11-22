/**
 * The in-process payment provider for local work (`PROVIDER_MODE=mock`).
 *
 * Keeps fake checkouts and payouts in two sandbox tables and serves a fake hosted payment
 * page at `<PROVIDER_SANDBOX_URL>/sandbox/checkout/<id>` with buttons that do
 * what the real provider's webhook would do: paid, receipt uploaded (manual
 * review), rejected, expired. Payouts complete on their own a few seconds
 * after submission (`SANDBOX_PAYOUT_SECONDS`, default 15) unless the sandbox
 * page is used to fail them. Served by `local/server.cts` and `server/index.ts`.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../../_common/db';
import { log } from '../../_common/logger';
import type { Checkout, Payout } from './index';

interface CheckoutRow { id: string; status: string; amount: string; country: string; payer_document: string | null; success_url: string; cancel_url: string; transaction_id: string | null; expires_at: string }
interface PayoutRow { id: string; status: string; amount: string; destination: string; error_code: string | null; submitted_at: string }

function checkoutUrl(id: string): string {
  return `${process.env.PROVIDER_SANDBOX_URL ?? 'http://127.0.0.1:9500'}/sandbox/checkout/${id}`;
}

function toCheckout(r: CheckoutRow): Checkout {
  return { id: r.id, status: r.status, checkoutUrl: checkoutUrl(r.id), expiresAt: r.expires_at, amount: Number(r.amount), transactionId: r.transaction_id };
}

function toPayout(r: PayoutRow): Payout {
  return { id: r.id, status: r.status, errorCode: r.error_code, errorMessage: null, amount: Number(r.amount) };
}

export async function sandboxCreateCheckout(input: { amount: number; successUrl: string; cancelUrl: string; country: string; payerDocument?: string }): Promise<Checkout> {
  const id = randomUUID();
  const row = await db.one<CheckoutRow>(
    `INSERT INTO sandbox_checkout (id, status, amount, country, payer_document, success_url, cancel_url, expires_at)
     VALUES ($1, 'pending', $2, $3, $4, $5, $6, now() + interval '1 day') RETURNING *`,
    [id, input.amount.toFixed(2), input.country, input.payerDocument ?? null, input.successUrl, input.cancelUrl],
  );
  log.info('sandbox checkout created', { id, amount: input.amount });
  return toCheckout(row!);
}

async function checkoutRow(id: string): Promise<CheckoutRow | null> {
  const row = await db.one<CheckoutRow>('SELECT * FROM sandbox_checkout WHERE id = $1', [id]);
  if (row && row.status === 'pending' && Date.parse(row.expires_at) < Date.now()) {
    row.status = 'expired';
    await db.execute(`UPDATE sandbox_checkout SET status = 'expired' WHERE id = $1`, [id]);
  }
  return row;
}

export async function sandboxGetCheckout(id: string): Promise<Checkout | null> {
  const row = await checkoutRow(id);
  return row ? toCheckout(row) : null;
}

export async function sandboxCancelCheckout(id: string): Promise<void> {
  await db.execute(`UPDATE sandbox_checkout SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [id]);
}

export async function sandboxCreatePayout(input: { amount: number; destination: string }): Promise<Payout> {
  const id = randomUUID();
  const row = await db.one<PayoutRow>(
    `INSERT INTO sandbox_payout (id, status, amount, destination) VALUES ($1, 'PROCESSING', $2, $3) RETURNING *`,
    [id, input.amount.toFixed(2), input.destination],
  );
  log.info('sandbox payout submitted', { id, amount: input.amount });
  return toPayout(row!);
}

/** The sandbox account's balance: `SANDBOX_PROVIDER_BALANCE` (default 1 000 000 000, i.e. never short). */
export async function sandboxGetBalance(): Promise<number> {
  const n = Number(process.env.SANDBOX_PROVIDER_BALANCE ?? '');
  return Number.isFinite(n) && process.env.SANDBOX_PROVIDER_BALANCE ? n : 1_000_000_000;
}

/** A payout completes on its own `SANDBOX_PAYOUT_SECONDS` (default 15) after submission. */
export async function sandboxGetPayout(id: string): Promise<Payout | null> {
  const seconds = Number(process.env.SANDBOX_PAYOUT_SECONDS ?? '15') || 15;
  await db.execute(`UPDATE sandbox_payout SET status = 'DONE' WHERE id = $1 AND status = 'PROCESSING' AND submitted_at < now() - ($2::text || ' seconds')::interval`, [id, String(seconds)]);
  const row = await db.one<PayoutRow>('SELECT * FROM sandbox_payout WHERE id = $1', [id]);
  return row ? toPayout(row) : null;
}

// ---- the fake hosted page ---------------------------------------------------------

export interface SandboxResponse { status: number; contentType: string; body: string; location?: string }

const PAGE = /^\/sandbox\/checkout\/([0-9a-f-]{36})$/;
const ACTION = /^\/sandbox\/checkout\/([0-9a-f-]{36})\/(pay|review|reject|expire|cancel)$/;
const PAYOUT_ACTION = /^\/sandbox\/payout\/([0-9a-f-]{36})\/(done|error)$/;

/** Routes `/sandbox/...`; returns null when the path is not a sandbox path. */
export async function handleSandbox(method: string, pathname: string): Promise<SandboxResponse | null> {
  // Explicit opt-in on top of PROVIDER_MODE=mock: the deployment never sets it.
  if (process.env.SANDBOX_ENABLED !== '1') return null;
  const page = pathname.match(PAGE);
  if (page && method === 'GET') return await renderPage(page[1]);

  const act = pathname.match(ACTION);
  if (act && method === 'POST') {
    const co = await checkoutRow(act[1]);
    if (!co) return { status: 404, contentType: 'text/plain', body: 'unknown checkout' };
    const { applyCheckout } = await import('../payments');
    const next = ({ pay: 'completed', review: 'awaiting_manual_review', reject: 'rejected', expire: 'expired', cancel: 'cancelled' } as Record<string, string>)[act[2]];
    if (co.status === 'pending' || (co.status === 'awaiting_manual_review' && (next === 'completed' || next === 'rejected'))) {
      const txId = next === 'completed' ? randomUUID() : co.transaction_id;
      await db.execute('UPDATE sandbox_checkout SET status = $2, transaction_id = $3 WHERE id = $1', [co.id, next, txId]);
      // What the provider's webhook would do.
      await applyCheckout(co.id, next, 'provider', { sandbox: true, transactionId: txId });
    }
    const back = next === 'completed' ? co.success_url : next === 'cancelled' ? co.cancel_url : `/sandbox/checkout/${co.id}`;
    return { status: 303, contentType: 'text/plain', body: '', location: back };
  }

  const pa = pathname.match(PAYOUT_ACTION);
  if (pa && method === 'POST') {
    const po = await db.one<PayoutRow>('SELECT * FROM sandbox_payout WHERE id = $1', [pa[1]]);
    if (!po) return { status: 404, contentType: 'text/plain', body: 'unknown payout' };
    const { applyPayout } = await import('../payments');
    if (po.status === 'PROCESSING') {
      const status = pa[2] === 'done' ? 'DONE' : 'ERROR';
      const errorCode = status === 'ERROR' ? 'DESTINATION_ERROR' : null;
      await db.execute('UPDATE sandbox_payout SET status = $2, error_code = $3 WHERE id = $1', [po.id, status, errorCode]);
      await applyPayout(po.id, status, 'provider', { errorCode });
    }
    return { status: 200, contentType: 'application/json', body: JSON.stringify(await sandboxGetPayout(po.id)) };
  }

  if (pathname === '/sandbox' && method === 'GET') {
    const cos = await db.query<CheckoutRow>('SELECT * FROM sandbox_checkout ORDER BY created_at DESC LIMIT 50');
    const pos = await db.query<PayoutRow>('SELECT * FROM sandbox_payout ORDER BY submitted_at DESC LIMIT 50');
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ checkouts: cos.map(toCheckout), payouts: pos.map(toPayout) }) };
  }
  return null;
}

async function renderPage(id: string): Promise<SandboxResponse> {
  const row = await checkoutRow(id);
  if (!row) return { status: 404, contentType: 'text/html', body: '<h1>Unknown payment</h1>' };
  const co = { ...toCheckout(row), successUrl: row.success_url, payerDocument: row.payer_document ?? undefined };
  const amount = (co.amount ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
  const button = (action: string, label: string, kind = '') => `<form method="post" action="/sandbox/checkout/${co.id}/${action}"><button class="${kind}">${label}</button></form>`;
  const actions = co.status === 'pending'
    ? button('pay', 'I transferred the money (completes)', 'primary') + button('review', 'I already paid, upload receipt (manual review)') + button('reject', 'Reject') + button('expire', 'Let it expire') + button('cancel', 'Cancel')
    : co.status === 'awaiting_manual_review' ? button('pay', 'Merchant approves the receipt', 'primary') + button('reject', 'Merchant rejects the receipt')
      : `<p>This payment is <b>${co.status}</b>.</p>`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Sandbox payment page</title>
<style>body{font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px;color:#222}.card{border:1px solid #ddd;border-radius:12px;padding:20px}dl{display:grid;grid-template-columns:1fr 2fr;gap:6px 12px}dt{color:#666}button{margin:6px 0;padding:10px 14px;border-radius:8px;border:1px solid #999;background:#f6f6f6;cursor:pointer;width:100%}button.primary{background:#1a7f37;color:#fff;border-color:#1a7f37}.tag{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee;font-size:12px}</style></head>
<body><h2>Sandbox payment page <span class="tag">${co.status}</span></h2>
<div class="card"><p>This stands in for the provider's hosted checkout. Nothing here is real.</p>
<dl><dt>Amount</dt><dd><b>${amount} ARS</b></dd><dt>Transfer to</dt><dd>alias <code>sandbox.pagos</code><br>CVU <code>0000003100000000000001</code><br>Sandbox Holder S.A.</dd><dt>Payer DNI</dt><dd>${co.payerDocument ?? 'enter on this page in the real flow'}</dd><dt>Checkout id</dt><dd><code>${co.id}</code></dd></dl>
${actions}
<p><a href="${co.successUrl}">Back to the site</a></p></div></body></html>`;
  return { status: 200, contentType: 'text/html; charset=utf-8', body };
}
