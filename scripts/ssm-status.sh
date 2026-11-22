#!/usr/bin/env bash
# Deployment readiness for api-hg in one environment.
#
# Usage: scripts/ssm-status.sh <env>
#
# Every row ends with one word that says what to do:
#   ok        set, nothing to do
#   MISSING   you must set it before `deploy:all` (bootstrap-ssm.sh or the platform)
#   NEEDED    deploy works without it, but the feature named will not; set it
#             before testing that feature (read at runtime, no redeploy)
#   default   not set, the default in the note is used; nothing to do
#   deploy    created by the deploy itself; nothing to do
#   ERROR     the lookup failed (credentials, region), the value is unknown
# The last lines are the verdict.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <env>" >&2
  exit 1
fi

ENV="$1"
ROOT="/${ENV}/api-hg-lambda"
REGION="${AWS_REGION:-us-east-1}"
BLOCKERS=0
NEEDED=0
ERRORS=0

# get <name> -> prints the value; returns 1 when unset/placeholder, 2 on lookup error
get() {
  local value rc
  value=$(aws ssm get-parameter --region "$REGION" --name "$1" \
            --query 'Parameter.Value' --output text 2>&1) && rc=0 || rc=$?
  if [[ $rc -ne 0 ]]; then
    if [[ "$value" == *ParameterNotFound* ]]; then return 1; fi
    printf '%s' "${value##*: }"; return 2
  fi
  if [[ -z "$value" || "$value" == "-" || "$value" == "None" ]]; then return 1; fi
  printf '%s' "$value"
}

# row <kind> <name> <note>
#   kind: required | needed:<feature> | default:<value> | deploy
row() {
  local kind="$1" name="$2" note="${3:-}" value rc
  value=$(get "$name") && rc=0 || rc=$?
  if [[ $rc -eq 2 ]]; then
    printf '  %-50s ERROR    %s\n' "$name" "$value"; ERRORS=$((ERRORS+1)); return
  fi
  if [[ $rc -eq 0 ]]; then
    printf '  %-50s ok       %s\n' "$name" "$value"; return
  fi
  case "$kind" in
    required)  printf '  %-50s MISSING  %s\n' "$name" "$note"; BLOCKERS=$((BLOCKERS+1)) ;;
    needed:*)  printf '  %-50s NEEDED   for %s. %s\n' "$name" "${kind#needed:}" "$note"; NEEDED=$((NEEDED+1)) ;;
    default:*) printf '  %-50s default  %s %s\n' "$name" "${kind#default:}" "$note" ;;
    deploy)    printf '  %-50s deploy   %s\n' "$name" "$note" ;;
  esac
}

secret() {
  local kind="$1" name="$2" note="${3:-}"
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$name" >/dev/null 2>&1; then
    printf '  %-50s ok\n' "$name"; return
  fi
  case "$kind" in
    required) printf '  %-50s MISSING  %s\n' "$name" "$note"; BLOCKERS=$((BLOCKERS+1)) ;;
    deploy)   printf '  %-50s deploy   %s\n' "$name" "$note" ;;
  esac
}

if ! caller=$(aws sts get-caller-identity --query Account --output text 2>&1); then
  echo "Cannot read SSM: AWS credentials are not usable." >&2
  echo "${caller}" >&2
  exit 1
fi

echo "api-hg deployment readiness: ${ENV}, ${REGION}, account ${caller}"
echo
echo "1. Platform (must exist; owned by the platform, not by this repo)"
row required "/${ENV}/VpcId"          "the functions and the database live in this VPC"
row required "/${ENV}/PrivateSubnet1" "database subnet 1"
row required "/${ENV}/PrivateSubnet2" "database subnet 2"
row required "/${ENV}/ClientSecurityGroupId"         "platform client group, attached to every function"
row required "/${ENV}/DatabaseClientSecurityGroupId" "admitted by the shared database cluster: api-security reads need it"
row "default:tracing off" "/${ENV}/MainOtelEndpoint"
secret required "${ENV}/JWTSecret" "the token secret shared with the authorizer"
row required "/${ENV}/ApiAuthDatabaseReadOnlyHost"     "api-auth reader endpoint: session check on every call (Session table)"
row required "/${ENV}/ApiAuthDatabasePort"             "api-auth port"
row required "/${ENV}/ApiAuthDatabaseName"             "api-auth database name"
secret required "${ENV}/ApiAuthDatabaseReadOnlySecret" "read-only credential of api-auth"
row required "/${ENV}/ApiSecurityDatabaseReadOnlyHost" "api-security reader endpoint: operator feature check"
row required "/${ENV}/ApiSecurityDatabasePort"         "api-security port"
row required "/${ENV}/ApiSecurityDatabaseName"         "api-security database name"
secret required "${ENV}/ApiSecurityDatabaseReadOnlySecret" "read-only credential of api-security"
echo
echo "2. Wallet (owned by wallet-lambda; deploy wallet-lambda first)"
WALLET_MODE=$(get "${ROOT}/wallet-mode" 2>/dev/null || echo lambda)
if [[ "$WALLET_MODE" == "http" ]]; then
  row required "${ROOT}/wallet-api-url" "wallet-mode is http: the wallet HTTP base URL"
