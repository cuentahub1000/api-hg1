/** `GET /api/v1/payments/admin/players/{partyId}` — the player's limit overrides, effective limits, rolling usage and blocks. */
import { paymentsHandler } from '../_common/handler';
import { partyIdParam } from '../_common/party';
import { assertPartyInScope } from '../_domain/payments';
import { playerOverview } from '../_domain/players';

export const handler = paymentsHandler('admin-player-get', async (ctx, event) => {
  const partyId = partyIdParam(event.path);
  const tenant = await assertPartyInScope(ctx, partyId);
  return playerOverview(partyId, tenant);
});
