import * as path from 'path';
import { Annotations, ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { API_NAME } from '../../lambdas/_routes';
import { EnvConfig, FunctionSpec, SSM_ROOT, WEBHOOK_PATH, isPresent } from './config';

export interface FunctionStackProps extends StackProps {
  readonly cfg: EnvConfig;
  readonly fn: FunctionSpec;
}

/**
 * One stack per function, `<env>-hg-<slug>`: the function in the
 * platform VPC (it needs the provider on the internet through the NAT, the
 * wallet functions, and its own database), its log group, and an explicit
 * execution role holding exactly: its log group, the JWT / payments /
 * database secrets, the wallet invoker policy (lambda mode), and VPC ENI
 * access. The database security group gets an ingress rule from the
 * function's security group.
 *
 * Every value that may change between deploys (SSM parameters) is resolved in
 * this stack's own scope, never passed in from the app, so no stack exports
 * it to another and a changed parameter redeploys only the functions.
 *
 * Every JWT function also reads api-auth (`AUTH_DB_*`, the `Session` table) and
 * api-security (`SECURITY_DB_*`, role features), both read-only, for
 * the per-call session and feature checks.
 *
 * `webhook` additionally gets a public Function URL (the provider calls it;
 * the handler verifies the HMAC) published at
 * `/<env>/api-hg-lambda/webhook-function-url`, which every other
 * function reads as `PROVIDER_WEBHOOK_URL` unless `provider-webhook-url` is
 * set in SSM. `migrate` has no route; the deploy script invokes it.
 * `queue-run` has no route either: an EventBridge rule invokes it on its
 * `schedule` (every minute) to pay the withdrawal queues.
 */
export class FunctionStack extends Stack {
  readonly fn: lambda.Function;
  /** Set on the webhook stack only. */
  functionUrl?: lambda.IFunctionUrl;

  constructor(scope: Construct, id: string, props: FunctionStackProps) {
    super(scope, id, props);
    const { cfg, fn } = props;
    const fnName = `${cfg.envName}-hg-${fn.slug}`;
    const root = SSM_ROOT(cfg.envName);
    const deployParam = (name: string) => StringParameter.valueForStringParameter(this, `${root}/${name}`);
    const ssm = (fullName: string) => StringParameter.valueForStringParameter(this, fullName);

    let vpc: ec2.IVpc | undefined;
    let vpcSubnets: ec2.SubnetSelection | undefined;
    const securityGroups: ec2.ISecurityGroup[] = [];
    if (isPresent(cfg.vpcId)) {
      vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: cfg.vpcId });
      vpcSubnets = cfg.privateSubnetIds.length > 0
        ? { subnets: cfg.privateSubnetIds.map((sid, i) => ec2.Subnet.fromSubnetId(this, `PrivateSubnet${i + 1}`, sid)) }
        : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
      Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-ec2:noSubnetRouteTableId', 'Subnets are imported by id for Lambda placement only.');
      const own = new ec2.SecurityGroup(this, 'FnSg', { vpc, allowAllOutbound: true, description: `egress sg for ${fnName}`, securityGroupName: `${fnName}-egress` });
      securityGroups.push(own);
      [...cfg.lambdaSgIds, ...cfg.lambdaSgParams.map(ssm)].forEach((sgId, i) => securityGroups.push(ec2.SecurityGroup.fromSecurityGroupId(this, `LambdaSg${i}`, sgId, { mutable: false })));
      // Ingress to the payments database from this function only.
      const dbSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'DbSg', deployParam('db-sg-id'), { mutable: true });
      dbSg.addIngressRule(own, ec2.Port.tcp(5432), `${fnName} to payments postgres`);
    }

    const env: Record<string, string> = {
      FUNCTION_NAME: fn.slug,
      PAYMENTS_API: API_NAME,
      PAYMENTS_RESOURCE: fn.resource,
      PAYMENTS_METHOD: fn.method,
      JWT_SECRET_ARN: cfg.jwtSecretName,
      HG_SECRET_ARN: cfg.paymentsSecretName,
      DB_HOST: deployParam('db-host'),
      DB_PORT: deployParam('db-port'),
      DB_NAME: deployParam('db-name'),
      DB_SECRET_ARN: cfg.dbSecretName,
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      WALLET_FUNCTION_PREFIX: `${cfg.walletEnv}-wallet-`,
    };
    for (const [envVar, param] of Object.entries(cfg.plainEnvParams)) env[envVar] = ssm(param);
    if (!cfg.webhookUrlOverridden && fn.slug !== 'webhook' && fn.slug !== 'migrate') {
      // With a custom domain the provider is told the CloudFront URL; otherwise the Function URL.
      env.PROVIDER_WEBHOOK_URL = cfg.webhookDomain ? `https://${cfg.webhookDomain}${WEBHOOK_PATH}` : deployParam('webhook-function-url');
    }
    if (fn.slug === 'webhook' && cfg.webhookDomain) env.WEBHOOK_EDGE_REQUIRED = '1';
    // Every JWT-authenticated function checks the caller's session against
    // api-auth and (operator writes) role features against api-security, both
    // read-only, reader endpoints.
    const checksSecurity = fn.slug !== 'webhook' && fn.slug !== 'migrate' && !fn.schedule;
    if (checksSecurity) {
      env.AUTH_DB_HOST = StringParameter.valueForStringParameter(this, `/${cfg.envName}/ApiAuthDatabaseReadOnlyHost`);
      env.AUTH_DB_PORT = StringParameter.valueForStringParameter(this, `/${cfg.envName}/ApiAuthDatabasePort`);
      env.AUTH_DB_NAME = StringParameter.valueForStringParameter(this, `/${cfg.envName}/ApiAuthDatabaseName`);
      env.AUTH_DB_SECRET_ARN = cfg.authDbSecretName;
      env.SECURITY_DB_HOST = StringParameter.valueForStringParameter(this, `/${cfg.envName}/ApiSecurityDatabaseReadOnlyHost`);
      env.SECURITY_DB_PORT = StringParameter.valueForStringParameter(this, `/${cfg.envName}/ApiSecurityDatabasePort`);
      env.SECURITY_DB_NAME = StringParameter.valueForStringParameter(this, `/${cfg.envName}/ApiSecurityDatabaseName`);
      env.SECURITY_DB_SECRET_ARN = cfg.securityDbSecretName;
    }
    if (cfg.otelEndpoint !== '' || cfg.otelEndpointParam !== '') {
      env.OTEL_EXPORTER_OTLP_ENDPOINT = cfg.otelEndpoint !== '' ? cfg.otelEndpoint : ssm(cfg.otelEndpointParam);
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
      env.OTEL_SERVICE_NAME = fnName;
      env.OTEL_RESOURCE_ATTRIBUTES = `service.namespace=api-hg-lambda,deployment.environment=${cfg.envName}`;
    }

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${fnName}`,
      retention: cfg.logRetentionDays,
      removalPolicy: cfg.retainLogGroups ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, 'ExecutionRole', {
      roleName: `${fnName}-exec`,
      description: `Execution role of ${fnName}: own log group, JWT/Payments/DB secrets, wallet invoke.`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteOwnLogGroup',
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadSecrets',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [cfg.jwtSecretName, cfg.paymentsSecretName, cfg.dbSecretName, ...(checksSecurity ? [cfg.authDbSecretName, cfg.securityDbSecretName] : [])].map((secretName) =>
        this.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${secretName}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })),
    }));
    if (vpc) role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
    if (cfg.walletMode === 'lambda' && cfg.walletInvokerPolicyParam && fn.slug !== 'migrate') {
      role.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, 'WalletInvoke', ssm(cfg.walletInvokerPolicyParam)));
    }

    const repoRoot = path.join(__dirname, '..', '..');
    this.fn = new nodejs.NodejsFunction(this, 'Function', {
      functionName: fnName,
      role,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(repoRoot, 'lambdas', fn.slug, 'index.ts'),
      handler: 'handler',
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      timeout: Duration.seconds(fn.timeoutSec ?? 15),
      memorySize: fn.memoryMb ?? 128,
      environment: env,
      logGroup,
      ...(vpc ? { vpc, vpcSubnets, securityGroups } : {}),
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'node22',
        format: nodejs.OutputFormat.CJS,
        externalModules: ['@aws-sdk/*'],
        // `pg` pulls optional native bindings; keep the pure-JS driver only.
        nodeModules: ['pg'],
        ...(fn.slug === 'migrate' ? {
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (inputDir: string, outputDir: string) => [`mkdir -p ${outputDir}/sql && cp ${inputDir}/sql/*.sql ${outputDir}/sql/`],
          },
        } : {}),
      },
    });

    if (fn.schedule) {
      new events.Rule(this, 'Schedule', {
        ruleName: `${fnName}-schedule`,
        description: `Invokes ${fnName} (${fn.schedule}).`,
        schedule: events.Schedule.expression(fn.schedule),
        targets: [new targets.LambdaFunction(this.fn)],
      });
    }

    if (fn.publicUrl) {
      const url = this.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
      this.functionUrl = url;
      new StringParameter(this, 'WebhookUrlParam', {
        parameterName: `${root}/webhook-function-url`,
        stringValue: url.url,
        description: 'Public URL the payment provider calls back (HMAC-verified by the function).',
      });
      new CfnOutput(this, 'WebhookUrl', { value: url.url, description: 'Register this URL (and the signing secret) in the provider dashboard.' });
    }
  }
}
