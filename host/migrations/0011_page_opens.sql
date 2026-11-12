-- What each reader opened. One row for each reader and page.
-- version is the newest version that the reader saw. A page with a newer version shows as new in the library.
-- opened_at is the time of the last open. NULL means the reader has not opened the page: the library
-- adds a row with NULL for each page on the first visit of a reader, so the library does not start with a wall of news.
CREATE TABLE page_opens (
  reader TEXT NOT NULL,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  opened_at TEXT,
  PRIMARY KEY (reader, slug)
);
