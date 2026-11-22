-- Sandbox provider state (PROVIDER_MODE=mock only). Lives in the database so
-- the fake hosted page and the handlers share it whatever process runs them.
CREATE TABLE IF NOT EXISTS sandbox_checkout (
  id            uuid PRIMARY KEY,
  status        text NOT NULL,
  amount        numeric(18,2) NOT NULL,
  country       text NOT NULL,
  payer_document text,
  success_url   text NOT NULL,
  cancel_url    text NOT NULL,
  transaction_id uuid,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_payout (
  id            uuid PRIMARY KEY,
  status        text NOT NULL,
  amount        numeric(18,2) NOT NULL,
  destination   text NOT NULL,
  error_code    text,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);
