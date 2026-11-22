/** `POST /api/v1/payments/admin/payments/{id}/reject` — refuse a held payment; a withdrawal's blocked amount is released. Body `{ note }` (required). */
import { paymentsHandler } from '../_common/handler';
import { bodyObject, messageText } from '../_common/validate';
import { paymentId } from '../_common/input';
import { reject } from '../_domain/payments';

export const handler = paymentsHandler('admin-payments-reject', async (ctx, event) => {
  const body = bodyObject(event.body);
  return reject(ctx, paymentId(event.path), messageText(body, 'note', 500));
});
