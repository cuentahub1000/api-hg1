-- Where a request came from: { ip, userAgent } as the front-end saw the player.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS client jsonb;
