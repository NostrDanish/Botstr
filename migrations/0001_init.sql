-- Botstr bot registry. Private keys are NEVER stored here — they are sealed
-- inside each bot's Durable Object, encrypted with BOTSTR_SECRET.
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL,              -- BotRecord JSON (non-secret configuration)
  last_status TEXT NOT NULL DEFAULT 'created',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT,
  action TEXT NOT NULL,              -- create | start | stop | restart | delete
  ts INTEGER NOT NULL
);
