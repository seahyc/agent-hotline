import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export interface Agent {
  session_id: string;
  name: string;
  agent_type: string;
  machine: string;
  cwd: string;
  cwd_remote: string;
  branch: string;
  status: string;
  dirty_files: string; // JSON array of file paths
  background_processes: string; // JSON array of {pid, port?, command, description}
  git_diff: string;
  conversation_recent: string;
  terminal: string;
  pid: number;
  last_seen: number; // unix ms
  online: number; // 0 or 1
}

export interface Message {
  id: number;
  global_id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  timestamp: number; // unix ms
  read: number; // 0 or 1
  delivery_status: string; // "delivered" | "pending"
  room: string | null;
  reply_to_id: number | null;
  mentions_json: string; // JSON array of session_ids
  msg_type: string; // "direct" | "room" | "mention" | "reply_notify"
}

export interface Peer {
  node_id: string;
  addr: string;
  last_seen: number; // unix ms
  status: string; // "alive" | "suspect" | "dead"
  agents_json: string; // JSON array of agent summaries
  missed_gossip: number;
}

export interface RoomMessage {
  id: number;
  global_id: string;
  from_agent: string;
  room_name: string;
  content: string;
  timestamp: number;
  reply_to_id: number | null;
  mentions_json: string;
}

export type EventType = "agent_online" | "agent_offline";

export interface Store {
  close(): void;
  upsertAgent(agent: Partial<Agent> & { session_id: string }): void;
  getAgents(room?: string): Agent[];
  getAgent(sessionId: string): Agent | null;
  getAgentByPid(pid: number): Agent | null;
  getRecentOnlineAgent(): Agent | null;
  resolveAgent(nameOrId: string): Agent | null;
  renameAgent(sessionId: string, name: string): void;
  createMessage(from: string, to: string, content: string, extra?: { room?: string; replyToId?: number; mentionsJson?: string; msgType?: string }): number;
  getMessage(id: number): Message | null;
  getUnreadMessages(sessionId: string): Message[];
  getMessages(sessionId: string, limit: number, before?: number): Message[];
  markRead(sessionId: string): void;
  markOffline(sessionId: string): void;
  getOnlineAgents(): Agent[];
  getSubscribers(event: EventType): string[];
  purgeOldMessages(maxAgeDays: number): number;
  touchAgent(sessionId: string): void;
  addApiKey(key: string, label: string): void;
  createApiKey(label: string): string;
  validateApiKey(key: string): boolean;
  hasAnyApiKey(): boolean;
  createInviteCode(): string;
  redeemInviteCode(code: string): string | null;
  getOrCreateInboxToken(sessionId: string, ttlMs: number): string;
  validateInboxToken(sessionId: string, token: string): boolean;
  // Mesh networking
  upsertPeer(peer: { node_id: string; addr: string; agents_json?: string }): void;
  getPeers(): Peer[];
  getPeer(nodeId: string): Peer | null;
  removePeer(nodeId: string): void;
  incrementMissedGossip(nodeId: string): void;
  resetMissedGossip(nodeId: string): void;
  setPeerStatus(nodeId: string, status: string): void;
  createMessageWithGlobalId(from: string, to: string, content: string, globalId: string, deliveryStatus?: string): void;
  getPendingMessages(): Message[];
  markDelivered(globalId: string): void;
  hasSeenMessage(globalId: string): boolean;
  markMessageSeen(globalId: string): void;
  purgeExpiredSeenIds(): void;
  upsertRemoteAgent(agent: Partial<Agent> & { session_id: string }, originNodeId: string): void;
  // Rooms
  createRoom(name: string): void;
  joinRoom(roomName: string, sessionId: string, notify?: string): void;
  leaveRoom(roomName: string, sessionId: string): void;
  getRoomMembers(roomName: string): string[];
  getRoomMemberNotify(roomName: string, sessionId: string): string;
  getAgentRooms(sessionId: string): string[];
  listRooms(): { name: string; memberCount: number }[];
  getRoomsSnapshot(): { name: string; members: string[] }[];
  mergeRooms(rooms: { name: string; members: string[] }[]): void;
  // Room messages (canonical room history)
  createRoomMessage(from: string, room: string, content: string, extra?: {
    replyToId?: number; mentionsJson?: string;
  }): number;
  getRoomMessages(room: string, limit: number, before?: number): RoomMessage[];
  // Notification preferences
  setNotifyPref(sessionId: string, roomName: string | null, level: string): void;
  resolveNotifyLevel(sessionId: string, roomName: string): string;
}

