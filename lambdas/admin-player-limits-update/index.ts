/** `PUT /api/v1/payments/admin/players/{partyId}/limits` — any subset of the override fields; `null` returns a field to the tenant value. */
import { paymentsHandler } from '../_common/handler';
import { bodyObject } from '../_common/validate';
import { partyIdParam } from '../_common/party';
import { assertPartyInScope } from '../_domain/payments';
import { playerOverview, updatePlayerLimits } from '../_domain/players';

export const handler = paymentsHandler('admin-player-limits-update', async (ctx, event) => {
  const partyId = partyIdParam(event.path);
  const tenant = await assertPartyInScope(ctx, partyId);
  await updatePlayerLimits(partyId, tenant, bodyObject(event.body), ctx.partyId);
  return playerOverview(partyId, tenant);
});
