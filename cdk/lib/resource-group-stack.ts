import { ArnFormat, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rg from 'aws-cdk-lib/aws-resourcegroups';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { ROUTES, type Audience } from '../../lambdas/_routes';
import { SSM_ROOT } from './config';

export interface ResourceGroupStackProps extends StackProps {
  readonly envName: string;
}

/**
 * Tag-based resource group for the whole app, plus the caller side of IAM:
 * one managed policy per audience, derived from `lambdas/_routes.ts`:
 *
 *   `<env>-api-hg-player-invoker`    front-self's task role
 *   `<env>-api-hg-operator-invoker`  the back-office's task role
 *
 * ARNs are built from the naming convention (no cross-stack references; this
 * stack deploys first) and published at `/<env>/api-hg-lambda/
 * {player,operator}-invoker-policy-arn`. The webhook has no policy: the
 * provider calls its public Function URL.
 */
export class ResourceGroupStack extends Stack {
  constructor(scope: Construct, id: string, props: ResourceGroupStackProps) {
    super(scope, id, props);
    const { envName } = props;

    new rg.CfnGroup(this, 'Group', {
      name: `${envName}-api-hg-lambda`,
      resourceQuery: {
        type: 'TAG_FILTERS_1_0',
        query: {
          resourceTypeFilters: ['AWS::AllSupported'],
          tagFilters: [
            { key: 'Application', values: ['api-hg-lambda'] },
            { key: 'Environment', values: [envName] },
          ],
        },
      },
    });

    const fnArn = (slug: string) => this.formatArn({
      service: 'lambda', resource: 'function', resourceName: `${envName}-hg-${slug}`, arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const arnsFor = (audience: Audience) => ROUTES.filter((r) => r.audience === audience || r.audience === 'any').map((r) => fnArn(r.slug));

    for (const { audience, caller } of [{ audience: 'player' as const, caller: 'front-self (player app)' }, { audience: 'operator' as const, caller: 'backoffice' }]) {
      const title = audience.charAt(0).toUpperCase() + audience.slice(1);
      const policy = new iam.ManagedPolicy(this, `${title}InvokerPolicy`, {
        managedPolicyName: `${envName}-api-hg-${audience}-invoker`,
        description: `Invoke the ${audience} functions of api-hg (${envName}). Attach to the ${caller} task role.`,
        statements: [new iam.PolicyStatement({ sid: `Invoke${title}Functions`, actions: ['lambda:InvokeFunction'], resources: arnsFor(audience) })],
      });
      new StringParameter(this, `${title}InvokerPolicyArn`, {
        parameterName: `${SSM_ROOT(envName)}/${audience}-invoker-policy-arn`,
        stringValue: policy.managedPolicyArn,
        description: `Attach to the ${caller} task role to call the ${audience} api-hg functions.`,
      });
    }
  }
}
