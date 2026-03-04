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

export function createStore(dbPath?: string): Store {
  const db = new Database(dbPath ?? "./hotline.db");
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_AGENTS);
  db.exec(CREATE_MESSAGES);
  db.exec(CREATE_MESSAGES_INDEX);

  const upsertAgentStmt = db.prepare(`
    INSERT INTO agents (agent_name, agent_type, machine, cwd, cwd_remote, branch, status, dirty_files, background_processes, git_diff, conversation_recent, last_seen, online)
    VALUES (@agent_name, @agent_type, @machine, @cwd, @cwd_remote, @branch, @status, @dirty_files, @background_processes, @git_diff, @conversation_recent, @last_seen, @online)
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
  };
}
