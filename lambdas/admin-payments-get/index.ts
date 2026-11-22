/** `GET /api/v1/payments/admin/payments/{id}` — one payment with its event trail. */
import { paymentsHandler } from '../_common/handler';
import { paymentId } from '../_common/input';
import { getForOperator } from '../_domain/payments';

export const handler = paymentsHandler('admin-payments-get', async (ctx, event) => getForOperator(ctx, paymentId(event.path)));
