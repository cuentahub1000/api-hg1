-- Every exchange with the payment provider, masked, for the back-office trail:
-- the requests this service sends (with their responses) and the webhooks the
-- provider sends back. Sensitive values are replaced by "[redacted]" before
-- the row is written; nothing here is ever shown to a player.
CREATE TABLE IF NOT EXISTS provider_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,                                  -- request | webhook
  provider    text NOT NULL,
  payment_id  uuid REFERENCES payment (id) ON DELETE CASCADE, -- null when a webhook names no known payment
  method      text,                                           -- request only
  path        text,                                           -- request only
  status      integer,                                        -- request: provider's HTTP status (0 = unreachable); webhook: our answer
  ms          integer,
  request     jsonb,                                          -- masked body we sent / masked body we received
  response    jsonb,                                          -- masked body we got back / what we answered
  error       text
);
CREATE INDEX IF NOT EXISTS provider_log_payment_idx ON provider_log (payment_id, id DESC);
CREATE INDEX IF NOT EXISTS provider_log_at_idx ON provider_log (at DESC);
