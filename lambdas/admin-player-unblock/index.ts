/** `POST /api/v1/payments/admin/players/{partyId}/blocks/{blockId}/lift` — lift one block early. */
import { paymentsHandler } from '../_common/handler';
import { NotFoundError } from '../_common/errors';
import { optionalInt } from '../_common/validate';
import { partyIdParam } from '../_common/party';
import { assertPartyInScope } from '../_domain/payments';
import { liftBlock, playerOverview } from '../_domain/players';

export const handler = paymentsHandler('admin-player-unblock', async (ctx, event) => {
  const partyId = partyIdParam(event.path);
  const tenant = await assertPartyInScope(ctx, partyId);
  const blockId = optionalInt(event.path, 'blockId', 0, 1, 2_000_000_000);
  if (!blockId || !(await liftBlock(tenant, partyId, blockId, ctx.partyId))) throw new NotFoundError('Block not found');
  return playerOverview(partyId, tenant);
});
