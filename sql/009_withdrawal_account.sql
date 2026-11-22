-- Per-tenant provider account the bank transfers are paid from (null = the
-- deployment's provider-account-id), so tenants can be served from different
-- provider accounts.
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS withdrawal_account_id text;
