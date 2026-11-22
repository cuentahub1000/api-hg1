# Running the functions locally (the Lambda shim)

`local/server.cts` answers Lambda `Invoke` and Secrets Manager
`GetSecretValue` on `127.0.0.1:9500` and runs the real handlers in-process,
exactly like auth-lambda's `local/`. The front-ends switch hg to lambda mode
and point only the hg client at it.

```sh
cp local/lambda.env.example local/lambda.env      # fill JWT_SECRET, PROVIDER_ACCOUNT_ID, wallet settings
cp local/secrets.example.json local/secrets.json  # fill PROVIDER_API_TOKEN, PROVIDER_WEBHOOK_SECRET, WALLET_API_KEY
docker compose -f infra/docker-compose.yml up -d  # Postgres on 5433
npm run migrate:local                             # tables
npm run local                                     # http://127.0.0.1:9500, restarts when lambdas/ changes
```

## Pointing front-self and the back-office at it

```sh
PAYMENTS_ENABLED=true
API_HG_MODE=lambda
API_HG_LAMBDA_ENDPOINT=http://127.0.0.1:9500
LAMBDA_ENV_NAME=local
```

`ENV_NAME` / `LAMBDA_ENV_NAME` keep whatever value they have: the shim matches
`-hg-<slug>` by suffix. Nothing else changes: the other services keep their
mode, and the auth shim on 9400 (`AWS_ENDPOINT_URL_LAMBDA`) keeps working at
the same time.

## Smoke test

```sh
curl -s http://127.0.0.1:9500/            # functions and secrets served
local/invoke.sh admin-settings-get        # tests/events/admin-settings-get.json (replace <jwt>)
```

## Provider webhook locally

hg.cash cannot reach your machine. `POST http://127.0.0.1:9500/webhook` takes
the same body and `X-HG-Webhook-Signature` header the provider sends (sign it
with `PROVIDER_WEBHOOK_SECRET`), or expose the port with a tunnel and put
that URL in `PROVIDER_WEBHOOK_URL`.
