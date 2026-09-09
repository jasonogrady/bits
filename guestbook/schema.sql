-- guestbook 📝 — "get notified" signups + admin settings. Apply with:
--   npx wrangler d1 execute <your-db> --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS gb_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,              -- ms epoch
  first TEXT NOT NULL,
  last TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,       -- lowercased; re-signup updates the row
  note TEXT,                        -- free text: how they heard / referral / message
  phone TEXT,                       -- E.164, only stored when sms_optin=1
  sms_optin INTEGER NOT NULL DEFAULT 0,
  sms_optin_ts INTEGER,             -- consent record: when (ms epoch) + ip, for carrier audits
  sms_optin_ip TEXT,
  referrer TEXT,
  city TEXT,
  country TEXT,
  ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_gb_signups_ts ON gb_signups (ts DESC);

CREATE TABLE IF NOT EXISTS gb_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- PIN brute-force lockout, per IP.
CREATE TABLE IF NOT EXISTS gb_attempts (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL);
