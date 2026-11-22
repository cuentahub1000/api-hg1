/**
 * `POST /api/v1/payments/admin/payments/{id}/resolve` — close a withdrawal whose
 * transfer request got no usable answer (`processing` with no provider
 * reference). Body: `{ "providerRef": "<provider's transaction id>", "note" }`
 * to attach the reference the operator found at the provider (the payment id is
 * its external id) and read the transfer's state, or `{ "outcome": "failed",
 * "note" }` once the operator confirmed no transfer exists: the blocked amount
 * returns to the player.
 */
import { paymentsHandler } from '../_common/handler';
import { bodyObject, messageText, optionalString } from '../_common/validate';
import { ValidationError } from '../_common/errors';
import { paymentId } from '../_common/input';
import { resolveWithdrawal } from '../_domain/payments';

export const handler = paymentsHandler('admin-payments-resolve', async (ctx, event) => {
  const body = bodyObject(event.body);
  const providerRef = optionalString(body, 'providerRef', 128);
  const outcome = optionalString(body, 'outcome', 20);
  if (!providerRef && outcome !== 'failed') throw new ValidationError('Validation failed', "either 'providerRef' or 'outcome': 'failed' is required");
  if (providerRef && outcome) throw new ValidationError('Validation failed', "'providerRef' and 'outcome' cannot both be set");
  return resolveWithdrawal(ctx, paymentId(event.path), { providerRef, outcome: outcome === 'failed' ? 'failed' : undefined, note: messageText(body, 'note', 500) });
});
