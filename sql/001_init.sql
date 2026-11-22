-- api-hg: own database. One row per deposit or withdrawal, an append-only
-- event trail, the provider webhook inbox (idempotency + audit) and the
-- per-tenant hold/limit settings. Nothing here references the wallet schema;
-- the wallet is reached only through its API.

CREATE TABLE IF NOT EXISTS payment (
  id                  uuid PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  status              text NOT NULL,
  tenant              text NOT NULL,               -- root of the player's chain
  party_id            text NOT NULL,
  username            text,
  chain               text NOT NULL,               -- player's chain (ancestors, '-' joined)
  account_id          text NOT NULL,               -- wallet account id (opaque here)
  currency            text NOT NULL,
  amount              numeric(18,2) NOT NULL CHECK (amount > 0),
  fee                 numeric(18,2),
  hold                boolean NOT NULL DEFAULT false,
  wallet_operation_id text,
  wallet_status       text,
  provider_ref        text,                        -- checkout id / transaction request id
  provider_status     text,
  checkout_url        text,
  expires_at          timestamptz,
  destination         jsonb,                       -- withdrawals: { type, value, holderName }
  payer               jsonb,                       -- deposits: { document, name, email }
  note                text,                        -- operator's note / reason
  decided_by          text,
  decided_at          timestamptz,
  error_code          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  version             integer NOT NULL DEFAULT 0   -- optimistic lock for decisions
);
CREATE INDEX IF NOT EXISTS payment_party_idx    ON payment (party_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_chain_idx    ON payment (chain text_pattern_ops, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_status_idx   ON payment (status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_ref_idx ON payment (provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_event (
  id          bigserial PRIMARY KEY,
  payment_id  uuid NOT NULL REFERENCES payment (id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,                       -- player | operator:<partyId> | provider | system
  type        text NOT NULL,
  data        jsonb
);
CREATE INDEX IF NOT EXISTS payment_event_payment_idx ON payment_event (payment_id, id);

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id            bigserial PRIMARY KEY,
  received_at   timestamptz NOT NULL DEFAULT now(),
  topic         text,
  event_type    text,
  provider_ref  text,
  dedupe_key    text UNIQUE,                       -- sha256 of the raw body
  body          jsonb NOT NULL,
  signature_ok  boolean NOT NULL,
  processed_at  timestamptz,
  result        text
);

CREATE TABLE IF NOT EXISTS payment_settings (
  tenant                 text PRIMARY KEY,
  deposits_enabled       boolean NOT NULL DEFAULT true,
  withdrawals_enabled    boolean NOT NULL DEFAULT true,
  hold_deposits          boolean NOT NULL DEFAULT false,
  hold_deposits_above    numeric(18,2),
  hold_withdrawals       boolean NOT NULL DEFAULT true,
  hold_withdrawals_above numeric(18,2),
  min_deposit            numeric(18,2) NOT NULL DEFAULT 1000,
  max_deposit            numeric(18,2) NOT NULL DEFAULT 2000000,
  min_withdrawal         numeric(18,2) NOT NULL DEFAULT 1000,
  max_withdrawal         numeric(18,2) NOT NULL DEFAULT 1000000,
  max_open_withdrawals   integer NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             text
);
