# api-hg1

Deposits and withdrawals for the player platform through hg.cash: hosted
checkouts for deposits, bank transfers (CBU/CVU) for withdrawals. One AWS
Lambda per endpoint (`<env>-hg-<slug>`), or the same handlers as one HTTP
service. Same event/envelope contract as `wallet-lambda` and `api-engagement`.

For **calling** it, see [`LAMBDA_API.md`](LAMBDA_API.md). This file is about
working on it. Infrastructure is inventoried in [`infra/README.md`](infra/README.md);
decisions and progress in [`docs/WORKLOG.md`](docs/WORKLOG.md).

## What it does

* A **deposit** opens a pending wallet deposit and a hosted checkout. The
  player pays on the provider's page; the provider's webhook (or a re-check)
  marks it paid. Money reaches the balance only when the deposit is
  `completed` — immediately, or after an operator approves it when holds are
  on.
* A **withdrawal** blocks the amount in the wallet the moment the request is
  accepted, then waits for an operator (default) or goes straight to the bank
  transfer. `completed` finalises the wallet operation; `rejected`, `failed`
  and `cancelled` release the blocked amount.
* **Holds and limits** are per tenant (root of the chain) and editable from
  the back-office (`admin-settings-*`).

The wallet is reached **only through its API** (`parties-get`,
`operations-create`, `operations-transition`) with this service's own wallet
credential. This service owns its own Postgres (`payment`, `payment_event`,
`webhook_inbox`, `payment_settings`) and nothing else's.

## Layout

```
lambdas/
  _routes.ts        the endpoints (slug, method, resource, audience) — source of truth
  _common/          auth (JWT), handler wrapper, envelope, redaction, http, db, config, input readers
  _domain/
    types.ts        statuses, row shape, player/operator views
    payments.ts     the lifecycle: create, approve, reject, cancel, webhook/re-check transitions
    settings.ts     per-tenant holds and limits
    wallet.ts       the wallet client (lambda invoke or http, x-api-key)
    provider.ts     the hg.cash client (checkouts, payouts, webhook signature)
    webhook.ts      webhook intake: HMAC, inbox, dispatch
  <slug>/index.ts   one file per function; migrate/ applies sql/; queue-run/ pays the withdrawal queue (scheduled, no route)
server/             HTTP runtime (Kubernetes / local shim)
sql/                migrations, applied in name order once
cdk/                one stack per function + resource group (invoker policies) + database
scripts/            bootstrap-ssm.sh, ssm-status.sh, migrate.ts
infra/              docker-compose for a local Postgres; README = inventory
tests/unit, tests/events
```

## Working on it

```sh
npm install
npm run build          # tsc --noEmit
npm test               # compiles to dist-test/, node --test (20 unit tests, no database)
```

### Local shim

Run the HTTP runtime locally and point a front-end at it with
`API_HG_MODE=http` + `API_HG_URL=http://localhost:8080` (the other services
stay on whatever mode they have):

```sh
cp .env.example .env                                # fill JWT_SECRET, PROVIDER_*, WALLET_API_KEY
docker compose -f infra/docker-compose.yml up -d    # Postgres on 5433
npm run migrate
npm run server
```

`JWT_SECRET` must be the secret the front-end's tokens are signed with
(front-self in `AUTH_MOCK` signs with `AUTH_MOCK_JWT_SECRET` /
`NEXTAUTH_SECRET`). The wallet is reached in `WALLET_MODE=lambda` with the
shell's AWS credentials, or `http` against a wallet URL. Without a provider
token deposits and withdrawals answer 503 `NOT_CONFIGURED`; the front-ends'
`API_HG_MODE=mock` previews the screens without this service at all.

### Security

Every JWT call: signature, open session (api-auth), audience, and for
operator writes the role feature `(api-hg, resource, method)`; chain scope
on operator reads and decisions; `accountId` required and owned by the
caller on deposits and withdrawals; wallet calls carry the caller's JWT, the
webhook alone uses the service `x-api-key`. Details in `LAMBDA_API.md`
("Security, on every call"). Feature rows to seed in api-security: one per
operator write route in `lambdas/_routes.ts`, resource and method as listed.

### Deploying (AWS)

```sh
scripts/bootstrap-ssm.sh <env>        # app-owned SSM parameters + <env>/HgSecrets
scripts/ssm-status.sh <env>           # what is set, what is PENDING
cd cdk && npm install                 # root dependencies (esbuild) are installed by synth/deploy:all themselves
envName=<env> npm run synth
envName=<env> npm run deploy:all       # database -> webhook -> functions -> resource group, 4 stacks at a time; deploys only
envName=<env> npm run migrate          # separate, explicit step: invokes <env>-hg-migrate to apply sql/
```

The public webhook on a custom domain is its own stack, `<env>-HgWebhookEdge`,
deployed only by `envName=<env> npm run deploy:webhook-edge` and never by
`deploy:all`. It needs `webhook-domain`, `webhook-hosted-zone-id` and
`webhook-hosted-zone-name` (bootstrap `WEBHOOK_DOMAIN`,
`WEBHOOK_HOSTED_ZONE_ID`, `WEBHOOK_HOSTED_ZONE_NAME`), fails with a message
when they are missing, and deploys in us-east-1 only. It creates the ACM
certificate (DNS-validated in that zone), the CloudFront distribution on that
domain in front of the webhook Function URL, and the alias record. Order: set the two values, deploy the
edge, then `deploy:all` so the functions pick the public URL up. The functions
then give the provider `https://<domain>/api/v1/payments/webhook`
(`/<env>/api-hg-lambda/webhook-public-url`), the Function URL refuses calls
that do not come through CloudFront, and Lambda's headers never reach the
caller.

`deploy:all` never touches the database schema; `npm run migrate` is the only
thing that does, and you run it yourself. The webhook stack prints
the public Function URL to register in the provider dashboard together with
the signing secret. Attach `/<env>/api-hg-lambda/player-invoker-policy-arn`
to front-self's task role and `operator-invoker-policy-arn` to the
back-office's.

## Rules that must hold

* Identity only from the JWT; operators are scoped to their chain subtree in
  SQL (`chain = fullChain OR chain LIKE fullChain-%`).
* The wallet database is never opened. Any money movement is a wallet
  operation created or transitioned through the wallet API.
* Credentials (provider token, webhook secret, wallet key, DB password) are
  read by `_common/config.ts` / `_common/db.ts` from env or Secrets Manager,
  never returned, never logged.
* Errors say nothing about the inside: `PaymentsError` subclasses, redaction
  at the envelope, upstream bodies to the log only. Players never see the
  provider's name; `UpstreamError` products are "payment provider" and
  "wallet".
* Every state change writes a `payment_event`; the webhook inbox keeps every
  delivery (deduplicated by body hash).
