# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

```sh
npm run build                 # tsc --noEmit (also `npm run lint`)
npm test                      # compile tests to dist-test/, run node --test
npm run migrate               # apply sql/*.sql to the DB in .env
npm run server                # HTTP runtime (local shim / Kubernetes) on $PORT
cd cdk && npm install && envName=<env> npm run synth
docker build -f deploy/Dockerfile -t api-hg:dev .
```

Tests compile before running (CommonJS package). `esbuild` stays in the root
devDependencies: the CDK `NodejsFunction` bundles from the repo root.

## What this is

The payments service: deposits (hosted checkout) and withdrawals (bank
transfer) through hg.cash, with holds for operator approval. Called by the
player app (`../front-self`, `API_HG_MODE`) and the back-office
(`../backoffice`) with the caller's platform JWT. `lambdas/_routes.ts` is the
source of truth for endpoints and audiences; `server/index.ts` imports every
handler explicitly. Contract: `LAMBDA_API.md`.

## Rules that must hold

* **Four checks on every JWT call, in `_common/handler.ts`:** signature, open
  session (api-auth `Session`), audience, and for operator writes the
  role feature `(api-hg, resource, method)` (`_common/permissions.ts`). Never
  add a route that skips them; the only switch-off is the local sandbox
  (`PROVIDER_MODE=mock` + `SANDBOX_SKIP_SECURITY_DB=1`).
* **The wallet acts as the caller.** `_domain/wallet.ts` takes a `WalletAuth`
  on every call: the caller's JWT for anything done for a player or operator,
  `SERVICE` (the `x-api-key`) only from the webhook path. Never use the
  service key for a call that has a caller behind it.
* **Account from the request, party from the token.** `accountId` is required
  on deposits and withdrawals and must belong to the token's party
  (`wallet.accountFor`). Never pick an account for the caller.
* **api-auth and api-security are read only.** `auth` in `_common/db.ts` runs
  SELECTs on api-auth's `Session`; `security` on api-security's `User`, `Role`,
  `Feature` and their join tables. Nothing else, never a write.

* **Identity only from the JWT.** Players act on `ctx.partyId`; operators on
  their subtree (`listRows` / `rowFor` in `_domain/payments.ts`). Never read a
  party or account id from a player request.
* **Wallet via API only.** `_domain/wallet.ts` is the single integration
  point (parties-get, operations-create, operations-transition). Never
  connect to the wallet database.
* **Money moves in the wallet, state lives here.** Deposit credits only on
  `completed`; withdrawals block at creation; every leave-without-money path
  cancels the wallet operation. Keep that mapping in `payments.ts`.
* **Credentials stay here.** Provider token, webhook secret, wallet key and
  DB password come from env or Secrets Manager (`_common/config.ts`,
  `_common/db.ts`); never returned, never logged.
* **Errors say nothing about the inside.** Throw `PaymentsError` subclasses;
  the envelope redacts. Player-facing text never names the provider.
* **Infrastructure is inventoried.** New component, URL, secret or parameter
  → `infra/README.md`, `cdk/lib/config.ts`, `scripts/bootstrap-ssm.sh`, `scripts/ssm-status.sh`.

## Repo boundaries

Only this repo, `../front-self` and `../backoffice` may be modified.
`../wallet-lambda` and every other sibling are read-only reference. Documents
stay local files.
