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
        background_processes: agent.background_processes ?? "[]",
        git_diff: agent.git_diff ?? "",
        conversation_recent: agent.conversation_recent ?? "",
        terminal: agent.terminal ?? "",
        pid: agent.pid ?? 0,
        last_seen: Date.now(),
        online: 1,
      };
      if (idx >= 0) {
        // Merge: only overwrite fields that are provided (non-default)
        const existing = agents[idx];
        agents[idx] = {
          ...existing,
          ...full,
          // Preserve existing non-empty values if new value is empty
          agent_type: full.agent_type || existing.agent_type,
          machine: full.machine || existing.machine,
          cwd: full.cwd || existing.cwd,
          cwd_remote: full.cwd_remote || existing.cwd_remote,
          branch: full.branch || existing.branch,
          status: full.status || existing.status,
          last_seen: full.last_seen,
          online: 1,
        };
      } else {
        agents.push(full);
      }
    }),
    getAgents: vi.fn((room?: string) => {
      if (room) return agents.filter((a) => a.cwd.includes(room));
      return [...agents];
    }),
    getAgent: vi.fn((name: string) => agents.find((a) => a.session_id === name) ?? null),
    getAgentByPid: vi.fn((pid: number) => agents.find((a) => a.pid === pid && a.online === 1) ?? null),
    createMessage: vi.fn((from: string, to: string, content: string) => {
      messages.push({ id: ++msgId, from_agent: from, to_agent: to, content, timestamp: Date.now(), read: 0 });
    }),
    getUnreadMessages: vi.fn((agentName: string) =>
      messages.filter((m) => m.to_agent === agentName && m.read === 0),
    ),
    getMessages: vi.fn((agentName: string, limit: number) =>
      messages.filter((m) => m.to_agent === agentName).reverse().slice(0, limit),
    ),
    markRead: vi.fn((agentName: string) => {
      for (const m of messages) {
        if (m.to_agent === agentName) m.read = 1;
      }
    }),
    markOffline: vi.fn(),
    getOnlineAgents: vi.fn(() => agents.filter((a) => a.online === 1)),
    getSubscribers: vi.fn(() => []),
    purgeOldMessages: vi.fn(() => 0),
    touchAgent: vi.fn(),
    addApiKey: vi.fn(),
    createApiKey: vi.fn(() => "test-key"),
    validateApiKey: vi.fn(() => true),
    hasAnyApiKey: vi.fn(() => true),
    createInviteCode: vi.fn(() => "abc123"),
    redeemInviteCode: vi.fn(() => "redeemed-key"),
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
    expect(server.mcpServer).toBeDefined();
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

  it("who tool returns agents (auto-registers caller)", async () => {
    // Pre-register another agent in the DB
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
    // Should have alice + the auto-registered caller
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const alice = agents.find((a: any) => a.id === "alice");
    expect(alice).toBeDefined();
    expect(alice.type).toBe("claude-code");
  });

  it("who with cwd filter", async () => {
    store.upsertAgent({ session_id: "a1", cwd: "/home/user/project-x" });
    store.upsertAgent({ session_id: "a2", cwd: "/home/user/project-y" });

    const result = await client.callTool({
      name: "who",
      arguments: { cwd: "project-x" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const agents = JSON.parse(text);
    const ids = agents.map((a: any) => a.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("a2");
  });

  it("who with repo filter", async () => {
    store.upsertAgent({ session_id: "a1", cwd: "/home/alice/hotline", cwd_remote: "git@github.com:seahyc/agent-hotline.git" });
    store.upsertAgent({ session_id: "a2", cwd: "/home/bob/other", cwd_remote: "git@github.com:bob/other-repo.git" });

    const result = await client.callTool({
      name: "who",
      arguments: { repo: "agent-hotline" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const agents = JSON.parse(text);
    const ids = agents.map((a: any) => a.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("a2");
  });

  it("who with branch filter", async () => {
    store.upsertAgent({ session_id: "a1", branch: "main" });
    store.upsertAgent({ session_id: "a2", branch: "feature/xyz" });

    const result = await client.callTool({
      name: "who",
      arguments: { branch: "main" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const agents = JSON.parse(text);
    const ids = agents.map((a: any) => a.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("a2");
  });

  it("message tool auto-registers and sends direct message", async () => {
    store.upsertAgent({ session_id: "bob" });

    const result = await client.callTool({
      name: "message",
      arguments: { to: "bob", content: "hello bob" },
    });
    expect(result.isError).toBeFalsy();

    const msgs = store.getUnreadMessages("bob");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("hello bob");
  });

  it("message tool broadcasts to all except sender", async () => {
    // First call any tool to auto-register the caller
    await client.callTool({ name: "who", arguments: {} });

    // Get the auto-generated session_id for the caller
    const onlineAgents = store.getOnlineAgents();
    const callerAgent = onlineAgents.find(a => a.session_id !== "bob" && a.session_id !== "charlie");
    expect(callerAgent).toBeDefined();

    store.upsertAgent({ session_id: "bob" });
    store.upsertAgent({ session_id: "charlie" });

    const result = await client.callTool({
      name: "message",
      arguments: { to: "*", content: "hey everyone" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toMatch(/Broadcast sent to \d+ .*agent\(s\)/);

    expect(store.getUnreadMessages("bob")).toHaveLength(1);
    expect(store.getUnreadMessages("charlie")).toHaveLength(1);
  });

  it("inbox tool returns unread messages", async () => {
    // Auto-register by calling who first
    await client.callTool({ name: "who", arguments: {} });

    // Find the auto-registered agent
    const onlineAgents = store.getOnlineAgents();
    expect(onlineAgents.length).toBeGreaterThanOrEqual(1);
    const callerId = onlineAgents[0].session_id;

    store.createMessage("bob", callerId, "hey there");
    store.createMessage("charlie", callerId, "hi");

    const result = await client.callTool({
      name: "inbox",
      arguments: {},
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const messages = JSON.parse(text);
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBeDefined();
    expect(messages[0].content).toBe("hey there");
    expect(messages[0].time).toBeDefined();
    // Should not have raw DB fields
    expect(messages[0].to_agent).toBeUndefined();
    expect(messages[0].read).toBeUndefined();
  });

  it("inbox with mark_read=false does not mark messages as read", async () => {
    await client.callTool({ name: "who", arguments: {} });
    const callerId = store.getOnlineAgents()[0].session_id;

    store.createMessage("bob", callerId, "msg1");

    await client.callTool({
      name: "inbox",
      arguments: { mark_read: false },
    });

    const msgs = store.getUnreadMessages(callerId);
    expect(msgs).toHaveLength(1);
  });

  it("inbox with mark_read=true (default) marks messages as read", async () => {
    await client.callTool({ name: "who", arguments: {} });
    const callerId = store.getOnlineAgents()[0].session_id;

    store.createMessage("bob", callerId, "msg1");

    await client.callTool({
      name: "inbox",
      arguments: {},
    });

    const msgs = store.getUnreadMessages(callerId);
    expect(msgs).toHaveLength(0);
  });

  it("lists tools correctly", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["inbox", "listen", "message", "rename", "who"]);
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
