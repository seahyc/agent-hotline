import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "./server.js";
import { createStore, type Store } from "./store.js";
import type { Agent, Message } from "./store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { unlinkSync } from "node:fs";
import type { Server as HttpServer } from "node:http";

const TEST_DB = "/tmp/agent-hotline-server-test.db";
const TEST_PORT = 19876;

function cleanDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {
      // ignore
    }
  }
}

// ── Unit tests using mock store ──
function mockStore(): Store {
  const agents: Agent[] = [];
  const messages: Message[] = [];
  let msgId = 0;

  return {
    close: vi.fn(),
    upsertAgent: vi.fn((agent) => {
      const idx = agents.findIndex((a) => a.session_id === agent.session_id);
      const full: Agent = {
        session_id: agent.session_id,
        agent_type: agent.agent_type ?? "",
        machine: agent.machine ?? "",
        cwd: agent.cwd ?? "",
        cwd_remote: agent.cwd_remote ?? "",
        branch: agent.branch ?? "",
        status: agent.status ?? "",
        dirty_files: agent.dirty_files ?? "[]",
        git_diff: agent.git_diff ?? "",
        conversation_recent: agent.conversation_recent ?? "",
        last_seen: Date.now(),
        online: 1,
      };
      if (idx >= 0) agents[idx] = full;
      else agents.push(full);
    }),
    getAgents: vi.fn((room?: string) => {
      if (room) return agents.filter((a) => a.cwd.includes(room));
      return [...agents];
    }),
    getAgent: vi.fn((name: string) => agents.find((a) => a.session_id === name) ?? null),
    createMessage: vi.fn((from: string, to: string, content: string) => {
      messages.push({ id: ++msgId, from_agent: from, to_agent: to, content, timestamp: Date.now(), read: 0 });
    }),
    getUnreadMessages: vi.fn((agentName: string) =>
      messages.filter((m) => m.to_agent === agentName && m.read === 0),
    ),
    markRead: vi.fn((agentName: string) => {
      for (const m of messages) {
        if (m.to_agent === agentName) m.read = 1;
      }
    }),
    markOffline: vi.fn(),
    getOnlineAgents: vi.fn(() => agents.filter((a) => a.online === 1)),
  };
}

