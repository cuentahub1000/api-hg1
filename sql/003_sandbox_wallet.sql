-- Sandbox wallet (WALLET_MODE=mock only): one account per party and the
-- PENDING -> COMPLETED | CANCELED operations the real wallet would hold.
CREATE TABLE IF NOT EXISTS sandbox_wallet_account (
  id          serial PRIMARY KEY,
  party_id    text UNIQUE NOT NULL,
  available   numeric(18,2) NOT NULL,
  payout      numeric(18,2) NOT NULL,
  blocked     numeric(18,2) NOT NULL DEFAULT 0,
  pending     numeric(18,2) NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sandbox_wallet_operation (
  identifier          text PRIMARY KEY,
  account_id          integer NOT NULL REFERENCES sandbox_wallet_account (id),
  type                text NOT NULL,
  subtype             text NOT NULL,
  amount              numeric(18,2) NOT NULL,
  status              text NOT NULL,
  external_reference  text UNIQUE NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
