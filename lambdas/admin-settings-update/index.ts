/** `PUT /api/v1/payments/admin/settings` — root operators only: any subset of the writable settings. */
import { paymentsHandler } from '../_common/handler';
import { ForbiddenError } from '../_common/errors';
import { bodyObject } from '../_common/validate';
import { rootOf } from '../_common/chain';
import { updateSettings } from '../_domain/settings';

export const handler = paymentsHandler('admin-settings-update', async (ctx, event) => {
  if (ctx.chain !== '') throw new ForbiddenError('only a root operator may change payment settings');
  return updateSettings(rootOf(ctx.fullChain), bodyObject(event.body), ctx.partyId);
});
