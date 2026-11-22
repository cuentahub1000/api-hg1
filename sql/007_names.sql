-- Operator names next to the ids, for the back-office trail.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS decided_by_name text;
ALTER TABLE payment_event ADD COLUMN IF NOT EXISTS actor_name text;
