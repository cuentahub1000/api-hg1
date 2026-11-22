-- Player rules belong to a tenant: the same party id under two brands is two
-- players. Key the overrides by (tenant, party_id) and index blocks the same way.
ALTER TABLE player_limits DROP CONSTRAINT IF EXISTS player_limits_pkey;
ALTER TABLE player_limits ADD PRIMARY KEY (tenant, party_id);
DROP INDEX IF EXISTS player_block_party_idx;
CREATE INDEX IF NOT EXISTS player_block_tenant_party_idx ON player_block (tenant, party_id) WHERE lifted_at IS NULL;
