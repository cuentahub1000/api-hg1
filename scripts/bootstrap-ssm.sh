#!/usr/bin/env bash
# Write the app-owned SSM parameters the CDK app reads, and create the
# HgSecrets secret skeleton. Idempotent: existing values are kept unless
# --overwrite is given.
#
#   scripts/bootstrap-ssm.sh <env> [--overwrite]
#
# Values are taken from the environment (set them before running):
#   PROVIDER_API_URL PROVIDER_ACCOUNT_ID PAYMENTS_COUNTRY PAYMENTS_CURRENCY
#   PAYMENTS_RETURN_URL PAYMENTS_CANCEL_URL
#   PROVIDER_WEBHOOK_URL   (optional: only when an ingress fronts the HTTP runtime;
#                           otherwise the webhook Lambda's Function URL is used)
#   WALLET_MODE (lambda|http) WALLET_ENV (optional: another environment's wallet) WALLET_API_URL
#   WALLET_INVOKER_POLICY_ARN (optional override; default /<env>/api-wallet-lambda/invoker-policy-arn)
#   LAMBDA_SG_IDS OTEL_ENDPOINT (optional)
#   DB_INSTANCE_TYPE (RDS class of the payments database; default t4g.micro)
#   WEBHOOK_DOMAIN WEBHOOK_HOSTED_ZONE_ID WEBHOOK_HOSTED_ZONE_NAME
#       public webhook on CloudFront (deploy:webhook-edge): the custom domain and the
#       Route 53 zone (in this account) it belongs to; certificate and alias are created by the stack
#   PROVIDER_API_TOKEN PROVIDER_WEBHOOK_SECRET WALLET_API_KEY   (secret; WALLET_API_KEY = x-api-key of the
#       integration user, used by the webhook only — every other wallet call forwards the caller's JWT)
#   DOCUMENT_HASH_KEY WEBHOOK_EDGE_KEY are generated when absent (secret)
#
# NOT written here, platform-owned, must exist before any `cdk deploy`:
#   /<env>/VpcId /<env>/PrivateSubnet1 /<env>/PrivateSubnet2
#   /<env>/ClientSecurityGroupId (optional)   <env>/JWTSecret (secret)
#   /<env>/ApiSecurityDatabaseReadOnlyHost /<env>/ApiSecurityDatabasePort /<env>/ApiSecurityDatabaseName
#   <env>/ApiSecurityDatabaseReadOnlySecret (secret)   — api-security, read for session + feature checks
# Written by the database stack, not here: db-host db-port db-name db-secret-name db-sg-id.
set -euo pipefail

ENV_NAME="${1:?usage: $0 <env> [--overwrite]}"
OVERWRITE="${2:-}"
ROOT="/${ENV_NAME}/api-hg-lambda"

put() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then echo "skip  ${ROOT}/${name} (empty)"; return; fi
  if [[ "$OVERWRITE" != "--overwrite" ]] && aws ssm get-parameter --name "${ROOT}/${name}" >/dev/null 2>&1; then
    echo "keep  ${ROOT}/${name}"; return
  fi
  aws ssm put-parameter --name "${ROOT}/${name}" --type String --value "$value" --overwrite >/dev/null
  echo "write ${ROOT}/${name}"
}

put provider-api-url          "${PROVIDER_API_URL:-https://hg.cash/api/v1}"
put provider-account-id       "${PROVIDER_ACCOUNT_ID:-}"
put provider-webhook-url      "${PROVIDER_WEBHOOK_URL:-}"
put payments-country          "${PAYMENTS_COUNTRY:-AR}"
put payments-currency         "${PAYMENTS_CURRENCY:-ARS}"
put payments-return-url       "${PAYMENTS_RETURN_URL:-}"
put payments-cancel-url       "${PAYMENTS_CANCEL_URL:-}"
put wallet-mode               "${WALLET_MODE:-lambda}"
put wallet-env                "${WALLET_ENV:-}"
put wallet-api-url            "${WALLET_API_URL:-}"
put wallet-invoker-policy-arn "${WALLET_INVOKER_POLICY_ARN:-}"
put lambda-sg-ids             "${LAMBDA_SG_IDS:-}"
put otel-endpoint             "${OTEL_ENDPOINT:-}"
put db-instance-type          "${DB_INSTANCE_TYPE:-t4g.micro}"
put webhook-domain            "${WEBHOOK_DOMAIN:-}"
put webhook-hosted-zone-id    "${WEBHOOK_HOSTED_ZONE_ID:-}"
put webhook-hosted-zone-name  "${WEBHOOK_HOSTED_ZONE_NAME:-}"

SECRET_NAME="${ENV_NAME}/HgSecrets"
SECRET_JSON=$(printf '{"PROVIDER_API_TOKEN":"%s","PROVIDER_WEBHOOK_SECRET":"%s","WALLET_API_KEY":"%s","DOCUMENT_HASH_KEY":"%s","WEBHOOK_EDGE_KEY":"%s"}' \
  "${PROVIDER_API_TOKEN:-}" "${PROVIDER_WEBHOOK_SECRET:-}" "${WALLET_API_KEY:-}" "${DOCUMENT_HASH_KEY:-$(openssl rand -hex 32)}" "${WEBHOOK_EDGE_KEY:-$(openssl rand -hex 32)}")
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  if [[ "$OVERWRITE" == "--overwrite" ]]; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
    echo "write secret ${SECRET_NAME}"
  else
    # Keep every existing value; add only the keys the secret does not have yet.
    CURRENT=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text)
    MERGED=$(node -e 'const cur=JSON.parse(process.argv[1]),add=JSON.parse(process.argv[2]);const out={...cur};const added=[];for(const k of Object.keys(add)){if(!(k in cur)){out[k]=add[k];added.push(k)}}process.stdout.write(JSON.stringify({out,added}))' "$CURRENT" "$SECRET_JSON")
    ADDED=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).added.join(" "))' "$MERGED")
    if [[ -n "$ADDED" ]]; then
      node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).out))' "$MERGED" \
        | aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string file:///dev/stdin >/dev/null
      echo "add   secret ${SECRET_NAME} keys: ${ADDED}"
    else
      echo "keep  secret ${SECRET_NAME}"
    fi
  fi
else
  aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
  echo "create secret ${SECRET_NAME}"
fi
