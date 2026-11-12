-- One row for each time the host starts an assistant in a sandbox for a comment.

-- id is a secret: the sandbox runner reports the result at POST /s/_run/<id>. No API returns it.
-- comment_id is the comment that has the mention. status is 'running', 'done' or 'failed'.
-- ms is the time from started_at to finished_at. detail is a short text: the numbers of a run that is done,
-- or the cause of a failure. A failure that starts with 'not_signed_in' means the person must connect Claude.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ms INTEGER,
  detail TEXT
);
CREATE INDEX agent_runs_comment ON agent_runs (comment_id);
