-- bug-jar 🫙 hub schema (D1 / SQLite). Idempotent — safe to re-run.
--
--   npx wrangler d1 execute bug-jar --file schema.sql --local    # dev
--   npx wrangler d1 execute bug-jar --file schema.sql --remote   # prod

CREATE TABLE IF NOT EXISTS bugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,                 -- which app dropped it in (e.g. "caddy-shack")
  title TEXT NOT NULL,                   -- first line of the report, hub-derived
  body TEXT NOT NULL DEFAULT '',
  -- severity = the reporter's guess; priority = the owner's triage call (Buganizer-style)
  severity TEXT NOT NULL DEFAULT 'normal'
    CHECK (severity IN ('minor','normal','major','blocker')),
  priority TEXT
    CHECK (priority IN ('P0','P1','P2','P3','P4')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','assigned','fixed','verified','wontfix','dupe')),
  reporter TEXT,                         -- "Name <email>" as attached by the app
  url TEXT,                              -- page the reporter was on
  ua TEXT,
  viewport TEXT,
  version TEXT,                          -- app build the bug was seen on
  console TEXT,                          -- JSON array: recent console/uncaught errors
  extra TEXT,                            -- JSON: any app-supplied context
  notes TEXT NOT NULL DEFAULT '',        -- owner triage notes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bugs_project_status ON bugs (project, status);
CREATE INDEX IF NOT EXISTS idx_bugs_created ON bugs (created_at DESC);
