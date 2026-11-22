import { Annotations, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { EnvConfig, SSM_ROOT, isPresent } from './config';

export interface DatabaseStackProps extends StackProps {
  readonly cfg: EnvConfig;
}

export interface DatabaseSizing {
  readonly storageGb: number;
  readonly multiAz: boolean;
  readonly deletionProtection: boolean;
  readonly backupDays: number;
}

const DEFAULT_SIZING: DatabaseSizing = {
  storageGb: 20, multiAz: false, deletionProtection: false, backupDays: 7,
};

/**
 * The payments service's own store: one provisioned RDS Postgres instance
 * `<env>-hg-postgres`, database `payments`, TLS enforced, credential
 * generated into `<env>/HgDatabase/postgres`. Nothing else uses it and
 * it reaches nothing else. Endpoint, port, name, secret name and security
 * group id are published to SSM so the function stacks need no CFN export.
 *
 * A small provisioned instance is chosen over Aurora Serverless v2 because
 * the service runs around the clock at low load, where a db.t4g.micro is
 * roughly a quarter of the price of the 0.5 ACU serverless floor.
 *
 * The instance class comes from SSM `/<env>/api-hg-lambda/db-instance-type`
 * (bootstrap-ssm.sh, default t4g.micro). Storage, Multi-AZ, backups and
 * deletion protection per environment from `cdk.json` context
 * `paymentsDatabase.<env>` (defaults: 20 GB gp3, single AZ, 7 days, off).
 */
export class DatabaseStack extends Stack {
  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const env = cfg.envName;
    const sizing: DatabaseSizing = { ...DEFAULT_SIZING, ...((this.node.tryGetContext('paymentsDatabase') ?? {})[env] ?? {}) };

    // SSM lookups are placeholders on the CLI's first synth pass; throwing here
    // aborts that pass before the CLI can fetch the real values. Report through
    // Annotations instead: synth completes, the retry gets the values, and a
    // genuinely missing parameter still fails the deploy with this message.
    if (!isPresent(cfg.vpcId) || cfg.privateSubnetIds.length < 2) {
      Annotations.of(this).addError(`/${env}/VpcId, /${env}/PrivateSubnet1 and /${env}/PrivateSubnet2 must be set; the payments database lives in the platform VPC`);
      return;
    }
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: cfg.vpcId });
    const subnets = cfg.privateSubnetIds.map((sid, i) => ec2.Subnet.fromSubnetId(this, `PrivateSubnet${i + 1}`, sid));

    const sg = new ec2.SecurityGroup(this, 'PostgresSg', { vpc, description: `${env} payments postgres`, allowAllOutbound: false });

    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 });
    const parameterGroup = new rds.ParameterGroup(this, 'PostgresParams', {
      engine, description: `${env} payments postgres`, parameters: { 'rds.force_ssl': '1' },
    });
    const instance = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier: `${env}-hg-postgres`,
      engine,
      parameterGroup,
      instanceType: new ec2.InstanceType(cfg.dbInstanceType),
      vpc,
      vpcSubnets: { subnets },
      securityGroups: [sg],
      multiAz: sizing.multiAz,
      allocatedStorage: sizing.storageGb,
      storageType: rds.StorageType.GP3,
      credentials: rds.Credentials.fromGeneratedSecret('payments', { secretName: cfg.dbSecretName }),
      databaseName: 'payments',
      storageEncrypted: true,
      backupRetention: Duration.days(sizing.backupDays),
      deletionProtection: sizing.deletionProtection,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
    });

    const root = SSM_ROOT(env);
    const publish = (name: string, value: string, description: string) =>
      new StringParameter(this, `${name}Param`, { parameterName: `${root}/${name}`, stringValue: value, description });
    publish('db-host', instance.instanceEndpoint.hostname, 'payments postgres endpoint');
    publish('db-port', instance.instanceEndpoint.port.toString(), 'payments postgres port');
    publish('db-name', 'payments', 'payments database name');
    publish('db-secret-name', cfg.dbSecretName, 'Secrets Manager name of the payments database credential');
    publish('db-sg-id', sg.securityGroupId, 'security group of the payments postgres instance (functions get ingress to it)');
  }
}
