/**
 * `POST /api/v1/payments/deposits` — start a deposit: a pending wallet deposit
 * plus a hosted checkout. Body `{ amount, accountId, payer? }`. Returns the payment with
 * `checkoutUrl`; the player pays there and the webhook completes it.
 */
import { paymentsHandler } from '../_common/handler';
import { bodyObject } from '../_common/validate';
import { accountId, amount, payer } from '../_common/input';
import { createDeposit } from '../_domain/payments';

export const handler = paymentsHandler('deposits-create', async (ctx, event) => {
  const body = bodyObject(event.body);
  return createDeposit(ctx, { amount: amount(body), accountId: accountId(body), payer: payer(body), locale: ctx.locale });
});
