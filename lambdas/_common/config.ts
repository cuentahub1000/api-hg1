/**
 * Runtime configuration.
 *
 * Two sources, merged once per process:
 *
 *   1. Plain environment variables — what Kubernetes injects from its
 *      ConfigMap + Secret, and what a local run uses.
 *   2. One Secrets Manager secret named by `HG_SECRET_ARN` (a secret
 *      *name*, `<env>/HgSecrets`), a JSON object whose keys are the same
 *      variable names. The Lambda deployment uses this so no credential is
 *      ever an env var on a function. A key present in the environment wins.
 *
 * This service is the ONLY holder of the provider token, the webhook signing
 * secret and the wallet service key. The Next.js apps only hold a platform
 * JWT. The database credential is a separate secret (`DB_SECRET_ARN`,
 * username/password as RDS writes it) read by `db.ts`.
 */

import { log } from './logger';

export interface ProviderConfig {
  /** `mock`: the in-process sandbox (no provider calls, fake hosted page); `live`: hg.cash. */
  mode: 'live' | 'mock';
  /** Base URL of the payment provider API, e.g. https://hg.cash/api/v1 */
  apiUrl: string;
  apiToken: string;
  /** Secret the provider signs webhook bodies with (HMAC-SHA256). Empty = unsigned, refused. */
  webhookSecret: string;
  /** The provider-side account checkouts are collected on and payouts paid from. */
  accountId: string;
  /** Public URL the provider must call back; sent with every checkout/payout. */
  webhookUrl: string;
  /** ISO country of the checkouts/payouts (AR, BR, CL, BO, CO). */
  country: string;
}

export interface WalletConfig {
  /** `mock`: an in-process wallet with one account per party (local sandbox only). */
  mode: 'lambda' | 'http' | 'mock';
  /** `lambda`: `${prefix}<slug>`, e.g. `stg88-wallet-`. */
  functionPrefix: string;
  region?: string;
  /** `http`: base URL of the wallet service (NestJS or the HTTP runtime). */
  apiUrl: string;
  /**
   * The service's own wallet credential (`x-api-key` of an integration user).
   * Used ONLY where no caller is present: the provider webhook and
   * re-checks it triggers. Every call made for a player or operator forwards
   * that caller's JWT instead (`_domain/wallet.ts`).
   */
  apiKey: string;
}

export interface PaymentsConfig {
  provider?: ProviderConfig;
  wallet?: WalletConfig;
  currency: string;
  /** Where the hosted payment page sends the player afterwards (front-self). `?payment=<id>` is appended. */
  returnUrl: string;
  cancelUrl: string;
  upstreamTimeoutMs: number;
  /** A pending deposit older than this is re-checked with the provider when read. */
  recheckAfterMs: number;
  /** HMAC key for the national-id hash stored on payments; empty = store nothing. */
  documentHashKey: string;
  /** When set, the webhook accepts only requests carrying this value in `x-webhook-edge-key` (sent by CloudFront). */
  webhookEdgeKey: string;
}

const SECRET_KEYS = ['PROVIDER_API_TOKEN', 'PROVIDER_WEBHOOK_SECRET', 'WALLET_API_KEY', 'DOCUMENT_HASH_KEY', 'WEBHOOK_EDGE_KEY'] as const;

let loaded: Promise<PaymentsConfig> | undefined;

export function getConfig(): Promise<PaymentsConfig> {
  if (!loaded) {
    loaded = build().catch((err) => {
      loaded = undefined;
      throw err;
    });
  }
  return loaded;
}

/** Test seam: forget the cached configuration. */
export function resetConfig(): void {
  loaded = undefined;
}

