-- Folders. A folder holds pages and other folders. parent_id NULL means the top level.
-- Numbered 0006 so 0004 and 0005 stay free for the comment and event migrations on another branch.
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  -- One of the kit's color ramps (blue, teal, green, amber, coral, pink, purple, red, gray). NULL means plain.
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX folders_parent ON folders (parent_id);

-- The folder that holds the page. NULL means the page is not in a folder.
ALTER TABLE pages ADD COLUMN folder_id TEXT;
CREATE INDEX pages_folder ON pages (folder_id);
