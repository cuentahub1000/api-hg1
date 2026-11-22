/** `POST /api/v1/payments/admin/players/{partyId}/blocks` — block deposits, withdrawals or both. Body `{ kind, reason, until? | days? }`; no end = permanent. */
import { paymentsHandler } from '../_common/handler';
import { ValidationError } from '../_common/errors';
import { bodyObject, messageText, optionalInt, optionalString, requiredEnum } from '../_common/validate';
import { partyIdParam } from '../_common/party';
import { assertPartyInScope } from '../_domain/payments';
import { addBlock, playerOverview } from '../_domain/players';

export const handler = paymentsHandler('admin-player-block', async (ctx, event) => {
  const partyId = partyIdParam(event.path);
  const tenant = await assertPartyInScope(ctx, partyId);
  const body = bodyObject(event.body);
  const kind = requiredEnum(body, 'kind', ['deposit', 'withdrawal', 'all'] as const);
  const reason = messageText(body, 'reason', 500);
  let until: string | null = null;
  const untilRaw = optionalString(body, 'until', 40);
  const days = optionalInt(body, 'days', 0, 1, 3650);
  if (untilRaw) {
    if (Number.isNaN(Date.parse(untilRaw)) || Date.parse(untilRaw) <= Date.now()) throw new ValidationError('Validation failed', "'until' must be a future ISO date");
    until = new Date(untilRaw).toISOString();
  } else if (days) {
    until = new Date(Date.now() + days * 86_400_000).toISOString();
  }
  await addBlock(partyId, tenant, kind, until, reason, ctx.partyId);
  return playerOverview(partyId, tenant);
});
