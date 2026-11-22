#!/usr/bin/env bash
# Invoke one function through the local shim, the way front-self would.
#   local/invoke.sh <slug> [event.json | -]
set -euo pipefail
cd "$(dirname "$0")/.."
slug=${1:?usage: local/invoke.sh <slug> [event.json | -]}
event=${2:-tests/events/$slug.json}
port=${LOCAL_LAMBDA_PORT:-$(grep -E '^LOCAL_LAMBDA_PORT=' local/lambda.env 2>/dev/null | cut -d= -f2-)}
port=${port:-9500}
[ "$event" = "-" ] && data="@-" || data="@$event"
headers=$(mktemp); trap 'rm -f "$headers"' EXIT
body=$(curl -sS -D "$headers" -H 'content-type: application/json' -H 'x-amz-invocation-type: RequestResponse' --data-binary "$data" \
  "http://127.0.0.1:${port}/2015-03-31/functions/local-hg-${slug}/invocations")
grep -qi '^x-amz-function-error:' "$headers" && echo "FUNCTION ERROR (handler raised):" >&2
if command -v jq >/dev/null 2>&1; then printf '%s' "$body" | jq . 2>/dev/null || printf '%s\n' "$body"; else printf '%s\n' "$body"; fi
