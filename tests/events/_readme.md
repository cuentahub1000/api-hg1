Sample invocation payloads, one per function. Replace `<jwt>` with a token
minted by `login-auth` for a player (deposits-*, withdrawals-*, payments-*) or
an operator (admin-*). `webhook.json` is unsigned: a real call carries
`X-HG-Webhook-Signature: sha256=<hmac>` over the raw body.

    aws lambda invoke --function-name <env>-hg-payments-list \
      --payload fileb://tests/events/payments-list.json /dev/stdout