else
  if get "${ROOT}/wallet-invoker-policy-arn" >/dev/null 2>&1; then
    row ok "${ROOT}/wallet-invoker-policy-arn"
  else
    row required "/${ENV}/api-wallet-lambda/invoker-policy-arn" "the functions cannot call the wallet without it (or set ${ROOT}/wallet-invoker-policy-arn)"
  fi
fi
echo
echo "3. Settings (scripts/bootstrap-ssm.sh <env>)"
row required "${ROOT}/provider-api-url"      "provider base URL"
row "needed:withdrawals" "${ROOT}/provider-account-id" "payout source account at the provider"
row "needed:deposits"    "${ROOT}/payments-return-url"  "front-self URL the hosted checkout returns the player to"
row "needed:deposits"    "${ROOT}/payments-cancel-url"  "same, when the player cancels"
row "default:AR"  "${ROOT}/payments-country"
row "default:ARS" "${ROOT}/payments-currency"
row "default:lambda" "${ROOT}/wallet-mode" "(lambda|http)"
row "default:${ENV}" "${ROOT}/wallet-env" "(environment whose wallet functions <env>-wallet-* are called)"
row "default:t4g.micro" "${ROOT}/db-instance-type" "RDS class of the payments database"
row "default:the webhook Function URL" "${ROOT}/provider-webhook-url"
row "default:ClientSecurityGroupId + DatabaseClientSecurityGroupId" "${ROOT}/lambda-sg-ids" "(override: up to two SG ids, comma separated)"
row "default:MainOtelEndpoint" "${ROOT}/otel-endpoint" "('none' disables tracing)"
secret required "${ENV}/HgSecrets" "created by bootstrap-ssm.sh (PROVIDER_API_TOKEN, PROVIDER_WEBHOOK_SECRET, WALLET_API_KEY)"
echo
echo "4. Public webhook on a custom domain (CloudFront; deploy:webhook-edge, separate from deploy:all)"
if WEBHOOK_DOMAIN=$(get "${ROOT}/webhook-domain"); then
  printf '  %-50s ok       %s\n' "${ROOT}/webhook-domain" "$WEBHOOK_DOMAIN"
  row required "${ROOT}/webhook-hosted-zone-id"   "Route 53 zone (this account) of ${WEBHOOK_DOMAIN}; the stack creates the certificate and the alias in it"
  row required "${ROOT}/webhook-hosted-zone-name" "zone name that goes with the id"
  if aws secretsmanager get-secret-value --region "$REGION" --secret-id "${ENV}/HgSecrets" --query SecretString --output text 2>/dev/null | grep -q '"WEBHOOK_EDGE_KEY":"[^"]'; then
    printf '  %-50s ok\n' "${ENV}/HgSecrets: WEBHOOK_EDGE_KEY"
  else
    printf '  %-50s MISSING  run scripts/bootstrap-ssm.sh %s again (adds the key, keeps the rest)\n' "${ENV}/HgSecrets: WEBHOOK_EDGE_KEY" "$ENV"; BLOCKERS=$((BLOCKERS+1))
  fi
  if [[ "$REGION" != "us-east-1" ]]; then
    printf '  %-50s MISSING  the edge stack deploys in us-east-1 only (CloudFront certificates); current region %s\n' "region" "$REGION"; BLOCKERS=$((BLOCKERS+1))
  fi
  row deploy "${ROOT}/webhook-public-url" "the URL to register in the provider dashboard (deploy:webhook-edge)"
else
  printf '  %-50s default  not configured: the webhook Function URL is used as is\n' "${ROOT}/webhook-domain"
fi
echo
echo "5. Created by deploy:all (nothing to do before the first deploy)"
row deploy "${ROOT}/player-invoker-policy-arn"   "then attach it to front-self's task role"
row deploy "${ROOT}/operator-invoker-policy-arn" "then attach it to the back-office's task role"
row deploy "${ROOT}/db-host"
row deploy "${ROOT}/db-port"
row deploy "${ROOT}/db-name"
row deploy "${ROOT}/db-secret-name"
row deploy "${ROOT}/db-sg-id"
row deploy "${ROOT}/webhook-function-url"        "then register it in the provider dashboard"
secret deploy "${ENV}/HgDatabase/postgres"       "generated by the database stack"
echo
echo "Verdict"
if [[ $ERRORS -gt 0 ]]; then
  echo "  ${ERRORS} lookup(s) failed: fix credentials/region and run again."
  exit 1
fi
if [[ $BLOCKERS -gt 0 ]]; then
  echo "  NOT READY: ${BLOCKERS} MISSING row(s) above must be set before deploy:all."
  exit 1
fi
echo "  READY to deploy: cd cdk && envName=${ENV} npm run deploy:all"
if [[ $NEEDED -gt 0 ]]; then
  echo "  After deploy: ${NEEDED} NEEDED row(s) above before testing the named feature (runtime values, no redeploy)."
fi