const CREATE_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  session_id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  agent_type TEXT DEFAULT '',
  machine TEXT DEFAULT '',
  cwd TEXT DEFAULT '',
  cwd_remote TEXT DEFAULT '',
  branch TEXT DEFAULT '',
  status TEXT DEFAULT '',
  dirty_files TEXT DEFAULT '[]',
  background_processes TEXT DEFAULT '[]',
  git_diff TEXT DEFAULT '',
  conversation_recent TEXT DEFAULT '',
  terminal TEXT DEFAULT '',
  pid INTEGER DEFAULT 0,
  last_seen INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0
)`;

const CREATE_MESSAGES = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  read INTEGER DEFAULT 0
)`;

const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_to_unread
  ON messages(to_agent, read)`;

const CREATE_SUBSCRIPTIONS = `
CREATE TABLE IF NOT EXISTS subscriptions (
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (session_id, event)
)`;

const CREATE_API_KEYS = `
CREATE TABLE IF NOT EXISTS api_keys (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

const CREATE_INVITE_CODES = `
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0
)`;

const CREATE_INBOX_TOKENS = `
CREATE TABLE IF NOT EXISTS inbox_tokens (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;

const CREATE_PEERS = `
CREATE TABLE IF NOT EXISTS peers (
  node_id TEXT PRIMARY KEY,
  addr TEXT NOT NULL,
  last_seen INTEGER DEFAULT 0,
  status TEXT DEFAULT 'alive',
  agents_json TEXT DEFAULT '[]',
  missed_gossip INTEGER DEFAULT 0
)`;

const CREATE_SEEN_MESSAGE_IDS = `
CREATE TABLE IF NOT EXISTS seen_message_ids (
  global_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;

export function createStore(dbPath?: string): Store {
  const db = new Database(dbPath ?? "./hotline.db");
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_AGENTS);
  // Migration: add name column for existing DBs
  try { db.exec("ALTER TABLE agents ADD COLUMN name TEXT DEFAULT ''"); } catch (_) { /* already exists */ }
  db.exec(CREATE_MESSAGES);
  db.exec(CREATE_MESSAGES_INDEX);
  db.exec(CREATE_SUBSCRIPTIONS);
  db.exec(CREATE_API_KEYS);
  db.exec(CREATE_INVITE_CODES);
  db.exec(CREATE_INBOX_TOKENS);
  db.exec(CREATE_PEERS);
  db.exec(CREATE_SEEN_MESSAGE_IDS);

  // Room tables
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS room_members (
    room_name TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_name, session_id)
  )`);

  // Room messages table (canonical room history)
  db.exec(`CREATE TABLE IF NOT EXISTS room_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    global_id   TEXT NOT NULL DEFAULT '',
    from_agent  TEXT NOT NULL,
    room_name   TEXT NOT NULL,
    content     TEXT NOT NULL,
    timestamp   INTEGER NOT NULL,
    reply_to_id INTEGER DEFAULT NULL,
    mentions_json TEXT DEFAULT '[]'
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_name, timestamp)`);

  // Notification preferences table
  db.exec(`CREATE TABLE IF NOT EXISTS notification_prefs (
    session_id TEXT NOT NULL,
    room_name  TEXT,
    level      TEXT NOT NULL DEFAULT 'all',
    PRIMARY KEY (session_id, room_name)
  )`);

  // Migration: add notify column to room_members
  try { db.exec("ALTER TABLE room_members ADD COLUMN notify TEXT DEFAULT 'all'"); } catch (_) { /* already exists */ }

  // Migrations for message room/reply/mention columns
  try { db.exec("ALTER TABLE messages ADD COLUMN room TEXT DEFAULT NULL"); } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER DEFAULT NULL"); } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE messages ADD COLUMN mentions_json TEXT DEFAULT '[]'"); } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'direct'"); } catch (_) { /* already exists */ }

  // Migrations for mesh networking columns
  try { db.exec("ALTER TABLE messages ADD COLUMN global_id TEXT DEFAULT ''"); } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT DEFAULT 'delivered'"); } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE agents ADD COLUMN origin_node TEXT DEFAULT ''"); } catch (_) { /* already exists */ }
  try { db.exec("ALTER TABLE agents ADD COLUMN last_seen_logical INTEGER DEFAULT 0"); } catch (_) { /* already exists */ }

  const upsertAgentStmt = db.prepare(`
    INSERT INTO agents (session_id, name, agent_type, machine, cwd, cwd_remote, branch, status, dirty_files, background_processes, git_diff, conversation_recent, terminal, pid, last_seen, online)
    VALUES (@session_id, @name, @agent_type, @machine, @cwd, @cwd_remote, @branch, @status, @dirty_files, @background_processes, @git_diff, @conversation_recent, @terminal, @pid, @last_seen, @online)
    ON CONFLICT(session_id) DO UPDATE SET
      name = CASE WHEN @name != '' THEN @name ELSE agents.name END,
      agent_type = @agent_type,
      machine = @machine,
      cwd = @cwd,
      cwd_remote = @cwd_remote,
      branch = @branch,
      status = @status,
      dirty_files = @dirty_files,
      background_processes = @background_processes,
      git_diff = @git_diff,
      conversation_recent = @conversation_recent,
      terminal = @terminal,
      pid = @pid,
      last_seen = @last_seen,
      online = @online
  `);

  const getAgentsStmt = db.prepare("SELECT * FROM agents");
  const getAgentsByRoomStmt = db.prepare(
    "SELECT * FROM agents WHERE cwd LIKE ? ESCAPE '\\'",
  );
  const getAgentStmt = db.prepare(
    "SELECT * FROM agents WHERE session_id = ?",
  );
  const getOnlineAgentsStmt = db.prepare(
    "SELECT * FROM agents WHERE online = 1",
  );
  const getAgentByPidStmt = db.prepare(
    "SELECT * FROM agents WHERE pid = ? AND online = 1 LIMIT 1",
  );
  const getAgentByNameStmt = db.prepare(
    "SELECT * FROM agents WHERE name = ? AND name != '' LIMIT 1",
  );
  const renameAgentStmt = db.prepare(
    "UPDATE agents SET name = ? WHERE session_id = ?",
  );

  const createMessageStmt = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, content, timestamp, read, global_id, delivery_status, room, reply_to_id, mentions_json, msg_type) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
  );
  const getMessageStmt = db.prepare("SELECT * FROM messages WHERE id = ?");
  const getUnreadMessagesStmt = db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND read = 0 ORDER BY timestamp ASC",
  );
  const getMessagesStmt = db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? ORDER BY timestamp DESC LIMIT ?",
  );
  const getMessagesBeforeStmt = db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?",
  );
  const markReadStmt = db.prepare(
    "UPDATE messages SET read = 1 WHERE to_agent = ? AND read = 0",
  );
  const markOfflineStmt = db.prepare(
    "UPDATE agents SET online = 0 WHERE session_id = ?",
  );
  const purgeOldMessagesStmt = db.prepare(
    "DELETE FROM messages WHERE timestamp < ?",
  );
  const touchAgentStmt = db.prepare(
    "UPDATE agents SET last_seen = ? WHERE session_id = ?",
  );
  const getSubscribersStmt = db.prepare(
    "SELECT session_id FROM subscriptions WHERE event = ?",
  );

  const insertApiKeyStmt = db.prepare(
    "INSERT OR IGNORE INTO api_keys (key, label, created_at) VALUES (?, ?, ?)",
  );
  const validateApiKeyStmt = db.prepare(
    "SELECT 1 FROM api_keys WHERE key = ?",
  );
  const hasAnyApiKeyStmt = db.prepare(
    "SELECT 1 FROM api_keys LIMIT 1",
  );
  const getRecentOnlineAgentStmt = db.prepare(
    "SELECT * FROM agents WHERE online = 1 AND pid > 0 ORDER BY last_seen DESC LIMIT 1",
  );

  const insertInviteCodeStmt = db.prepare(
    "INSERT INTO invite_codes (code, created_at, used) VALUES (?, ?, 0)",
  );
  const redeemInviteCodeStmt = db.prepare(
    "UPDATE invite_codes SET used = 1 WHERE code = ? AND used = 0",
  );

  const getInboxTokenStmt = db.prepare(
    "SELECT token FROM inbox_tokens WHERE session_id = ? AND expires_at > ?",
  );
  const upsertInboxTokenStmt = db.prepare(
    "INSERT OR REPLACE INTO inbox_tokens (token, session_id, expires_at) VALUES (?, ?, ?)",
  );
  const deleteExpiredTokensStmt = db.prepare(
    "DELETE FROM inbox_tokens WHERE expires_at <= ?",
  );
  const validateInboxTokenStmt = db.prepare(
    "SELECT 1 FROM inbox_tokens WHERE session_id = ? AND token = ? AND expires_at > ?",
  );

  // Peer statements
  const upsertPeerStmt = db.prepare(`
    INSERT INTO peers (node_id, addr, last_seen, status, agents_json, missed_gossip)
    VALUES (@node_id, @addr, @last_seen, 'alive', @agents_json, 0)
    ON CONFLICT(node_id) DO UPDATE SET
      addr = @addr,
      last_seen = @last_seen,
      agents_json = @agents_json,
      missed_gossip = 0,
      status = 'alive'
  `);
  const getPeersStmt = db.prepare("SELECT * FROM peers");
  const getPeerStmt = db.prepare("SELECT * FROM peers WHERE node_id = ?");
  const removePeerStmt = db.prepare("DELETE FROM peers WHERE node_id = ?");
  const incrementMissedGossipStmt = db.prepare(
    "UPDATE peers SET missed_gossip = missed_gossip + 1 WHERE node_id = ?",
  );
  const resetMissedGossipStmt = db.prepare(
    "UPDATE peers SET missed_gossip = 0 WHERE node_id = ?",
  );
  const setPeerStatusStmt = db.prepare(
    "UPDATE peers SET status = ? WHERE node_id = ?",
  );

  // Room statements
  const createRoomStmt = db.prepare("INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)");
  const joinRoomStmt = db.prepare("INSERT INTO room_members (room_name, session_id, joined_at, notify) VALUES (?, ?, ?, ?) ON CONFLICT(room_name, session_id) DO UPDATE SET notify = excluded.notify");
  const leaveRoomStmt = db.prepare("DELETE FROM room_members WHERE room_name = ? AND session_id = ?");
  const getRoomMembersStmt = db.prepare("SELECT session_id FROM room_members WHERE room_name = ?");
  const getRoomMemberNotifyStmt = db.prepare("SELECT notify FROM room_members WHERE room_name = ? AND session_id = ?");
  const getAgentRoomsStmt = db.prepare("SELECT room_name FROM room_members WHERE session_id = ?");
  const listRoomsStmt = db.prepare("SELECT r.name, COUNT(rm.session_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.name = rm.room_name GROUP BY r.name");
  const getRoomsSnapshotStmt = db.prepare("SELECT r.name, rm.session_id FROM rooms r LEFT JOIN room_members rm ON r.name = rm.room_name");

  // Room message statements
  const createRoomMessageStmt = db.prepare(
    "INSERT INTO room_messages (global_id, from_agent, room_name, content, timestamp, reply_to_id, mentions_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const getRoomMessagesStmt = db.prepare(
    "SELECT * FROM room_messages WHERE room_name = ? ORDER BY timestamp DESC LIMIT ?"
  );
  const getRoomMessagesBeforeStmt = db.prepare(
    "SELECT * FROM room_messages WHERE room_name = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?"
  );

  // Notification pref statements
  const setNotifyPrefStmt = db.prepare(
    "INSERT INTO notification_prefs (session_id, room_name, level) VALUES (?, ?, ?) ON CONFLICT(session_id, room_name) DO UPDATE SET level = excluded.level"
  );
  const getNotifyPrefStmt = db.prepare(
    "SELECT level FROM notification_prefs WHERE session_id = ? AND room_name = ?"
  );
  const getGlobalNotifyPrefStmt = db.prepare(
    "SELECT level FROM notification_prefs WHERE session_id = ? AND room_name IS NULL"
  );

  // Mesh message statements
  const createMessageWithGlobalIdStmt = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, content, timestamp, read, global_id, delivery_status) VALUES (?, ?, ?, ?, 0, ?, ?)",
  );
  const getPendingMessagesStmt = db.prepare(
    "SELECT * FROM messages WHERE delivery_status = 'pending' ORDER BY timestamp ASC",
  );
  const markDeliveredStmt = db.prepare(
    "UPDATE messages SET delivery_status = 'delivered' WHERE global_id = ?",
  );

  // Seen message dedup statements
  const hasSeenMessageStmt = db.prepare(
    "SELECT 1 FROM seen_message_ids WHERE global_id = ?",
  );
  const markMessageSeenStmt = db.prepare(
    "INSERT OR IGNORE INTO seen_message_ids (global_id, expires_at) VALUES (?, ?)",
  );
  const purgeExpiredSeenIdsStmt = db.prepare(
    "DELETE FROM seen_message_ids WHERE expires_at < ?",
  );

  // Remote agent upsert (LWW with origin node authority)
  const upsertRemoteAgentStmt = db.prepare(`
    INSERT INTO agents (session_id, name, agent_type, machine, cwd, cwd_remote, branch, status,
      dirty_files, background_processes, git_diff, conversation_recent, terminal, pid, last_seen, online, origin_node, last_seen_logical)
    VALUES (@session_id, @name, @agent_type, @machine, @cwd, @cwd_remote, @branch, @status,
      @dirty_files, @background_processes, @git_diff, @conversation_recent, @terminal, @pid, @last_seen, @online, @origin_node, @last_seen_logical)
    ON CONFLICT(session_id) DO UPDATE SET
      name = CASE WHEN @name != '' THEN @name ELSE agents.name END,
      agent_type = CASE WHEN @agent_type != '' THEN @agent_type ELSE agents.agent_type END,
      machine = CASE WHEN @machine != '' THEN @machine ELSE agents.machine END,
      cwd = CASE WHEN @cwd != '' THEN @cwd ELSE agents.cwd END,
      cwd_remote = CASE WHEN @cwd_remote != '' THEN @cwd_remote ELSE agents.cwd_remote END,
      branch = CASE WHEN @branch != '' THEN @branch ELSE agents.branch END,
      status = CASE WHEN @status != '' THEN @status ELSE agents.status END,
      last_seen = @last_seen,
      online = @online,
      origin_node = @origin_node,
      last_seen_logical = @last_seen_logical
    WHERE @last_seen_logical > agents.last_seen_logical OR agents.origin_node = '' OR agents.origin_node = @origin_node
  `);

  return {
    close() {
      db.close();
    },

    upsertAgent(agent) {
      const now = Date.now();
      const row = {
        session_id: agent.session_id,
        name: agent.name ?? "",
        agent_type: agent.agent_type ?? "",
        machine: agent.machine ?? "",
        cwd: agent.cwd ?? "",
        cwd_remote: agent.cwd_remote ?? "",
        branch: agent.branch ?? "",
        status: agent.status ?? "",
        dirty_files: agent.dirty_files ?? "[]",
        background_processes: agent.background_processes ?? "[]",
        git_diff: agent.git_diff ?? "",
        conversation_recent: agent.conversation_recent ?? "",
        terminal: agent.terminal ?? "",
        pid: agent.pid ?? 0,
        last_seen: now,
        online: 1,
      };
      upsertAgentStmt.run(row);
    },

    getAgents(room?: string) {
      if (room) {
        const escaped = room.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
        return getAgentsByRoomStmt.all(`%${escaped}%`) as Agent[];
      }
      return getAgentsStmt.all() as Agent[];
    },

    getAgent(sessionId) {
      return (getAgentStmt.get(sessionId) as Agent) ?? null;
    },

    getAgentByPid(pid) {
      if (!pid) return null;
      return (getAgentByPidStmt.get(pid) as Agent) ?? null;
    },

    getRecentOnlineAgent() {
      return (getRecentOnlineAgentStmt.get() as Agent) ?? null;
    },

    resolveAgent(nameOrId) {
      // Try by name first, then by session_id
      const byName = (getAgentByNameStmt.get(nameOrId) as Agent) ?? null;
      if (byName) return byName;
      return (getAgentStmt.get(nameOrId) as Agent) ?? null;
    },

    renameAgent(sessionId, name) {
      renameAgentStmt.run(name, sessionId);
    },

    createMessage(from, to, content, extra?) {
      const globalId = randomUUID();
      const info = createMessageStmt.run(from, to, content, Date.now(), globalId, "delivered",
        extra?.room ?? null, extra?.replyToId ?? null, extra?.mentionsJson ?? "[]", extra?.msgType ?? "direct");
      return Number(info.lastInsertRowid);
    },

    getMessage(id) {
      return (getMessageStmt.get(id) as Message) ?? null;
    },

    getUnreadMessages(sessionId) {
      return getUnreadMessagesStmt.all(sessionId) as Message[];
    },

    getMessages(sessionId, limit, before?) {
      if (before) {
        return getMessagesBeforeStmt.all(sessionId, before, limit) as Message[];
      }
      return getMessagesStmt.all(sessionId, limit) as Message[];
    },

    markRead(sessionId) {
      markReadStmt.run(sessionId);
    },

    markOffline(sessionId) {
      markOfflineStmt.run(sessionId);
    },

    getOnlineAgents() {
      return getOnlineAgentsStmt.all() as Agent[];
    },

    getSubscribers(event) {
      const rows = getSubscribersStmt.all(event) as { session_id: string }[];
      return rows.map((r) => r.session_id);
    },

    purgeOldMessages(maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const result = purgeOldMessagesStmt.run(cutoff);
      return result.changes;
    },

    touchAgent(sessionId) {
      touchAgentStmt.run(Date.now(), sessionId);
    },

    addApiKey(key, label) {
      insertApiKeyStmt.run(key, label, Date.now());
    },

    createApiKey(label) {
      const key = randomBytes(24).toString("base64url");
      insertApiKeyStmt.run(key, label, Date.now());
      return key;
    },

    hasAnyApiKey() {
      return !!hasAnyApiKeyStmt.get();
    },

    validateApiKey(key) {
      return !!validateApiKeyStmt.get(key);
    },

    createInviteCode() {
      const code = randomBytes(4).toString("hex"); // 8-char hex
      insertInviteCodeStmt.run(code, Date.now());
      return code;
    },

    redeemInviteCode(code) {
      const result = redeemInviteCodeStmt.run(code);
      if (result.changes === 0) return null;
      const key = this.createApiKey(`invited-${code}`);
      return key;
    },

    getOrCreateInboxToken(sessionId, ttlMs) {
      const now = Date.now();
      // Return existing valid token if one exists
      const existing = getInboxTokenStmt.get(sessionId, now) as { token: string } | undefined;
      if (existing) return existing.token;
      // Clean up expired tokens lazily, then create new one
      deleteExpiredTokensStmt.run(now);
      const token = randomBytes(24).toString("base64url");
      upsertInboxTokenStmt.run(token, sessionId, now + ttlMs);
      return token;
    },

    validateInboxToken(sessionId, token) {
      return !!validateInboxTokenStmt.get(sessionId, token, Date.now());
    },

    // ── Mesh networking methods ──

    upsertPeer(peer) {
      upsertPeerStmt.run({
        node_id: peer.node_id,
        addr: peer.addr,
        last_seen: Date.now(),
        agents_json: peer.agents_json ?? "[]",
      });
    },

    getPeers() {
      return getPeersStmt.all() as Peer[];
    },

    getPeer(nodeId) {
      return (getPeerStmt.get(nodeId) as Peer) ?? null;
    },

    removePeer(nodeId) {
      removePeerStmt.run(nodeId);
    },

    incrementMissedGossip(nodeId) {
      incrementMissedGossipStmt.run(nodeId);
    },

    resetMissedGossip(nodeId) {
      resetMissedGossipStmt.run(nodeId);
    },

    setPeerStatus(nodeId, status) {
      setPeerStatusStmt.run(status, nodeId);
    },

    createMessageWithGlobalId(from, to, content, globalId, deliveryStatus = "delivered") {
      createMessageWithGlobalIdStmt.run(from, to, content, Date.now(), globalId, deliveryStatus);
    },

    getPendingMessages() {
      return getPendingMessagesStmt.all() as Message[];
    },

    markDelivered(globalId) {
      markDeliveredStmt.run(globalId);
    },

    hasSeenMessage(globalId) {
      return !!hasSeenMessageStmt.get(globalId);
    },

    markMessageSeen(globalId) {
      const expires = Date.now() + 24 * 60 * 60 * 1000; // 24h
      markMessageSeenStmt.run(globalId, expires);
    },

    purgeExpiredSeenIds() {
      purgeExpiredSeenIdsStmt.run(Date.now());
    },

    // ── Rooms methods ──

    createRoom(name) {
      createRoomStmt.run(name, Date.now());
    },

    joinRoom(roomName, sessionId, notify = "all") {
      createRoomStmt.run(roomName, Date.now()); // ensure room exists
      joinRoomStmt.run(roomName, sessionId, Date.now(), notify);
    },

    leaveRoom(roomName, sessionId) {
      leaveRoomStmt.run(roomName, sessionId);
    },

    getRoomMembers(roomName) {
      const rows = getRoomMembersStmt.all(roomName) as { session_id: string }[];
      return rows.map((r) => r.session_id);
    },

    getRoomMemberNotify(roomName, sessionId) {
      const row = getRoomMemberNotifyStmt.get(roomName, sessionId) as { notify: string } | undefined;
      return row?.notify ?? "all";
    },

    getAgentRooms(sessionId) {
      const rows = getAgentRoomsStmt.all(sessionId) as { room_name: string }[];
      return rows.map((r) => r.room_name);
    },

    listRooms() {
      const rows = listRoomsStmt.all() as { name: string; member_count: number }[];
      return rows.map((r) => ({ name: r.name, memberCount: r.member_count }));
    },

    getRoomsSnapshot() {
      const rows = getRoomsSnapshotStmt.all() as { name: string; session_id: string | null }[];
      const map = new Map<string, string[]>();
      for (const r of rows) {
        if (!map.has(r.name)) map.set(r.name, []);
        if (r.session_id) map.get(r.name)!.push(r.session_id);
      }
      return Array.from(map.entries()).map(([name, members]) => ({ name, members }));
    },

    mergeRooms(rooms) {
      for (const room of rooms) {
        createRoomStmt.run(room.name, Date.now());
        for (const member of room.members) {
          joinRoomStmt.run(room.name, member, Date.now(), 1);
        }
      }
    },

    // ── Room messages methods ──

    createRoomMessage(from, room, content, extra?) {
      const globalId = randomUUID();
      const info = createRoomMessageStmt.run(
        globalId, from, room, content, Date.now(),
        extra?.replyToId ?? null, extra?.mentionsJson ?? "[]"
      );
      return Number(info.lastInsertRowid);
    },

    getRoomMessages(room, limit, before?) {
      if (before) {
        return getRoomMessagesBeforeStmt.all(room, before, limit) as RoomMessage[];
      }
      return getRoomMessagesStmt.all(room, limit) as RoomMessage[];
    },

    // ── Notification prefs methods ──

    setNotifyPref(sessionId, roomName, level) {
      setNotifyPrefStmt.run(sessionId, roomName, level);
    },

    resolveNotifyLevel(sessionId, roomName) {
      // per-room pref → global pref → "all"
      const roomPref = getNotifyPrefStmt.get(sessionId, roomName) as { level: string } | undefined;
      if (roomPref) return roomPref.level;
      const globalPref = getGlobalNotifyPrefStmt.get(sessionId) as { level: string } | undefined;
      if (globalPref) return globalPref.level;
      return "all";
    },

    upsertRemoteAgent(agent, originNodeId) {
      const now = Date.now();
      upsertRemoteAgentStmt.run({
        session_id: agent.session_id,
        name: agent.name ?? "",
        agent_type: agent.agent_type ?? "",
        machine: agent.machine ?? "",
        cwd: agent.cwd ?? "",
        cwd_remote: agent.cwd_remote ?? "",
        branch: agent.branch ?? "",
        status: agent.status ?? "",
        dirty_files: agent.dirty_files ?? "[]",
        background_processes: agent.background_processes ?? "[]",
        git_diff: agent.git_diff ?? "",
        conversation_recent: agent.conversation_recent ?? "",
        terminal: agent.terminal ?? "",
        pid: agent.pid ?? 0,
        last_seen: now,
        online: agent.online ?? 1,
        origin_node: originNodeId,
        last_seen_logical: (agent as any).last_seen_logical ?? 0,
      });
    },
  };
}
