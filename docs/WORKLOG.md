# Worklog — api-hg (payments)

Running log of what was built and why. Dates are 2026-11-16 unless noted.

## Decisions

* **Architecture copied from api-engagement / wallet-lambda**: route table,
  handler wrapper with JWT audiences, envelope + redaction, one Lambda per
  route, HTTP runtime for Kubernetes/local, CDK one-stack-per-function.
* **Own database**, Aurora Serverless v2 (`<env>-hg-postgres`), tables
  `payment`, `payment_event`, `webhook_inbox`, `payment_settings`. The wallet
  DB is never opened (user requirement); the wallet is used only through
  `parties-get`, `operations-create`, `operations-transition` with a service
  `x-api-key`.
* **Wallet mapping**: deposit = `CREDIT/deposit` (PENDING on create, COMPLETE
  to credit, CANCEL to drop); withdrawal = `DEBIT/withdrawal` (blocks on
  create, COMPLETE when the bank transfer is done, CANCEL to release). Both
  pairs exist in the wallet's state machines (`PENDING → COMPLETE | CANCEL`).
* **Holds** per tenant (`rootOf(chain)`): `holdDeposits` /
  `holdDepositsAbove`, `holdWithdrawals` (default on) / `holdWithdrawalsAbove`,
  plus min/max limits and `maxOpenWithdrawals`. Root operators edit them.
* **Provider (hg.cash)**: checkouts for deposits (`POST /checkouts`, hosted
  `checkoutUrl`, statuses pending / awaiting_manual_review / completed /
  rejected / cancelled / expired), transaction requests for withdrawals
  (`POST /transactions` with `toCBU`/`toCVU`, statuses PENDING /
  AWAITING_REVIEW / PROCESSING / DONE / ERROR / CANCELLED), webhook signed
  `X-HG-Webhook-Signature: sha256=<hmac>` over the raw body. Argentina (ARS)
  first; `PAYMENTS_COUNTRY` is a setting.
* **Webhook idempotency**: `webhook_inbox.dedupe_key` = sha256 of the raw
  body; a repeat answers 200 without side effects. Missed webhooks are covered
  by the on-read re-check (`payments-get`, pending deposits older than
  `PAYMENTS_RECHECK_AFTER_MS`) and `admin-reconcile`.
* **Naming**: the service is `api-hg` (repo name) in every internal
  identifier (functions `<env>-hg-*`, SSM `/<env>/api-hg-lambda`, secret
  `<env>/HgSecrets`, env `API_HG_URL`/`API_HG_MODE` in the front-ends). The
  feature flag in both front-ends is `PAYMENTS_ENABLED`. Nothing visible to a
  player names the provider or any infrastructure (user requirement).
* **Previews first** (user requirement): front-self and backoffice render the
  cashier with canned data under `API_HG_MODE=mock`; the local shim is this
  service's HTTP runtime (`npm run server`) reached with `API_HG_MODE=http`.
* **Nothing deployed.** No `cdk deploy`, no containers started by the
  assistant. Front-self changes are uncommitted because that checkout has no
  git history on this machine; backoffice committed on branch `payments`.

## 2026-11-16 (later): limits, blocks, provider separation, document hash

* `payment` is provider-agnostic (`provider` column); the provider's reference,
  status, hosted page URL and raw payload moved to `payment_provider`.
  `_domain/providers/` has the `PaymentProvider` interface (`index.ts`), the
  hg.cash implementation (`hg.ts`) and the sandbox (`sandbox.ts`);
  `PAYMENT_PROVIDER` selects the implementation.
