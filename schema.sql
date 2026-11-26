CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  body TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  created INTEGER NOT NULL,
  burn_after INTEGER NOT NULL,
  seen_at INTEGER,
  delete_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room, created);
CREATE INDEX IF NOT EXISTS idx_messages_delete ON messages (delete_at);

CREATE TABLE IF NOT EXISTS presence (
  room TEXT NOT NULL,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room, uid)
);

CREATE INDEX IF NOT EXISTS idx_presence_room ON presence (room, last_seen);
