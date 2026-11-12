-- A person can change and delete their own comments. Each person picks a model for each assistant.

-- edited_at is the time of the last change of the body, or NULL for a comment that nobody changed.
ALTER TABLE comments ADD COLUMN edited_at TEXT;

-- The model that a person chose for an assistant. assistant is 'claude' or 'chatgpt'. model is an id from the
-- /status answer of the sandbox runner. No row means the default model of the runner.
CREATE TABLE assistant_prefs (
  user TEXT NOT NULL,
  assistant TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user, assistant)
);

-- One row for each sign-in that a person started from the viewer. id comes from the runner. The host checks that the
-- person who asks for the state of a sign-in, or who sends its code, is the person who started it. The code is never stored.
CREATE TABLE connect_flows (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  assistant TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
