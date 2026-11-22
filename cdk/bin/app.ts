#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FunctionStack } from '../lib/function-stack';
import { ResourceGroupStack } from '../lib/resource-group-stack';
import { DatabaseStack } from '../lib/database-stack';
import { EdgeStack } from '../lib/edge-stack';
import { FUNCTIONS, loadConfig, pascal } from '../lib/config';

const app = new cdk.App();
const envName = app.node.tryGetContext('config');
if (!envName) throw new Error('No environment: run with envName=<env> (passed as -c config=<env>).');

const account = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';
if (!account) throw new Error('No AWS account resolved: run with credentials or pass -c account=<id>.');
const env = { account, region };

cdk.Tags.of(app).add('Application', 'api-hg-lambda');
cdk.Tags.of(app).add('Environment', envName);
cdk.Tags.of(app).add('ManagedBy', 'cdk');

const rg = new ResourceGroupStack(app, `${envName}-ApiHgResourceGroup`, { env, envName });
cdk.Tags.of(rg).add('Component', 'resource-group');

const cfg = loadConfig(rg, envName);

// `cdk deploy --all` orders: database -> webhook -> the other functions (they
// read the webhook's Function URL from SSM at deploy) -> resource group.
const database = new DatabaseStack(app, `${envName}-HgDatabase`, { env, cfg });
cdk.Tags.of(database).add('Component', 'payments-database');

const stacks = new Map<string, FunctionStack>();
for (const fn of FUNCTIONS) {
  const stack = new FunctionStack(app, `${envName}-ApiHg${pascal(fn.slug)}`, { env, cfg, fn });
  stack.addDependency(database);
  cdk.Tags.of(stack).add('Component', `payments-${fn.slug}`);
  stacks.set(fn.slug, stack);
}
const webhook = stacks.get('webhook')!;
for (const [slug, stack] of stacks) if (slug !== 'webhook' && slug !== 'migrate') stack.addDependency(webhook);
// The resource group (invoker policies naming the functions) deploys after the
// function stacks. This also carries the one-time change away from exported
// parameter values: the function stacks must drop their imports before the
// resource-group stack can drop the exports, or CloudFormation refuses both.
for (const stack of stacks.values()) rg.addDependency(stack);

// Public webhook on a custom domain. Always defined, never part of
// `deploy:all`: it is deployed (and removed) only by its own explicit command,
// so no parameter value can create or destroy infrastructure.
const edge = new EdgeStack(app, `${envName}-HgWebhookEdge`, { env, cfg, webhookUrl: webhook.functionUrl! });
edge.addDependency(webhook);
cdk.Tags.of(edge).add('Component', 'payments-webhook-edge');
