/**
 * Per-environment configuration from SSM, same two roots as the wallet and
 * engagement functions:
 *
 *   /<env>/<Name>                    platform-owned (VpcId, PrivateSubnet1/2,
 *                                    ClientSecurityGroupId, DatabaseClientSecurityGroupId,
 *                                    MainOtelEndpoint,
 *                                    ApiAuthDatabaseReadOnlyHost/Port/Name: the api-auth
 *                                    DB read for the session check,
 *                                    ApiSecurityDatabaseReadOnlyHost/Port/Name: the
 *                                    api-security DB read for the feature check)
 *   /<env>/api-hg-lambda/<n>   app-owned, written by scripts/bootstrap-ssm.sh:
 *       provider-api-url, provider-account-id, provider-webhook-url (optional override),
 *       payments-country, payments-currency, payments-return-url, payments-cancel-url,
 *       wallet-mode (lambda|http), wallet-env (optional: env whose wallet to call), wallet-api-url,
 *       wallet-invoker-policy-arn (optional override), lambda-sg-ids, otel-endpoint,
 *       db-instance-type (RDS class of the payments database, default t4g.micro),
 *       webhook-domain, webhook-hosted-zone-id, webhook-hosted-zone-name
 *       (public webhook on CloudFront, stack <env>-HgWebhookEdge, deployed by deploy:webhook-edge only)
 *     and, written by the database stack:
 *       db-host, db-port, db-name, db-secret-name, db-sg-id, webhook-function-url
 *
 * Secrets never pass through SSM. Two Secrets Manager names are constructed:
 *   <env>/JWTSecret          the platform token secret (already exists)
 *   <env>/ApiAuthDatabaseReadOnlySecret       read-only credential of api-auth (platform-owned)
 *   <env>/ApiSecurityDatabaseReadOnlySecret   read-only credential of api-security (platform-owned)
 *   <env>/HgSecrets    JSON: PROVIDER_API_TOKEN, PROVIDER_WEBHOOK_SECRET, WALLET_API_KEY
 * plus the database credential the database stack generates
 * (`<env>/HgDatabase/postgres`).
 */

import { Construct } from 'constructs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { ROUTES, type RouteSpec } from '../../lambdas/_routes';

export interface EnvConfig {
  readonly envName: string;
  readonly vpcId: string;
  readonly privateSubnetIds: readonly string[];
  /** Extra security groups for the functions: literal ids from `lambda-sg-ids`. */
  readonly lambdaSgIds: readonly string[];
  /** ...or, when that is unset, the platform SSM parameters each stack resolves itself at deploy. */
  readonly lambdaSgParams: readonly string[];
  /** OTel collector: a literal override from `otel-endpoint`, else '' and `otelEndpointParam` names the platform parameter. */
  readonly otelEndpoint: string;
  readonly otelEndpointParam: string;
  readonly jwtSecretName: string;
  readonly paymentsSecretName: string;
  readonly dbSecretName: string;
  /** Read-only credential of the api-auth database (platform-owned secret name): the `Session` table. */
  readonly authDbSecretName: string;
  /** Read-only credential of the api-security database (platform-owned secret name): User/Role/Feature. */
  readonly securityDbSecretName: string;
  /** RDS instance class for the payments database, from `db-instance-type` (default t4g.micro). */
  readonly dbInstanceType: string;
  /**
   * Plain (non-secret) env vars: env var -> full SSM parameter name. Each
   * function stack resolves them in its own scope at deploy time. Resolving
   * them once here would make them exports of the resource-group stack, and
   * CloudFormation refuses to change an export another stack imports: one
   * edited parameter would block every deploy.
   */
  readonly plainEnvParams: Readonly<Record<string, string>>;
  /** Environment whose wallet functions (`<walletEnv>-wallet-<route>`) are called; normally this one. */
  readonly walletEnv: string;
  /** Wallet reached as Lambdas: attach the wallet's invoker policy to the execution roles. */
  readonly walletMode: 'lambda' | 'http';
  /** SSM parameter holding the wallet invoker managed policy ARN, or '' when not published. */
  readonly walletInvokerPolicyParam: string;
  /** True when `provider-webhook-url` is set (an ingress in front of the HTTP runtime); else the webhook Function URL is used. */
  readonly webhookUrlOverridden: boolean;
  /** Custom domain of the public webhook (CloudFront). Empty = functions use the Function URL as is. */
  readonly webhookDomain: string;
  readonly webhookHostedZoneId: string;
  readonly webhookHostedZoneName: string;
  readonly logRetentionDays: number;
  readonly retainLogGroups: boolean;
}

/** A route, or a function without one: `schedule` is an EventBridge expression that invokes it. */
export type FunctionSpec = RouteSpec & { readonly schedule?: string };
/** Every route, plus the migration function (no HTTP route, invoked by the deploy script). */
export const MIGRATE: FunctionSpec = { slug: 'migrate', method: 'POST', resource: '-', audience: 'any', timeoutSec: 120 };
/** The withdrawal queue run: no route, invoked every minute. */
export const QUEUE_RUN: FunctionSpec = { slug: 'queue-run', method: 'POST', resource: '-', audience: 'any', timeoutSec: 300, schedule: 'rate(1 minute)' };
export const FUNCTIONS: readonly FunctionSpec[] = [...ROUTES, MIGRATE, QUEUE_RUN];
export const WEBHOOK_PATH = ROUTES.find((r) => r.slug === 'webhook')!.resource;

