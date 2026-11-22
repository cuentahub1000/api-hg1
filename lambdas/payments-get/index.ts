/** `GET /api/v1/payments/{id}` — one of the caller's payments; a stale pending deposit is re-checked with the provider. */
import { paymentsHandler } from '../_common/handler';
import { paymentId } from '../_common/input';
import { getForPlayer } from '../_domain/payments';

export const handler = paymentsHandler('payments-get', async (ctx, event) => getForPlayer(ctx, paymentId(event.path)));
