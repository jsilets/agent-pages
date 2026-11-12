-- Where a comment sits in the page text, so the viewer finds the place again after an edit.

-- quote is the text that the person selected. prefix and suffix are the page text just before it and just after it,
-- at most 64 characters each. anchor is the id of the nearest element, and slide is the id of the slide for a deck.
-- version is the version that the person saw. A comment from before this migration has no prefix, suffix or slide.
ALTER TABLE comments ADD COLUMN prefix TEXT;
ALTER TABLE comments ADD COLUMN suffix TEXT;
ALTER TABLE comments ADD COLUMN slide TEXT;

-- The last time the host asked the sandbox runner to warm up for a person. The host asks at most one time in 60 seconds.
CREATE TABLE runner_warm (
  user TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
