-- Folders. A folder holds pages and other folders. parent_id NULL means the top level.
-- Numbered 0010 so it comes after the comment and agent migrations (0004 to 0009) of the comment-agent-triggers branch.
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
