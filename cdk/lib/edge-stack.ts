import { Annotations, CfnOutput, Duration, Stack, StackProps, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { EnvConfig, SSM_ROOT, WEBHOOK_PATH } from './config';

export interface EdgeStackProps extends StackProps {
  readonly cfg: EnvConfig;
  readonly webhookUrl: lambda.IFunctionUrl;
}

/** Header CloudFront adds on every origin request; the webhook function requires it. */
export const EDGE_KEY_HEADER = 'x-webhook-edge-key';

/**
 * The public face of the webhook: a CloudFront distribution on the custom
 * domain `webhook-domain`, with its ACM certificate created and DNS-validated
 * in the Route 53 zone `webhook-hosted-zone-id`/`-name`, alias record
 * included; origin = the webhook Function URL. Deployed only by
 * `npm run deploy:webhook-edge`, never by `deploy:all`. Caching off, every header
 * and the body forwarded untouched (the function verifies the HMAC over the
 * raw body). The Function URL's `x-amzn-*` response headers cannot be removed
 * by CloudFront (reserved headers); only `Server` is dropped. CloudFront sends
 * `x-webhook-edge-key` = HgSecrets.WEBHOOK_EDGE_KEY and the function refuses
 * requests without it, so the Function URL is unusable directly.
 *
 * Only `POST <WEBHOOK_PATH>` is proxied; anything else answers 403 at the edge.
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { cfg, webhookUrl } = props;
    const root = SSM_ROOT(cfg.envName);

    // Inputs are checked here, not by making the stack disappear: a missing
    // value fails `deploy:webhook-edge` with this message and nothing else.
    if (!cfg.webhookDomain || !cfg.webhookHostedZoneId || !cfg.webhookHostedZoneName) {
      Annotations.of(this).addError(`${root}/webhook-domain, ${root}/webhook-hosted-zone-id and ${root}/webhook-hosted-zone-name must be set before deploying the webhook edge`);
      return;
    }
    if (this.region !== 'us-east-1') {
      Annotations.of(this).addError('the webhook edge stack must be deployed in us-east-1: CloudFront certificates live there');
      return;
    }
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: cfg.webhookHostedZoneId, zoneName: cfg.webhookHostedZoneName,
    });
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: cfg.webhookDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const edgeKey = SecretValue.secretsManager(cfg.paymentsSecretName, { jsonField: 'WEBHOOK_EDGE_KEY' }).unsafeUnwrap();

    const origin = new origins.FunctionUrlOrigin(webhookUrl, {
      customHeaders: { [EDGE_KEY_HEADER]: edgeKey },
      readTimeout: Duration.seconds(30),
    });

    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      responseHeadersPolicyName: `${cfg.envName}-hg-webhook-edge`,
      // CloudFront cannot remove x-amz-*/x-amzn-* headers (reserved); those from
      // the Function URL reach the caller. Only `Server` can be dropped here.
      comment: 'Drop the Server header.',
      removeHeaders: ['Server'],
    });

    // Only the webhook path reaches the origin. Everything else is answered at the edge.
    const denyAll = new cloudfront.Function(this, 'DenyFn', {
      functionName: `${cfg.envName}-hg-webhook-edge-deny`,
      code: cloudfront.FunctionCode.fromInline('function handler(e){return {statusCode:403,statusDescription:"Forbidden"};}'),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${cfg.envName} payments webhook`,
      domainNames: [cfg.webhookDomain],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        functionAssociations: [{ function: denyAll, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        [WEBHOOK_PATH]: {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: responseHeaders,
        },
      },
    });

    new route53.ARecord(this, 'Alias', {
      zone, recordName: cfg.webhookDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    const publicUrl = `https://${cfg.webhookDomain}${WEBHOOK_PATH}`;
    new StringParameter(this, 'PublicUrlParam', {
      parameterName: `${root}/webhook-public-url`,
      stringValue: publicUrl,
      description: 'Public webhook URL on the custom domain (register this one in the provider dashboard).',
    });
    new CfnOutput(this, 'WebhookPublicUrl', { value: publicUrl, description: 'Register this URL in the provider dashboard.' });
  }
}
