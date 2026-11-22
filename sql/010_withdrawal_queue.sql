-- Withdrawal queue. An approved (or never held) withdrawal waits as `queued`
-- until the queue run finds the provider account funded; `priority` is its
-- place (lower first, assigned in steps of 1000 so an operator can move one
-- between two others). Per tenant: the provider account deposits are opened
-- on (null = not sent) and the algorithm the queue run follows.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS priority bigint;
CREATE INDEX IF NOT EXISTS payment_queue_idx ON payment (tenant, priority, created_at) WHERE status = 'queued';
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS deposit_account_id text;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS withdrawal_queue_mode text NOT NULL DEFAULT 'fifo_stop_on_fail';