export const SSM_ROOT = (envName: string) => `/${envName}/api-hg-lambda`;

export function pascal(name: string): string {
  return name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

const PLAIN_PARAMS: ReadonlyArray<[envVar: string, ssmName: string]> = [
  ['PROVIDER_API_URL', 'provider-api-url'],
  ['PROVIDER_ACCOUNT_ID', 'provider-account-id'],
  ['PROVIDER_WEBHOOK_URL', 'provider-webhook-url'],
  ['PAYMENTS_COUNTRY', 'payments-country'],
  ['PAYMENTS_CURRENCY', 'payments-currency'],
  ['PAYMENTS_RETURN_URL', 'payments-return-url'],
  ['PAYMENTS_CANCEL_URL', 'payments-cancel-url'],
  ['WALLET_MODE', 'wallet-mode'],
  ['WALLET_API_URL', 'wallet-api-url'],
];

export function loadConfig(scope: Construct, envName: string): EnvConfig {
  const platformRoot = `/${envName}`;
  const root = SSM_ROOT(envName);

  const platformSynth = (name: string) => StringParameter.valueFromLookup(scope, `${platformRoot}/${name}`, '-');
  const synth = (name: string) => StringParameter.valueFromLookup(scope, `${root}/${name}`, '-');
  // Deploy-time values are NOT resolved here (see `plainEnvParams`): only the
  // parameter names are passed on, and each function stack reads them itself.

  const sgIds = synth('lambda-sg-ids');
  const otelOverride = synth('otel-endpoint');

  const plainEnvParams: Record<string, string> = {};
  for (const [envVar, ssmName] of PLAIN_PARAMS) {
    // Synth-time lookup so an unset parameter is simply absent from the
    // function's environment, instead of a CloudFormation failure at deploy.
    if (isPresent(synth(ssmName))) plainEnvParams[envVar] = `${root}/${ssmName}`;
  }
  const walletMode = (isPresent(synth('wallet-mode')) ? synth('wallet-mode') : 'lambda').toLowerCase() === 'http' ? 'http' : 'lambda';

  // The wallet publishes its invoker policy ARN; an override slot exists for an
  // environment where the wallet functions live under another name.
  let walletInvokerPolicyParam = '';
  if (walletMode === 'lambda') {
    if (isPresent(synth('wallet-invoker-policy-arn'))) walletInvokerPolicyParam = `${root}/wallet-invoker-policy-arn`;
    else if (isPresent(StringParameter.valueFromLookup(scope, `/${envName}/api-wallet-lambda/invoker-policy-arn`, '-'))) {
      walletInvokerPolicyParam = `/${envName}/api-wallet-lambda/invoker-policy-arn`;
    }
  }

  return {
    envName,
    vpcId: platformSynth('VpcId'),
    privateSubnetIds: [platformSynth('PrivateSubnet1'), platformSynth('PrivateSubnet2')].filter(isPresent),
    lambdaSgIds: isPresent(sgIds) ? splitList(sgIds).slice(0, 2) : [],
    // Without `lambda-sg-ids` the functions sit in both platform client groups:
    // the general one and the one the shared database cluster admits on 5432.
    lambdaSgParams: isPresent(sgIds) ? [] : [`${platformRoot}/ClientSecurityGroupId`, `${platformRoot}/DatabaseClientSecurityGroupId`],
    otelEndpoint: isPresent(otelOverride) && otelOverride !== 'none' ? otelOverride : '',
    otelEndpointParam: isPresent(otelOverride) || !isPresent(platformSynth('MainOtelEndpoint')) ? '' : `${platformRoot}/MainOtelEndpoint`,
    jwtSecretName: `${envName}/JWTSecret`,
    paymentsSecretName: `${envName}/HgSecrets`,
    dbSecretName: `${envName}/HgDatabase/postgres`,
    authDbSecretName: `${envName}/ApiAuthDatabaseReadOnlySecret`,
    securityDbSecretName: `${envName}/ApiSecurityDatabaseReadOnlySecret`,
    dbInstanceType: isPresent(synth('db-instance-type')) ? synth('db-instance-type') : 't4g.micro',
    plainEnvParams,
    walletEnv: isPresent(synth('wallet-env')) ? synth('wallet-env') : envName,
    walletMode,
    walletInvokerPolicyParam,
    webhookUrlOverridden: isPresent(synth('provider-webhook-url')),
    webhookDomain: isPresent(synth('webhook-domain')) ? synth('webhook-domain') : '',
    webhookHostedZoneId: isPresent(synth('webhook-hosted-zone-id')) ? synth('webhook-hosted-zone-id') : '',
    webhookHostedZoneName: isPresent(synth('webhook-hosted-zone-name')) ? synth('webhook-hosted-zone-name') : '',
    logRetentionDays: 14,
    retainLogGroups: /^(1|true|yes)$/i.test(process.env.RETAIN_LOG_GROUPS ?? ''),
  };
}

export function isPresent(v: string): boolean {
  return Boolean(v) && v !== '-' && !v.startsWith('dummy-value-for-');
}

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
