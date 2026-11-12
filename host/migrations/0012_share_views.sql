-- Views of share links, on the model of Papermark (github.com/mfts/papermark) and DocSend.
-- One row of share_views is one visit: one load of a share link. share_view_parts holds the active time of
-- the visit on each part of the page: a slide of a deck, or a section of a document.

-- A link can have a name, for example the person it is for. A revoked link stays, so its visits keep their name.
ALTER TABLE shares ADD COLUMN name TEXT;
ALTER TABLE shares ADD COLUMN revoked_at TEXT;

-- A share link needs no login, so a visit has no name and no IP address.
-- visitor is a hash of the IP address and the browser with the salt of one day (share_salts). The host deletes
-- each salt after two days, so the host can count visitors for a day but cannot link a visitor across days.
CREATE TABLE share_views (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  visitor TEXT NOT NULL,
  -- phone, tablet or desktop.
  device TEXT NOT NULL,
  -- macOS, Windows, iOS, Android, Linux, ChromeOS, or NULL.
  os TEXT,
  -- The two-letter country code from Cloudflare, or NULL.
  country TEXT,
  -- The host name of the page that linked here, or NULL for a direct visit.
  referrer TEXT,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  -- The sum of the active time on the parts.
  active_ms INTEGER NOT NULL DEFAULT 0,
  -- The number of parts of the page: slides of a deck, or sections of a document.
  parts INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX share_views_slug ON share_views (slug, started_at);

-- The active time of one visit on one part. part is the index of the part, from 0. label is its heading.
CREATE TABLE share_view_parts (
  view_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  label TEXT NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (view_id, part)
);

-- The salt of each day for the visitor hash. The host deletes a salt when it is two days old.
CREATE TABLE share_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