describe("server - createServer structure", () => {
  it("returns app, getServer, and transports", () => {
    const store = mockStore();
    const result = createServer(store);
    expect(result.app).toBeDefined();
    expect(result.getServer).toBeInstanceOf(Function);
    expect(result.transports).toBeDefined();
  });

  it("getServer creates an McpServer with tools and resources", () => {
    const store = mockStore();
    const { getServer } = createServer(store);
    const server = getServer();
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

describe("server - health endpoint", () => {
  let store: Store;
  let httpServer: HttpServer;

  beforeEach(() => {
    store = mockStore();
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it("GET /health returns ok", async () => {
    const { app } = createServer(store);
    httpServer = app.listen(TEST_PORT + 1);
    const res = await fetch(`http://127.0.0.1:${TEST_PORT + 1}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("server - MCP tools via client", () => {
  let store: Store;
  let httpServer: HttpServer;
  let client: Client;

  beforeEach(async () => {
    cleanDb();
    store = createStore(TEST_DB);
    const { app } = createServer(store);
    httpServer = app.listen(TEST_PORT);

    client = new Client({ name: "test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${TEST_PORT}/mcp`),
    );
    await client.connect(transport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    store.close();
    cleanDb();
  });

  it("checkin tool stores agent and returns confirmation", async () => {
    const result = await client.callTool({
      name: "checkin",
      arguments: {
        session_id: "alice",
        agent_type: "claude-code",
        machine: "mac-1",
        cwd: "/home/alice/project",
        branch: "main",
        status: "working",
      },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Checked in as alice" },
    ]);

    const agent = store.getAgent("alice");
    expect(agent).not.toBeNull();
    expect(agent!.agent_type).toBe("claude-code");
    expect(agent!.cwd).toBe("/home/alice/project");
    expect(agent!.online).toBe(1);
  });

  it("checkin with optional fields", async () => {
    const result = await client.callTool({
      name: "checkin",
      arguments: {
        session_id: "bob",
        agent_type: "opencode",
        machine: "linux-1",
        cwd: "/home/bob/repo",
        cwd_remote: "git@github.com:bob/repo.git",
        branch: "feature",
        status: "idle",
        dirty_files: ["file1.ts", "file2.ts"],
        git_diff: "diff --git a/file1.ts",
        conversation_recent: "discussing feature",
      },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Checked in as bob" },
    ]);

    const agent = store.getAgent("bob");
    expect(agent!.cwd_remote).toBe("git@github.com:bob/repo.git");
    expect(agent!.dirty_files).toBe('["file1.ts","file2.ts"]');
    expect(agent!.git_diff).toBe("diff --git a/file1.ts");
  });

  it("who tool returns agents", async () => {
    store.upsertAgent({
      session_id: "alice",
      agent_type: "claude-code",
      machine: "mac",
      cwd: "/project",
      branch: "main",
      status: "working",
    });

    const result = await client.callTool({ name: "who", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const agents = JSON.parse(text);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("alice");
    expect(agents[0].type).toBe("claude-code");
  });

  it("who with room filter", async () => {
    store.upsertAgent({ session_id: "a1", cwd: "/home/user/project-x" });
    store.upsertAgent({ session_id: "a2", cwd: "/home/user/project-y" });

    const result = await client.callTool({
      name: "who",
      arguments: { room: "project-x" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const agents = JSON.parse(text);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("a1");
  });

  it("message tool sends direct message", async () => {
    store.upsertAgent({ session_id: "bob" });

    const result = await client.callTool({
      name: "message",
      arguments: { from: "alice", to: "bob", content: "hello bob" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Message sent to bob" },
    ]);

    const msgs = store.getUnreadMessages("bob");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hello bob");
    expect(msgs[0].from_agent).toBe("alice");
  });

  it("message tool broadcasts to all except sender", async () => {
    store.upsertAgent({ session_id: "alice" });
    store.upsertAgent({ session_id: "bob" });
    store.upsertAgent({ session_id: "charlie" });

    const result = await client.callTool({
      name: "message",
      arguments: { from: "alice", to: "*", content: "hey everyone" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe("Broadcast sent to 2 agent(s)");

    expect(store.getUnreadMessages("bob")).toHaveLength(1);
    expect(store.getUnreadMessages("charlie")).toHaveLength(1);
    expect(store.getUnreadMessages("alice")).toHaveLength(0);
  });

  it("inbox tool returns unread messages", async () => {
    store.createMessage("bob", "alice", "hey alice");
    store.createMessage("charlie", "alice", "hi there");

    const result = await client.callTool({
      name: "inbox",
      arguments: { session_id: "alice" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const messages = JSON.parse(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("hey alice");
  });

  it("inbox with mark_read=false does not mark messages as read", async () => {
    store.createMessage("bob", "alice", "msg1");

    await client.callTool({
      name: "inbox",
      arguments: { session_id: "alice", mark_read: false },
    });

    // Messages should still be unread
    const msgs = store.getUnreadMessages("alice");
    expect(msgs).toHaveLength(1);
  });

  it("inbox with mark_read=true (default) marks messages as read", async () => {
    store.createMessage("bob", "alice", "msg1");

    await client.callTool({
      name: "inbox",
      arguments: { session_id: "alice" },
    });

    const msgs = store.getUnreadMessages("alice");
    expect(msgs).toHaveLength(0);
  });

  it("lists tools correctly", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["checkin", "inbox", "message", "who"]);
  });

  it("lists resources correctly", async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBeGreaterThanOrEqual(1);
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("hotline://agents");
  });

  it("lists resource templates correctly", async () => {
    const result = await client.listResourceTemplates();
    const templates = result.resourceTemplates.map((t) => t.uriTemplate).sort();
    expect(templates).toEqual([
      "hotline://agent/{name}/conversation",
      "hotline://agent/{name}/diff",
      "hotline://agent/{name}/inbox",
      "hotline://agent/{name}/status",
    ]);
  });

  it("reads hotline://agents resource", async () => {
    store.upsertAgent({ session_id: "alice", status: "working" });

    const result = await client.readResource({ uri: "hotline://agents" });
    const text = (result.contents[0] as { text: string }).text;
    const agents = JSON.parse(text);
    expect(agents).toHaveLength(1);
    expect(agents[0].session_id).toBe("alice");
  });

  it("reads agent status resource template", async () => {
    store.upsertAgent({
      session_id: "alice",
      status: "coding",
      cwd: "/home/alice",
    });

    const result = await client.readResource({
      uri: "hotline://agent/alice/status",
    });
    const text = (result.contents[0] as { text: string }).text;
    const agent = JSON.parse(text);
    expect(agent.session_id).toBe("alice");
    expect(agent.status).toBe("coding");
  });

  it("reads agent diff resource template", async () => {
    store.upsertAgent({
      session_id: "alice",
      git_diff: "diff --git a/foo.ts",
    });

    const result = await client.readResource({
      uri: "hotline://agent/alice/diff",
    });
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toBe("diff --git a/foo.ts");
  });

  it("reads agent conversation resource template", async () => {
    store.upsertAgent({
      session_id: "alice",
      conversation_recent: "discussing architecture",
    });

    const result = await client.readResource({
      uri: "hotline://agent/alice/conversation",
    });
    const text = (result.contents[0] as { text: string }).text;
    expect(text).toBe("discussing architecture");
  });

  it("reads agent inbox resource template", async () => {
    store.upsertAgent({ session_id: "alice" });
    store.createMessage("bob", "alice", "hello");

    const result = await client.readResource({
      uri: "hotline://agent/alice/inbox",
    });
    const text = (result.contents[0] as { text: string }).text;
    const messages = JSON.parse(text);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("hello");
  });
});
