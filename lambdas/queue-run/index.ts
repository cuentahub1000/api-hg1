/**
 * `<env>-hg-queue-run` — pays every tenant's withdrawal queue from its provider
 * account balance (`_domain/queue.ts`). Not an HTTP route: EventBridge invokes
 * it every minute; the HTTP runtime runs the same function on a timer.
 */
import { runQueue, type QueueRunResult } from '../_domain/queue';

export async function handler(): Promise<{ ok: true; data: QueueRunResult[] }> {
  return { ok: true, data: await runQueue() };
}
