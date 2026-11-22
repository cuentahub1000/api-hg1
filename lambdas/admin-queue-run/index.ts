/** `POST /api/v1/payments/admin/withdrawals/queue/run` — pay the caller's tenant queue now instead of waiting for the next minute. */
import { paymentsHandler } from '../_common/handler';
import { rootOf } from '../_common/chain';
import { runQueue } from '../_domain/queue';

export const handler = paymentsHandler('admin-queue-run', async (ctx) => (await runQueue(rootOf(ctx.fullChain)))[0] ?? null);
