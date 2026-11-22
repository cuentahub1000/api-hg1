/** `POST /api/v1/payments/withdrawals/{id}/cancel` — the player withdraws a request still awaiting approval. */
import { paymentsHandler } from '../_common/handler';
import { paymentId } from '../_common/input';
import { cancelWithdrawal } from '../_domain/payments';

export const handler = paymentsHandler('withdrawals-cancel', async (ctx, event) => cancelWithdrawal(ctx, paymentId(event.path)));
