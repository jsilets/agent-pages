-- Views of share links. A share link needs no login, so a row has no name and no IP address.
-- visitor is a hash of the IP address and the browser with the salt of one day (share_salts). The host deletes
-- each salt after two days, so a visitor cannot be linked across days and the address cannot be recovered.
-- One row is one visit: a new load of the link by the same visitor within 30 minutes continues the row.
CREATE TABLE share_views (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  visitor TEXT NOT NULL,
  -- phone, tablet or desktop.
  device TEXT NOT NULL,
  -- The two-letter country code from Cloudflare, or NULL.
  country TEXT,
  -- The host name of the page that linked here, or NULL for a direct visit.
  referrer TEXT,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  -- The time that the page was on screen and the reader was active in the last minute.
  active_ms INTEGER NOT NULL DEFAULT 0,
  -- A document: the furthest point read, in percent. A deck: the number of slides reached.
  depth INTEGER NOT NULL DEFAULT 0,
  -- A deck: the number of slides. A document: 0.
  slides INTEGER NOT NULL DEFAULT 0,
  -- Downloads of the PDF or the HTML from the share page.
  downloads INTEGER NOT NULL DEFAULT 0,
  -- JSON: for each section heading or slide, the active milliseconds on it.
  parts TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX share_views_slug ON share_views (slug, started_at);
CREATE INDEX share_views_visit ON share_views (token, visitor, last_at);

-- The salt of each day for the visitor hash. The host deletes a salt when it is two days old.
CREATE TABLE share_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
