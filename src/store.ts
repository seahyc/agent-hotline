import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export interface Agent {
  agent_name: string;
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
  session_id: string;
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
  upsertAgent(agent: Partial<Agent> & { agent_name: string }): void;
  getAgents(room?: string): Agent[];
  getAgent(name: string): Agent | null;
  createMessage(from: string, to: string, content: string): void;
  getUnreadMessages(agentName: string): Message[];
  markRead(agentName: string): void;
  markOffline(agentName: string): void;
  getOnlineAgents(): Agent[];
  subscribe(agentName: string, events: EventType[]): void;
  unsubscribe(agentName: string, events: EventType[]): void;
  getSubscriptions(agentName: string): EventType[];
  getSubscribers(event: EventType): string[];
  purgeOldMessages(maxAgeDays: number): number;
  touchAgent(agentName: string): void;
  addApiKey(key: string, label: string): void;
  createApiKey(label: string): string;
  validateApiKey(key: string): boolean;
  hasAnyApiKey(): boolean;
  createInviteCode(): string;
  redeemInviteCode(code: string): string | null;
}

const CREATE_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  agent_name TEXT PRIMARY KEY,
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
  session_id TEXT DEFAULT '',
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
  agent_name TEXT NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (agent_name, event)
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

export function createStore(dbPath?: string): Store {
  const db = new Database(dbPath ?? "./hotline.db");
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_AGENTS);
  db.exec(CREATE_MESSAGES);
  db.exec(CREATE_MESSAGES_INDEX);
  db.exec(CREATE_SUBSCRIPTIONS);
  db.exec(CREATE_API_KEYS);
  db.exec(CREATE_INVITE_CODES);

  // Migrate: add new columns if missing
  const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("session_id")) db.exec("ALTER TABLE agents ADD COLUMN session_id TEXT DEFAULT ''");
  if (!colNames.has("terminal")) db.exec("ALTER TABLE agents ADD COLUMN terminal TEXT DEFAULT ''");
  if (!colNames.has("pid")) db.exec("ALTER TABLE agents ADD COLUMN pid INTEGER DEFAULT 0");

  const upsertAgentStmt = db.prepare(`
    INSERT INTO agents (agent_name, agent_type, machine, cwd, cwd_remote, branch, status, dirty_files, background_processes, git_diff, conversation_recent, session_id, terminal, pid, last_seen, online)
    VALUES (@agent_name, @agent_type, @machine, @cwd, @cwd_remote, @branch, @status, @dirty_files, @background_processes, @git_diff, @conversation_recent, @session_id, @terminal, @pid, @last_seen, @online)
    ON CONFLICT(agent_name) DO UPDATE SET
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
      session_id = @session_id,
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
    "SELECT * FROM agents WHERE agent_name = ?",
  );
  const getOnlineAgentsStmt = db.prepare(
    "SELECT * FROM agents WHERE online = 1",
  );

  const createMessageStmt = db.prepare(
    "INSERT INTO messages (from_agent, to_agent, content, timestamp, read) VALUES (?, ?, ?, ?, 0)",
  );
  const getUnreadMessagesStmt = db.prepare(
    "SELECT * FROM messages WHERE to_agent = ? AND read = 0 ORDER BY timestamp ASC",
  );
  const markReadStmt = db.prepare(
    "UPDATE messages SET read = 1 WHERE to_agent = ? AND read = 0",
  );
  const markOfflineStmt = db.prepare(
    "UPDATE agents SET online = 0 WHERE agent_name = ?",
  );
  const purgeOldMessagesStmt = db.prepare(
    "DELETE FROM messages WHERE timestamp < ?",
  );
  const touchAgentStmt = db.prepare(
    "UPDATE agents SET last_seen = ? WHERE agent_name = ?",
  );
  const subscribeStmt = db.prepare(
    "INSERT OR IGNORE INTO subscriptions (agent_name, event) VALUES (?, ?)",
  );
  const unsubscribeStmt = db.prepare(
    "DELETE FROM subscriptions WHERE agent_name = ? AND event = ?",
  );
  const getSubscriptionsStmt = db.prepare(
    "SELECT event FROM subscriptions WHERE agent_name = ?",
  );
  const getSubscribersStmt = db.prepare(
    "SELECT agent_name FROM subscriptions WHERE event = ?",
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
  const insertInviteCodeStmt = db.prepare(
    "INSERT INTO invite_codes (code, created_at, used) VALUES (?, ?, 0)",
  );
  const redeemInviteCodeStmt = db.prepare(
    "UPDATE invite_codes SET used = 1 WHERE code = ? AND used = 0",
  );

  return {
    close() {
      db.close();
    },

    upsertAgent(agent) {
      const now = Date.now();
      const row = {
        agent_name: agent.agent_name,
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
        session_id: agent.session_id ?? "",
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

    getAgent(name) {
      return (getAgentStmt.get(name) as Agent) ?? null;
    },

    createMessage(from, to, content) {
      createMessageStmt.run(from, to, content, Date.now());
    },

    getUnreadMessages(agentName) {
      return getUnreadMessagesStmt.all(agentName) as Message[];
    },

    markRead(agentName) {
      markReadStmt.run(agentName);
    },

    markOffline(agentName) {
      markOfflineStmt.run(agentName);
    },

    getOnlineAgents() {
      return getOnlineAgentsStmt.all() as Agent[];
    },

    subscribe(agentName, events) {
      for (const event of events) {
        subscribeStmt.run(agentName, event);
      }
    },

    unsubscribe(agentName, events) {
      for (const event of events) {
        unsubscribeStmt.run(agentName, event);
      }
    },

    getSubscriptions(agentName) {
      const rows = getSubscriptionsStmt.all(agentName) as { event: string }[];
      return rows.map((r) => r.event as EventType);
    },

    getSubscribers(event) {
      const rows = getSubscribersStmt.all(event) as { agent_name: string }[];
      return rows.map((r) => r.agent_name);
    },

    purgeOldMessages(maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const result = purgeOldMessagesStmt.run(cutoff);
      return result.changes;
    },

    touchAgent(agentName) {
      touchAgentStmt.run(Date.now(), agentName);
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
  };
}