async function build(): Promise<PaymentsConfig> {
  const env: Record<string, string | undefined> = { ...process.env };
  const secretId = env.HG_SECRET_ARN;
  if (secretId) {
    const fromSecret = await readSecret(secretId);
    for (const key of SECRET_KEYS) {
      if (!env[key] && fromSecret[key]) env[key] = fromSecret[key];
    }
  }

  const cfg: PaymentsConfig = {
    currency: env.PAYMENTS_CURRENCY ?? 'ARS',
    returnUrl: stripSlash(env.PAYMENTS_RETURN_URL ?? ''),
    cancelUrl: stripSlash(env.PAYMENTS_CANCEL_URL ?? env.PAYMENTS_RETURN_URL ?? ''),
    upstreamTimeoutMs: Number(env.PAYMENTS_UPSTREAM_TIMEOUT_MS ?? '10000') || 10000,
    recheckAfterMs: Number(env.PAYMENTS_RECHECK_AFTER_MS ?? '60000') || 60000,
    documentHashKey: env.DOCUMENT_HASH_KEY ?? '',
    webhookEdgeKey: env.WEBHOOK_EDGE_REQUIRED === '1' ? (env.WEBHOOK_EDGE_KEY ?? '') : '',
  };

  const providerMode = (env.PROVIDER_MODE ?? 'live').toLowerCase();
  if (providerMode === 'mock') {
    cfg.provider = {
      mode: 'mock',
      apiUrl: stripSlash(env.PROVIDER_SANDBOX_URL ?? 'http://127.0.0.1:9500'),
      apiToken: '',
      webhookSecret: env.PROVIDER_WEBHOOK_SECRET ?? '',
      accountId: 'sandbox',
      webhookUrl: '',
      country: (env.PAYMENTS_COUNTRY ?? 'AR').toUpperCase(),
    };
  } else if (env.PROVIDER_API_URL && env.PROVIDER_API_TOKEN && env.PROVIDER_ACCOUNT_ID) {
    cfg.provider = {
      mode: 'live',
      apiUrl: stripSlash(env.PROVIDER_API_URL),
      apiToken: env.PROVIDER_API_TOKEN,
      webhookSecret: env.PROVIDER_WEBHOOK_SECRET ?? '',
      accountId: env.PROVIDER_ACCOUNT_ID,
      webhookUrl: env.PROVIDER_WEBHOOK_URL ?? '',
      country: (env.PAYMENTS_COUNTRY ?? 'AR').toUpperCase(),
    };
  }

  const walletMode = (env.WALLET_MODE ?? 'lambda').toLowerCase();
  // The sandbox page completes payments without any check. Never with a real
  // wallet unless someone explicitly says so for a development wallet.
  if (providerMode === 'mock' && walletMode !== 'mock' && env.SANDBOX_ALLOW_REAL_WALLET !== '1') {
    throw new Error('PROVIDER_MODE=mock with a real wallet needs SANDBOX_ALLOW_REAL_WALLET=1 (development wallets only)');
  }
  if (walletMode === 'mock') {
    cfg.wallet = { mode: 'mock', functionPrefix: '', apiUrl: '', apiKey: '' };
  } else if (env.WALLET_API_KEY && (walletMode === 'http' ? env.WALLET_API_URL : env.WALLET_FUNCTION_PREFIX)) {
    cfg.wallet = {
      mode: walletMode === 'http' ? 'http' : 'lambda',
      functionPrefix: env.WALLET_FUNCTION_PREFIX ?? '',
      region: env.WALLET_REGION || env.AWS_REGION || undefined,
      // The routes carry `/api/v1/...`; accept a base URL given with or without it.
      apiUrl: stripSlash(env.WALLET_API_URL ?? '').replace(/\/api\/v1$/, ''),
      apiKey: env.WALLET_API_KEY,
    };
  }

  log.info('configuration loaded', {
    provider: cfg.provider?.mode ?? false,
    wallet: cfg.wallet?.mode ?? false,
    currency: cfg.currency,
    returnUrl: Boolean(cfg.returnUrl),
  });
  return cfg;
}

async function readSecret(secretId: string): Promise<Record<string, string>> {
  // Imported lazily so the Kubernetes image never loads the AWS SDK.
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const res = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error(`secret ${secretId} has no SecretString`);
  const parsed = JSON.parse(res.SecretString) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
  return out;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
