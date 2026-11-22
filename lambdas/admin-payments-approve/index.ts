/** `POST /api/v1/payments/admin/payments/{id}/approve` — credit a held deposit or send a held withdrawal. Body `{ note? }`. */
import { paymentsHandler } from '../_common/handler';
import { bodyObject, optionalString } from '../_common/validate';
import { paymentId } from '../_common/input';
import { approve } from '../_domain/payments';

export const handler = paymentsHandler('admin-payments-approve', async (ctx, event) => {
  const body = bodyObject(event.body);
  return approve(ctx, paymentId(event.path), optionalString(body, 'note', 500));
});
