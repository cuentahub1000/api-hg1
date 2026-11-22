# Proposal: public webhook entry point on ECS (nginx → webhook Lambda)

Status: superseded 2026-11-17. The user chose CloudFront instead of ECS/nginx; implemented as `cdk/lib/edge-stack.ts` (see README "Deploying"). Kept for the record.

## Goal

The provider must call `https://<custom-domain>/api/v1/payments/webhook` and see
an ordinary HTTPS service: a custom domain, a certificate we own, no header or
hostname that reveals Lambda. Today the webhook is a Lambda Function URL
(`https://<id>.lambda-url.<region>.on.aws`, headers `x-amzn-RequestId`,
`x-amzn-Trace-Id`, `x-amzn-Remapped-*`).

## How hub88-service is exposed (the model to follow)

- One ECS task on the platform cluster (`/<env>/EcsClusterName`, EC2 launch
  type, `awsvpc`), two containers: `nginx` sidecar that the load balancer
  targets + the app. Here there is no app container: nginx alone is the task.
- The platform owns the public side: internet-facing ALB on the environment
  certificate, target group, hostname `<app>.<env>.<zone>`, security groups and
  log group, published under `/<env>/<app>/*` (`TargetGroupArn`,
  `TaskSecurityGroupIds`, `ContainerPort`, `LogGroupName`, `PublicHostname`).
- Deploy is scripts, not CDK: `bootstrap.sh` (sizing, `/<env>/<app>/bootstrap/*`),
  `config.sh` (env vars, `/<env>/<app>/config/*`), `build.sh` (image to ECR, no
  environment), `deploy.sh <env> <tag>` (task definition + service),
  `status.sh`, `destroy.sh`. Nothing in the repo names an environment.

## Proposal

A new directory `api-hg/deploy/ecs/` copied from hub88-service's kit, reduced to
one container, application name **api-hg-webhook**.

### 1. nginx image (`deploy/ecs/docker/`)

- `Dockerfile.nginx`: `nginx:1.27-alpine`, non-root, same layout as hub88.
- `nginx.conf`:
  - `listen <ContainerPort>`; `server_tokens off`.
  - `location = /health` answered by nginx (200), for the load balancer.
  - `location = /api/v1/payments/webhook` with `POST` only →
    `proxy_pass https://$webhook_upstream`, where the upstream host is the
    Function URL hostname taken from env at container start (rendered like
    `pick-upstream.sh` does). `proxy_set_header Host <function-url-host>`,
    `proxy_ssl_server_name on`, `resolver` set to the VPC resolver,
    body passed untouched (the Lambda verifies the HMAC over the raw body).
  - Everything else → 404.
  - Hide what identifies Lambda on the way back: `proxy_hide_header` for
    `x-amzn-RequestId`, `x-amzn-Trace-Id`, `X-Amz-*`, every
    `x-amzn-Remapped-*`, `Server`; add nothing of our own except `Date`.
  - On the way in, strip incoming `X-Amz-*` / `x-amzn-*` headers so a caller
    cannot inject them.
  - Timeouts matching the Lambda's 30 s.

### 2. Task and deploy scripts (`deploy/ecs/*.sh`, `taskdef/`)

- Task definition: a single `nginx` container, `awsvpc`, EC2, platform
  execution/task roles, awslogs to `/<env>/api-hg-webhook/LogGroupName`.
- `config.sh` keys: `WEBHOOK_UPSTREAM_HOST` is **not** configured by hand; the
  deploy reads `/<env>/api-hg-lambda/webhook-function-url` (published by the
  webhook stack) and injects the hostname, the same way hub88's
  `conf/platform.env` injects `API_WALLET_URL`. Nothing else to configure.
- `bootstrap.sh` keys: `desired-count` (default 2), `nginx-cpu`,
  `nginx-memory-reservation`, `nginx-memory-limit`.
- `build.sh`, `deploy.sh`, `status.sh`, `destroy.sh`: hub88's, with the app
  container removed.

### 3. Custom domain and certificate

hub88 uses the environment certificate and `<app>.<env>.<zone>`. For a domain
the provider sees (`pay.<brand>.com` or similar) two things are added, both
outside the task:

- An ACM certificate for the custom domain, in the same region as the ALB,
  DNS-validated by whoever controls that domain. Its ARN is given to the
  platform entry (or, if the platform cannot take a second certificate, it is
  added to the ALB's HTTPS listener as an additional SNI certificate plus a
  host-header rule → the `api-hg-webhook` target group).
- A DNS record at the custom domain: CNAME (or alias, if the zone is in Route
  53 in this account) to the platform ALB's DNS name.

This is a platform-side entry (`ecs.services`, `public: true`) like hub88's,
not something api-hg's CDK creates. api-hg only consumes the parameters the
platform publishes.

### 4. Wire api-hg to it

- Set `/<env>/api-hg-lambda/provider-webhook-url` to
  `https://<custom-domain>/api/v1/payments/webhook`. The functions already
  prefer it over the Function URL when present (`PROVIDER_WEBHOOK_URL`), so
  every new checkout and payout tells the provider to call the proxy.
- Register the same URL in the provider dashboard.
- The Function URL stays as it is: nginx needs it as upstream. It is not
  given to anyone.
- `ssm-status.sh`: `provider-webhook-url` becomes "NEEDED for the public
  webhook domain" and the new `/<env>/api-hg-webhook/*` platform rows are listed.

### What is not in this proposal

- No change to the webhook Lambda, its signature check or `_routes.ts`.
- No WAF, no rate limiting (can be added on the ALB later).
- No IAM auth on the Function URL (would require SigV4 signing in nginx).
  Hiding the Function URL and keeping the HMAC check is the protection.

## Open points to confirm before implementing

1. Platform entry: who adds `api-hg-webhook` to `ecs.services` with
   `public: true` and the custom certificate ARN. The platform repo is not in
   this workspace.
2. The custom domain name and where its DNS is managed.
3. ECR repository `api-hg-webhook-nginx`: created by the platform (as for
   hub88) or by `build.sh`.
