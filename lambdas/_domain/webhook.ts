/**
 * Provider webhook intake. Verifies the HMAC over the raw body, records the
 * delivery in `webhook_inbox` (the dedupe key is the body hash, so a retry of
 * the same delivery is answered 200 without side effects) and dispatches:
 *
 *   topic CHECKOUT             -> applyCheckout(id, status)
 *   topic TRANSACTION_REQUEST  -> applyPayout(id, status)       (withdrawals)
 *   anything else              -> recorded, ignored
 */

import { createHash } from 'node:crypto';
import { db } from '../_common/db';
import { getConfig } from '../_common/config';
import { AuthError, NotConfiguredError, PaymentsError, ValidationError } from '../_common/errors';
import { maskBody } from '../_common/http';
import { log } from '../_common/logger';
import { adoptPayoutRef, applyCheckout, applyPayout } from './payments';
import { paymentIdForRef, recordWebhook } from './provider-log';
import { verifySignature } from './providers/hg';

export interface WebhookResult { accepted: boolean; duplicate: boolean; handled: string }

/** What `provider_log` keeps about one delivery, filled in as `process` goes. */
interface Trace { paymentId: string | null; request: unknown; response: unknown; status: number; error?: string }

/** Every delivery, accepted or refused, ends up as one `provider_log` row. */
export async function receive(rawBody: string, signatureHeader: string | undefined): Promise<WebhookResult> {
  const started = Date.now();
  const trace: Trace = { paymentId: null, request: maskBody(rawBody.slice(0, 2000)), response: null, status: 200 };
  try {
    const result = await process(rawBody, signatureHeader, trace);
    trace.response = result;
    return result;
  } catch (err) {
    trace.status = err instanceof PaymentsError ? err.httpErrorStatus : 500;
    trace.error = err instanceof PaymentsError ? err.message : String(err).slice(0, 200);
    throw err;
  } finally {
    await recordWebhook({ provider: 'hg', paymentId: trace.paymentId, status: trace.status, ms: Date.now() - started, request: trace.request, response: trace.response, error: trace.error });
  }
}

async function process(rawBody: string, signatureHeader: string | undefined, trace: Trace): Promise<WebhookResult> {
  const cfg = await getConfig();
  if (!cfg.provider) throw new NotConfiguredError('payments');
  const ok = verifySignature(rawBody, signatureHeader, cfg.provider.webhookSecret);
  const dedupe = createHash('sha256').update(rawBody).digest('hex');

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError('Validation failed', 'body is not a JSON object');
  }
  trace.request = maskBody(body);
  const topic = str(body.topic);
  const eventType = str(body.eventType);
  const ref = str(body.id);
  if (ref) trace.paymentId = await paymentIdForRef('hg', ref);

  let inserted = await db.one<{ id: string }>(
    `INSERT INTO webhook_inbox (topic, event_type, provider_ref, dedupe_key, body, signature_ok)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [topic || null, eventType || null, ref || null, dedupe, rawBody, ok],
  );
  if (!ok) {
    log.warn('webhook signature rejected', { topic, eventType, ref, signed: Boolean(signatureHeader) });
    throw new AuthError('invalid webhook signature');
  }
  if (!inserted) {
    // Seen before. Processed: answer 200, no side effects. Not processed (the
    // earlier attempt failed): the provider's retry is the recovery, run it again.
    const earlier = await db.one<{ id: string; processed_at: string | null }>('SELECT id, processed_at FROM webhook_inbox WHERE dedupe_key = $1', [dedupe]);
    if (!earlier || earlier.processed_at) return { accepted: true, duplicate: true, handled: 'duplicate' };
    inserted = { id: earlier.id };
  }

  let handled = 'ignored';
  try {
    if (topic === 'TRANSACTION_REQUEST' && ref) {
      // A transfer we hold no reference for yet (its creation got no answer):
      // the provider echoes our payment id as its external id.
      const paymentId = str(body.externalID) || str((body.data as Record<string, unknown> | undefined)?.paymentId);
      if (paymentId && await adoptPayoutRef(paymentId, ref)) trace.paymentId = paymentId;
    }
    if (topic === 'CHECKOUT' && ref) {
      const status = str(body.status) || eventType.replace(/^checkout\./, '');
      await applyCheckout(ref, status, 'provider', { eventType, transactionId: body.transactionId ?? null });
      handled = `checkout:${status}`;
    } else if (topic === 'TRANSACTION_REQUEST' && ref) {
      const status = str(body.status);
      await applyPayout(ref, status, 'provider', { errorCode: str(body.errorCode) || null });
      handled = `payout:${status}`;
    }
    await db.execute('UPDATE webhook_inbox SET processed_at = now(), result = $2 WHERE id = $1', [inserted.id, handled]);
  } catch (err) {
    await db.execute('UPDATE webhook_inbox SET result = $2 WHERE id = $1', [inserted.id, `error: ${String(err).slice(0, 200)}`]);
    throw err;
  }
  return { accepted: true, duplicate: false, handled };
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
