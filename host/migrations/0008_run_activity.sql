-- What an assistant does during a run, as a short list of events for each run. The viewer draws the assistant's cursor from it.

-- id gives the order in which the host stored the events. The viewer keeps the highest id it has seen as its cursor.
-- run_id is agent_runs.id. slug is the page of the run, so one index answers "what changed on this page".
-- seq is the number that the sandbox runner gives its events, from 1. It is NULL for an event that the host made itself:
-- from a call of the MCP connector, or from the start and the end of the run.
-- kind is 'started', 'tool', 'focus', 'typing', 'edit', 'version', 'done' or 'failed'. data is a small JSON object.
-- A run keeps only its newest 'typing' event, so a run has some tens of rows. The host deletes the rows with the page,
-- and it deletes the rows of old runs when a new run starts on the page.
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  seq INTEGER,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT
);
-- The runner may send one event two times. The second one changes nothing.
CREATE UNIQUE INDEX run_events_seq ON run_events (run_id, seq);
CREATE INDEX run_events_slug ON run_events (slug, id);
-- The MCP connector finds the run of a connector token with this index.
CREATE INDEX agent_runs_token ON agent_runs (token_id);
