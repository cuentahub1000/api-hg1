/** `PUT /api/v1/payments/admin/payments/{id}/priority` — move a queued withdrawal. Body `{ priority }` (integer, lower is paid first). */
import { paymentsHandler } from '../_common/handler';
import { ValidationError } from '../_common/errors';
import { bodyObject } from '../_common/validate';
import { paymentId } from '../_common/input';
import { setPriority } from '../_domain/payments';

export const handler = paymentsHandler('admin-payments-prioritize', async (ctx, event) => {
  const body = bodyObject(event.body);
  const p = body.priority;
  if (!Number.isInteger(p) || (p as number) < 0 || (p as number) > 1e15) throw new ValidationError('Validation failed', "'priority' must be a non-negative integer");
  return setPriority(ctx, paymentId(event.path), p as number);
});
