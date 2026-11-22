-- Separate what is ours (the payment) from what is the provider's (its
-- checkout / payout reference), add per-player limits and blocks, and keep the
-- payer's national id only as a keyed hash. Existing rows are test data.

-- payment: provider-agnostic. `provider` names the integration ('hg', ...).
ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'hg';
ALTER TABLE payment ADD COLUMN IF NOT EXISTS document_hash text;      -- HMAC-SHA256(normalised national id, DOCUMENT_HASH_KEY)
ALTER TABLE payment DROP COLUMN IF EXISTS provider_ref;
ALTER TABLE payment DROP COLUMN IF EXISTS provider_status;
ALTER TABLE payment DROP COLUMN IF EXISTS checkout_url;
ALTER TABLE payment DROP COLUMN IF EXISTS expires_at;
CREATE INDEX IF NOT EXISTS payment_document_hash_idx ON payment (document_hash) WHERE document_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_party_kind_created_idx ON payment (party_id, kind, created_at DESC);

-- one row per payment: the provider's side of it
CREATE TABLE IF NOT EXISTS payment_provider (
  payment_id   uuid PRIMARY KEY REFERENCES payment (id) ON DELETE CASCADE,
  provider     text NOT NULL,
  ref          text NOT NULL,                 -- checkout id / transaction request id at the provider
  status       text,                          -- the provider's own status, verbatim
  checkout_url text,                          -- hosted page (deposits)
  expires_at   timestamptz,
  data         jsonb,                         -- anything else the provider returned, verbatim
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_ref_idx ON payment_provider (provider, ref);

-- tenant defaults for the rolling windows (null = no cap)
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS daily_deposit_max      numeric(18,2);
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS weekly_deposit_max     numeric(18,2);
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS monthly_deposit_max    numeric(18,2);
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS daily_withdrawal_max   numeric(18,2);
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS weekly_withdrawal_max  numeric(18,2);
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS monthly_withdrawal_max numeric(18,2);

-- per-player overrides; a null column means "use the tenant value"
CREATE TABLE IF NOT EXISTS player_limits (
  party_id               text PRIMARY KEY,
  tenant                 text NOT NULL,
  min_deposit            numeric(18,2),
  max_deposit            numeric(18,2),
  min_withdrawal         numeric(18,2),
  max_withdrawal         numeric(18,2),
  daily_deposit_max      numeric(18,2),
  weekly_deposit_max     numeric(18,2),
  monthly_deposit_max    numeric(18,2),
  daily_withdrawal_max   numeric(18,2),
  weekly_withdrawal_max  numeric(18,2),
  monthly_withdrawal_max numeric(18,2),
  max_open_withdrawals   integer,
  note                   text,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             text
);

-- blocks: deposits, withdrawals or both; `until` null = permanent; lifted when lifted_at is set
CREATE TABLE IF NOT EXISTS player_block (
  id          bigserial PRIMARY KEY,
  party_id    text NOT NULL,
  tenant      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'all')),
  until       timestamptz,
  reason      text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  lifted_at   timestamptz,
  lifted_by   text
);
CREATE INDEX IF NOT EXISTS player_block_party_idx ON player_block (party_id) WHERE lifted_at IS NULL;
