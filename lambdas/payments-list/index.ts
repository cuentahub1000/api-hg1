/** `GET /api/v1/payments` — the caller's own payments. Query `kind`, `status`, `limit`, `cursor`. */
import { paymentsHandler } from '../_common/handler';
import { listFilter } from '../_common/input';
import { listForPlayer } from '../_domain/payments';

export const handler = paymentsHandler('payments-list', async (ctx, event) => {
  const f = listFilter(event.query, { limit: 20, max: 100 });
  f.partyId = undefined; // a player never filters by party or account: the scope is the token
  f.accountId = undefined;
  return listForPlayer(ctx, f);
});