* Per-player limits (`player_limits`): per-request min/max and rolling
  daily/weekly/monthly caps for deposits and withdrawals, plus
  `maxOpenWithdrawals`; tenant settings got the six window caps as defaults.
  A refused amount is a generic `LIMIT_EXCEEDED` ("This amount is not
  available right now"); the rule that fired is logged, never returned.
* Per-player blocks (`player_block`): deposit / withdrawal / all, permanent or
  until a date (`days` or `until`), lifted early by an operator. A blocked
  request is `BLOCKED` (403) and the player is told to contact support.
* `document_hash`: HMAC-SHA256(normalised national id, `DOCUMENT_HASH_KEY`)
  stored on deposits (payer document) and withdrawals (optional `document`);
  the raw id is forwarded to the provider when needed and never stored.
* `client` (`{ ip, userAgent }`) recorded on every request from the
  `x-player-*` headers front-self forwards.
* Operators can cancel a `pending` deposit (`admin-payments-cancel`).
* Local sandbox tables (`sandbox_*`) and `WALLET_MODE=mock`; sandbox page gated
  by `SANDBOX_ENABLED=1`. Existing test data was dropped by migration 005.

## Built

* `lambdas/_routes.ts` — 13 routes + audiences; `webhook` has `publicUrl`.
* `_common`: auth/handler/errors/response/redact/http/token/logger/validate
  (from api-engagement), `config.ts`, `db.ts`, `input.ts`.
* `_domain`: `types.ts`, `settings.ts`, `wallet.ts`, `provider.ts`,
  `payments.ts`, `webhook.ts`.
* Handlers for every route, `migrate` function, `server/` runtime,
  `sql/001_init.sql`, `scripts/migrate.ts`, `scripts/bootstrap-ssm.sh`,
  `deploy/Dockerfile`, `infra/docker-compose.yml`, `.env.example`.
* CDK: `config.ts`, `resource-group-stack.ts` (player/operator invoker
  policies), `database-stack.ts`, `function-stack.ts` (exec role, DB ingress,
  wallet invoker policy, webhook Function URL, migrate bundling of `sql/`),
  `bin/app.ts`. Synthesised with a fake account: resource group, webhook and
  migrate stacks render; not deployed.
* Tests: 20 unit tests (auth/handler, holds, signature, cursor, views, input
  readers, router) — `npm test` passes.
* Docs: `LAMBDA_API.md`, `README.md`, `CLAUDE.md`, `infra/README.md`.

## Front-ends

* front-self (branch `payments`, uncommitted): `src/lib/payments.ts`,
  `src/lib/api/payments/*`, `/api/payments/*` routes,
  `src/components/payments/*`, pages `/wallet/deposit`, `/wallet/withdraw`,
  `/wallet/deposit/return`, drawer blades, `PaymentsProvider` in the app
  layout, styles, es/pt strings, `docs/payments.md`, CLAUDE.md note.
* backoffice (branch `payments`, committed by the backoffice session):
  Payments menu + `/payments` list/detail (approve/reject), `/payments/settings`,
  reconcile button, mock mode, `docs/payments.md`.

## Open items / assumptions to confirm

* A wallet user + `x-api-key` with features for `parties-get`,
  `operations-create`, `operations-transition` must be provisioned per env
  (`WALLET_API_KEY`).
* hg.cash: one operative ARS account; register the webhook URL and signing
  secret in the dashboard. Payer document is optional in the forms; AR
  checkouts match transfers by DNI, so operators may want it mandatory
  (toggle later).
* `payments-get` re-checks the provider on read; a scheduled reconcile is not
  wired (operators have the button).
* Deposit `rejected` after payment: money stays with the operator's provider
  account; refund is manual and recorded in the event trail.

## 2026-11-16 — scripts/ssm-status.sh

Added `scripts/ssm-status.sh <env>` (same shape as auth-lambda/wallet-lambda): platform rows, the wallet invoker policy, app-owned rows from bootstrap-ssm.sh, rows written by the deploy (invoker policies, db-*, webhook-function-url) and the three secrets. PENDING vs ERROR kept distinct; fails once on unusable credentials.

## 2026-11-17 — database: provisioned RDS instead of Aurora Serverless v2

`cdk/lib/database-stack.ts` now creates a provisioned RDS Postgres 16 instance (`db.t4g.micro`, 20 GB gp3, single AZ; prod `db.t4g.small` Multi-AZ via `cdk.json` context `paymentsDatabase`). User chose it over Serverless v2 for cost: the service runs 24h at low load, where the 0.5 ACU floor (~$44/month) costs about four times a t4g.micro (~$12/month). Same SSM outputs (`db-host`, `db-port`, `db-name`, `db-secret-name`, `db-sg-id`); function stacks unchanged. Not deployed.

Instance class moved to SSM `/<env>/api-hg-lambda/db-instance-type` (bootstrap-ssm.sh `DB_INSTANCE_TYPE`, default t4g.micro); `cdk.json` keeps storage/Multi-AZ/backups only.

## 2026-11-17 — public webhook on CloudFront (custom domain)

New `cdk/lib/edge-stack.ts` (`<env>-HgWebhookEdge`; always defined, deployed only by `deploy:webhook-edge`, excluded from `deploy:all`, which now selects `<env>-ApiHg*` + `<env>-HgDatabase`; the user rejected making a stack's existence depend on a parameter value): CloudFront distribution with the webhook Function URL as origin, caching disabled, all viewer headers + body forwarded, response headers policy removing `x-amzn-*`/`Server`, CloudFront function answering 403 for any path other than the webhook route, custom domain with the ACM certificate created and DNS-validated by the stack in the Route 53 zone `webhook-hosted-zone-id`/`-name` (user: certificates are infra, not an input), alias record included; stack must deploy in us-east-1. Publishes `webhook-public-url`. CloudFront sends `x-webhook-edge-key` = HgSecrets.WEBHOOK_EDGE_KEY; the webhook function (env `WEBHOOK_EDGE_REQUIRED=1`, set by the CDK when a domain is configured) refuses requests without it, so the Function URL is not usable directly. Functions get `PROVIDER_WEBHOOK_URL=https://<domain>/api/v1/payments/webhook` unless `provider-webhook-url` overrides. `bootstrap-ssm.sh` takes WEBHOOK_DOMAIN / WEBHOOK_HOSTED_ZONE_ID / WEBHOOK_HOSTED_ZONE_NAME and adds missing keys (WEBHOOK_EDGE_KEY) to an existing HgSecrets without touching other values. `ssm-status.sh` section 4 checks it. The ECS/nginx proposal in docs/proposals is superseded. Not deployed, not committed.

## 2026-11-17 — security: session, features, account, caller token

User: "this module is handling money so security checks are really important".
- `_common/session.ts`: per-call `Session` check in api-security (active, unexpired; 10 s grace for a fresh token; 30 s per-container cache; fails closed with 500 `PERMISSIONS_UNAVAILABLE`).
- `_common/permissions.ts`: role features `(api-hg, resource, method)` for every operator route that is not a GET (`requiresFeature` in `_routes.ts`); same join as the platform authorizer; 60 s cache.
- `paymentsHandler(slug, run)`: audience and feature come from `_routes.ts`; all `lambdas/*/index.ts` updated. Checks can be skipped only with `PROVIDER_MODE=mock` + `SANDBOX_SKIP_SECURITY_DB=1` (local shim).
- `_common/db.ts`: second read-only connection `security` (`SECURITY_DB_*`); CDK sets host/port/name from the platform's `ApiSecurityDatabase*` parameters and grants `ApiSecurityDatabaseReadOnlySecret`.
- `_domain/wallet.ts`: `WalletAuth` on every call — caller's JWT forwarded; `SERVICE` (`x-api-key`) only from the webhook path. `WALLET_API_TOKEN` removed everywhere. `accountFor(partyId, accountId, auth)`: the account must belong to the token's party, else 403.
- `deposits-create` / `withdrawals-create`: `accountId` required in the body (`input.accountId`).
- `ssm-status.sh`: api-security platform rows + secret required. Docs: LAMBDA_API "Security, on every call", README, infra inventory, CLAUDE rules. Tests: `tests/unit/security.test.ts`.
- front-self: the forms send the player's account id (`CurrentUser.accountId`).
Not committed, not deployed.

- Deposits no longer create a wallet operation at request time (the player's
  token lacks the wallet feature and a pending credit was unwanted). The
  operation is created and completed together in `completeDeposit`, as the
  service, when the provider confirms. Withdrawals unchanged (block at creation).

- Checkouts no longer send `accountId` (the provider binds the account to a
  country and rejected it); payouts still do.
- New table `provider_log` (sql/008, needs `npm run migrate`): every call to
  the provider and every webhook delivery, bodies masked (`maskBody` in
  `_common/http.ts`). `admin-payments-get` returns them as `logs`.
  `LAMBDA_API.md` documents `logs` and the return/cancel URL behaviour for the
  player UI.

- Functions now carry both platform client groups by default
  (`ClientSecurityGroupId` + `DatabaseClientSecurityGroupId`, read at deploy
  time, not cached). Without the second one the api-security session check
  could not reach the shared cluster and every call failed closed with
  `PERMISSIONS_UNAVAILABLE`. All function stacks redeploy once.

- Session check now reads the `Session` table where it lives, the api-auth
  database (`AUTH_DB_*` from `/<env>/ApiAuthDatabaseReadOnly*`, secret
  `<env>/ApiAuthDatabaseReadOnlySecret`); api-security stays for the operator
  feature check. New required rows in ssm-status. All function stacks redeploy.

- Recovery for every failure path. Wallet operations: all changes run as the
  service; `createOrFind` and `ensureTransition` make repeats idempotent
  (operations-find by `pay-<id>`). Payouts: `processing` is written before the
  provider call; failures are classified by the provider (`payoutFailure`:
  refused / duplicate / unknown); unknown or duplicate keeps the money blocked
  and the re-check re-sends (external id unique per account at the provider);
  webhooks attach a missing reference by `externalID` / `data.paymentId`;
  new `admin-payments-resolve` for the operator. Final provider statuses are
  re-applied while the row is open. Failed webhook deliveries are reprocessed
  on the provider's retry. `UpstreamError` carries the provider error code.

- Settings: `withdrawalAccountId` (sql/009) picks the provider account the
  transfers are paid from, per tenant. A payout refused for insufficient funds
  at the provider puts the withdrawal back to `awaiting_approval` (money still
  blocked) instead of failing it.

- Withdrawal queue (sql/010). Approved or never-held withdrawals are `queued`
  (player sees `processing`), never sent on approve. `queue-run` (new function,
  EventBridge every minute; HTTP runtime timer) pays each tenant's queue from
  the provider account balance (`GET /account/{id}/balance`, `netBalance`) in
  `priority` order (steps of 1000) per `withdrawalQueueMode`:
  `fifo_stop_on_fail` | `fit`. Provider funds refusal returns the row to
  `queued` at its place (`PROVIDER_FUNDS`), replacing the back-to-approval rule
  and the 422 on approve. New operator routes `admin-queue-list`,
  `admin-queue-run`, `admin-payments-prioritize`; reject accepts `queued`.
  Settings: `depositAccountId` (sent to the provider only when set) and
  `withdrawalQueueMode`. Deploy: `deploy:all` (new stacks + routes), `migrate`,
  Feature rows for the three new operator routes.

- CDK: SSM values (plain env, security groups, OTel endpoint, wallet invoker
  policy ARN) are resolved inside each function stack instead of once in the
  resource-group scope. Before, they were cross-stack exports of
  `<env>-ApiHgResourceGroup`, and CloudFormation refused to change an export
  in use, so editing any `payments-*` / `provider-*` parameter blocked every
  deploy. The resource group now deploys after the function stacks (needed
  once to drop the exports; harmless afterwards).
