-- shop-bell 🔔 event ledger. Apply with:
--   npx wrangler d1 execute <your-db> --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS pulse_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,              -- ms epoch
  event TEXT NOT NULL,              -- page_view, session_start, goal_click, qualified_lead, …
  session_id TEXT,
  path TEXT,
  props TEXT,                       -- JSON
  funnel TEXT,                      -- JSON snapshot at emit time
  owner INTEGER NOT NULL DEFAULT 0, -- site owner (opt-out via ?me=1), stored but never alerted
  bot INTEGER NOT NULL DEFAULT 0,   -- UA matched the bot regex, stored but never alerted
  city TEXT,
  region TEXT,
  country TEXT,
  org TEXT,                         -- request.cf.asOrganization (free ASN-level enrichment)
  referrer TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_pulse_events_ts ON pulse_events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_pulse_events_event ON pulse_events (event, ts DESC);
