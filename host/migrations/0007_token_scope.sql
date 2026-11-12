-- Connector tokens get a public id, an optional page scope and an optional end time. A run records its token.

-- id is short and is not a secret: the token list shows it, and DELETE /api/connector-tokens/<id> takes it.
ALTER TABLE connector_tokens ADD COLUMN id TEXT;
-- A token with a slug reaches that page only. NULL means every page.
ALTER TABLE connector_tokens ADD COLUMN slug TEXT;
-- The connector refuses the token from this time on. NULL means the token has no end time.
ALTER TABLE connector_tokens ADD COLUMN expires_at TEXT;
UPDATE connector_tokens SET id = lower(hex(randomblob(6))) WHERE id IS NULL;
CREATE UNIQUE INDEX connector_tokens_id ON connector_tokens (id);

-- The id of the connector token that the host made for the run. The host deletes that token when the run ends.
ALTER TABLE agent_runs ADD COLUMN token_id TEXT;
