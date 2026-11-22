/**
 * `POST /api/v1/payments/webhook` — the provider's callback. No JWT: the body
 * is authenticated by its HMAC signature. Accepts the three event shapes it
 * can arrive in and always answers with the envelope (plus, for a Function
 * URL, the HTTP shape the URL expects):
 *
 *   HTTP runtime / tests:  { headers, body: <raw string | object> }
 *   Lambda Function URL:   { requestContext: { http }, headers, body, isBase64Encoded }
 *
 * The signature is computed over the raw bytes, so the body must reach this
 * handler unparsed; the HTTP runtime keeps the raw text for this route.
 */
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from '../_common/config';
import { PaymentsError, AuthError } from '../_common/errors';
import { log } from '../_common/logger';
import { GENERIC_MESSAGE } from '../_common/redact';
import { fail, ok, type Envelope } from '../_common/response';
import { receive, type WebhookResult } from '../_domain/webhook';

interface WebhookEvent {
  headers?: Record<string, unknown>;
  body?: unknown;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
  [key: string]: unknown;
}

type FunctionUrlResponse = { statusCode: number; headers: Record<string, string>; body: string };

export async function handler(event: WebhookEvent = {}): Promise<Envelope<WebhookResult> | FunctionUrlResponse> {
  const fromUrl = Boolean(event.requestContext?.http);
  const envelope = await run(event);
  if (!fromUrl) return envelope;
  return {
    statusCode: envelope.ok ? 200 : envelope.statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope.ok ? envelope.data : { error: envelope.error.type }),
  };
}

/**
 * Behind CloudFront (`WEBHOOK_EDGE_REQUIRED=1`) the Function URL must not be
 * usable directly: the distribution adds `x-webhook-edge-key` and anything
 * without it is refused before the body is looked at.
 */
async function requireEdge(headers: Record<string, string>): Promise<void> {
  if (process.env.WEBHOOK_EDGE_REQUIRED !== '1') return;
  const { webhookEdgeKey } = await getConfig();
  if (!webhookEdgeKey) throw new AuthError('edge key not configured');
  const got = Buffer.from(headers['x-webhook-edge-key'] ?? '');
  const want = Buffer.from(webhookEdgeKey);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new AuthError('not via edge');
}

async function run(event: WebhookEvent): Promise<Envelope<WebhookResult>> {
  try {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined && v !== null) headers[k.toLowerCase()] = String(v);
    let raw: string;
    if (typeof event.body === 'string') raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    else if (event.body && typeof event.body === 'object') raw = JSON.stringify(event.body);
    else throw new AuthError('empty webhook body');
    await requireEdge(headers);
    return ok(await receive(raw, headers['x-hg-webhook-signature'] ?? headers['x-webhook-signature']));
  } catch (err) {
    if (err instanceof PaymentsError) {
      log[err.httpErrorStatus >= 500 ? 'error' : 'warn']('webhook refused', { type: err.name, err: err.message });
      return fail(err);
    }
    log.error('webhook failed', { err: String(err), stack: (err as Error)?.stack });
    return fail(new PaymentsError(GENERIC_MESSAGE));
  }
}
