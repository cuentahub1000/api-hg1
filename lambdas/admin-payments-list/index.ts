/** `GET /api/v1/payments/admin/payments` — payments of the operator's subtree. Query `kind`, `status` (`open` = non-final), `partyId`, `from`, `to`, `limit`, `cursor`. */
import { paymentsHandler } from '../_common/handler';
import { listFilter } from '../_common/input';
import { listForOperator } from '../_domain/payments';

export const handler = paymentsHandler('admin-payments-list', async (ctx, event) => listForOperator(ctx, listFilter(event.query, { limit: 50, max: 200 })));
