-- Comments on a page, and the tokens that let an outside assistant use the MCP connector.

-- One row per comment. A reply has parent_id set to the first comment of its thread.
-- version is the page version the comment was written on. status counts only on the first comment.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  anchor TEXT,
  quote TEXT,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  -- 'claude' or 'chatgpt' when the body has @claude or @chatgpt. NULL means no mention.
  mention TEXT,
  parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX comments_slug ON comments (slug);

-- One token gives one outside assistant the MCP connector at /s/_mcp/<token>.
CREATE TABLE connector_tokens (
  token TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
