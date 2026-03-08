-- Peers table: tracks known mesh nodes
CREATE TABLE IF NOT EXISTS peers (
  node_id TEXT PRIMARY KEY,
  addr TEXT NOT NULL,
  last_seen INTEGER DEFAULT 0,
  status TEXT DEFAULT 'alive',
  agents_json TEXT DEFAULT '[]',
  missed_gossip INTEGER DEFAULT 0
);

-- Messages table: store-and-forward relay
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  global_id TEXT UNIQUE NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  origin_node TEXT NOT NULL,
  ttl INTEGER DEFAULT 3
);

-- Dedup: track seen message IDs
CREATE TABLE IF NOT EXISTS seen_message_ids (
  global_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
