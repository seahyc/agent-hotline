import { randomBytes } from "node:crypto";
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
  from_agent: string;
  to_agent: string;
  content: string;
  timestamp: number; // unix ms
  read: number; // 0 or 1
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
  createMessage(from: string, to: string, content: string): void;
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
    "INSERT INTO messages (from_agent, to_agent, content, timestamp, read) VALUES (?, ?, ?, ?, 0)",
  );
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

    createMessage(from, to, content) {
      createMessageStmt.run(from, to, content, Date.now());
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
  };
}
