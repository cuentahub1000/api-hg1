/** `GET /api/v1/payments/admin/settings` — the caller's tenant settings (holds, limits). */
import { paymentsHandler } from '../_common/handler';
import { rootOf } from '../_common/chain';
import { getSettings } from '../_domain/settings';

export const handler = paymentsHandler('admin-settings-get', async (ctx) => getSettings(rootOf(ctx.fullChain)));
