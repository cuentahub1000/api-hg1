/** `GET /api/v1/payments/admin/withdrawals/queue` — the subtree's queued withdrawals in payment order, with the account balance for root operators. */
import { paymentsHandler } from '../_common/handler';
import { listQueue } from '../_domain/queue';

export const handler = paymentsHandler('admin-queue-list', async (ctx) => listQueue(ctx));
