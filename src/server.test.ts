import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "./server.js";
import { createStore } from "./store.js";
import { unlinkSync } from "node:fs";
import type { Server as HttpServer } from "node:http";

const TEST_DB = "/tmp/agent-hotline-server-test.db";
// Each test listens on a fresh ephemeral port: reusing a fixed port lets the
// global fetch keep-alive pool hand a dead socket to the next test (ECONNRESET).
let BASE = "";

function cleanDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
}

async function post(path: string, body: unknown, key?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function get(path: string, key?: string) {
  const headers: Record<string, string> = {};
  if (key) headers["Authorization"] = `Bearer ${key}`;
  return fetch(`${BASE}${path}`, { headers });
}


describe("server REST API", () => {
  let server: HttpServer;
  let masterKey: string;

  beforeEach(async () => {
    cleanDb();
    const store = createStore(TEST_DB);
    const result = createServer(store, { port: 0 });
    masterKey = result.masterKey;
    await new Promise<void>(resolve => {
      server = result.app.listen(0, resolve);
    });
    const addr = server.address();
    BASE = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    cleanDb();
  });

  // ── Health ──
  describe("health endpoint", () => {
    it("GET /health returns ok", async () => {
      const res = await get("/health");
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe("ok");
    });
  });

  // ── Agents ──
  describe("GET /api/agents", () => {
    it("returns empty list by default", async () => {
      const res = await get("/api/agents");
      expect(res.status).toBe(200);
      const agents = await res.json();
      expect(Array.isArray(agents)).toBe(true);
    });

    it("returns agent after heartbeat", async () => {
      // Use a real PID (process.pid is always alive) to avoid auto-prune
      await post("/api/heartbeat", { session_id: "agent-a", pid: process.pid });
      const res = await get("/api/agents?online=true");
      expect(res.status).toBe(200);
      const agents = await res.json() as Array<{ session_id: string }>;
      expect(agents.some(a => a.session_id === "agent-a")).toBe(true);
    });
  });

  // ── Heartbeat ──
  describe("POST /api/heartbeat", () => {
    it("registers an agent", async () => {
      const res = await post("/api/heartbeat", { session_id: "agent-hb", pid: 1234 });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; session_id: string };
      expect(body.ok).toBe(true);
      expect(body.session_id).toBe("agent-hb");
    });

    it("requires session_id", async () => {
      const res = await post("/api/heartbeat", { pid: 1234 });
      expect(res.status).toBe(400);
    });
  });

  // ── Message ──
  describe("POST /api/message", () => {
    it("delivers a direct message", async () => {
      await post("/api/heartbeat", { session_id: "sender", pid: 1 });
      await post("/api/heartbeat", { session_id: "receiver", pid: 2 });

      const res = await post("/api/message", { from: "sender", to: "receiver", content: "Hello!" });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);

      const inbox = await get(`/api/inbox/receiver`, masterKey);
      const msgs = await inbox.json() as Array<{ content: string }>;
      expect(msgs.some(m => m.content === "Hello!")).toBe(true);
    });

    it("broadcasts to all agents", async () => {
      await post("/api/heartbeat", { session_id: "broadcaster", pid: 1 });
      await post("/api/heartbeat", { session_id: "target-1", pid: 2 });
      await post("/api/heartbeat", { session_id: "target-2", pid: 3 });

      const res = await post("/api/message", { from: "broadcaster", to: "*", content: "All!" });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; broadcast: number };
      expect(body.broadcast).toBe(2);
    });

    it("delivers a room message", async () => {
      await post("/api/heartbeat", { session_id: "room-sender", pid: 1 });
      await post("/api/heartbeat", { session_id: "room-member", pid: 2 });
      await post("/api/rooms/join", { session_id: "room-member", room: "general" });

      const res = await post("/api/message", { from: "room-sender", to: "#general", content: "Hi room!" });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; room: string };
      expect(body.room).toBe("general");
    });

    it("requires from, to, and content", async () => {
      const res = await post("/api/message", { from: "a", to: "b" });
      expect(res.status).toBe(400);
    });
  });

  // ── Inbox ──
  describe("GET /api/inbox/:sessionId", () => {
    it("returns unread messages and marks them read", async () => {
      await post("/api/heartbeat", { session_id: "inbox-sender", pid: 1 });
      await post("/api/heartbeat", { session_id: "inbox-receiver", pid: 2 });
      await post("/api/message", { from: "inbox-sender", to: "inbox-receiver", content: "Test msg" });

      const res = await get("/api/inbox/inbox-receiver", masterKey);
      expect(res.status).toBe(200);
      const msgs = await res.json() as Array<{ content: string }>;
      expect(msgs.length).toBe(1);
      expect(msgs[0].content).toBe("Test msg");

      // Second read: should be empty (marked read)
      const res2 = await get("/api/inbox/inbox-receiver", masterKey);
      const msgs2 = await res2.json() as unknown[];
      expect(msgs2.length).toBe(0);
    });

    it("peek mode: mark_read=false does not mark as read", async () => {
      await post("/api/heartbeat", { session_id: "peek-sender", pid: 1 });
      await post("/api/heartbeat", { session_id: "peek-receiver", pid: 2 });
      await post("/api/message", { from: "peek-sender", to: "peek-receiver", content: "Peek!" });

      await get("/api/inbox/peek-receiver?mark_read=false", masterKey);
      const res2 = await get("/api/inbox/peek-receiver", masterKey);
      const msgs = await res2.json() as unknown[];
      expect(msgs.length).toBe(1);
    });
  });

  // ── Rename ──
  describe("POST /api/rename", () => {
    it("renames an agent", async () => {
      await post("/api/heartbeat", { session_id: "rename-me", pid: 1 });
      const res = await post("/api/rename", { session_id: "rename-me", name: "cool-agent" });
      expect(res.status).toBe(200);
      const body = await res.json() as { name: string };
      expect(body.name).toBe("cool-agent");
    });

    it("rejects invalid names", async () => {
      await post("/api/heartbeat", { session_id: "rename-bad", pid: 1 });
      const res = await post("/api/rename", { session_id: "rename-bad", name: "has spaces!" });
      expect(res.status).toBe(400);
    });

    it("rejects duplicate names", async () => {
      await post("/api/heartbeat", { session_id: "agent-x", pid: 1 });
      await post("/api/heartbeat", { session_id: "agent-y", pid: 2 });
      await post("/api/rename", { session_id: "agent-x", name: "taken-name" });

      const res = await post("/api/rename", { session_id: "agent-y", name: "taken-name" });
      expect(res.status).toBe(409);
    });
  });

  // ── Rooms ──
  describe("rooms API", () => {
    it("join creates room", async () => {
      await post("/api/heartbeat", { session_id: "joiner", pid: 1 });
      const res = await post("/api/rooms/join", { session_id: "joiner", room: "my-room" });
      expect(res.status).toBe(200);
      const body = await res.json() as { room: string; memberCount: number };
      expect(body.room).toBe("my-room");
      expect(body.memberCount).toBe(1);
    });

    it("join with # prefix strips it", async () => {
      await post("/api/heartbeat", { session_id: "joiner2", pid: 2 });
      const res = await post("/api/rooms/join", { session_id: "joiner2", room: "#general" });
      expect(res.status).toBe(200);
      const body = await res.json() as { room: string };
      expect(body.room).toBe("general");
    });

    it("leave removes from room", async () => {
      await post("/api/heartbeat", { session_id: "leaver", pid: 1 });
      await post("/api/rooms/join", { session_id: "leaver", room: "leaveable" });
      const res = await post("/api/rooms/leave", { session_id: "leaver", room: "leaveable" });
      expect(res.status).toBe(200);
    });

    it("GET /api/rooms lists rooms", async () => {
      await post("/api/heartbeat", { session_id: "rooms-tester", pid: 1 });
      await post("/api/rooms/join", { session_id: "rooms-tester", room: "test-room" });

      const res = await get("/api/rooms?session_id=rooms-tester");
      expect(res.status).toBe(200);
      const rooms = await res.json() as Array<{ name: string; joined?: boolean }>;
      const found = rooms.find(r => r.name === "test-room");
      expect(found).toBeDefined();
      expect(found?.joined).toBe(true);
    });

    it("GET /api/rooms?all=true shows all rooms", async () => {
      await post("/api/heartbeat", { session_id: "all-rooms-tester", pid: 1 });
      await post("/api/rooms/join", { session_id: "all-rooms-tester", room: "visible-room" });

      const res = await get("/api/rooms?all=true");
      expect(res.status).toBe(200);
      const rooms = await res.json() as Array<{ name: string }>;
      expect(rooms.some(r => r.name === "visible-room")).toBe(true);
    });
  });

  // ── Messages (history) ──
  describe("GET /api/messages", () => {
    it("returns room history", async () => {
      await post("/api/heartbeat", { session_id: "hist-sender", pid: 1 });
      await post("/api/message", { from: "hist-sender", to: "#history-room", content: "Room message" });

      const res = await get("/api/messages?room=history-room");
      expect(res.status).toBe(200);
      const msgs = await res.json() as Array<{ content: string }>;
      expect(msgs.some(m => m.content === "Room message")).toBe(true);
    });

    it("returns DM history", async () => {
      await post("/api/heartbeat", { session_id: "dm-a", pid: 1 });
      await post("/api/heartbeat", { session_id: "dm-b", pid: 2 });
      await post("/api/message", { from: "dm-a", to: "dm-b", content: "DM content" });

      const res = await get("/api/messages?session_id=dm-a&dm=dm-b");
      expect(res.status).toBe(200);
      const msgs = await res.json() as Array<{ content: string }>;
      expect(msgs.some(m => m.content === "DM content")).toBe(true);
    });

    it("requires room or dm", async () => {
      const res = await get("/api/messages");
      expect(res.status).toBe(400);
    });
  });

  // ── Notify ──
  describe("POST /api/notify", () => {
    it("sets room notification preference", async () => {
      await post("/api/heartbeat", { session_id: "notif-agent", pid: 1 });
      const res = await post("/api/notify", { session_id: "notif-agent", room: "general", level: "mentions" });
      expect(res.status).toBe(200);
      const body = await res.json() as { level: string; room: string };
      expect(body.level).toBe("mentions");
      expect(body.room).toBe("general");
    });

    it("sets global notification preference", async () => {
      await post("/api/heartbeat", { session_id: "global-notif", pid: 1 });
      const res = await post("/api/notify", { session_id: "global-notif", level: "mute" });
      expect(res.status).toBe(200);
    });

    it("rejects invalid level", async () => {
      const res = await post("/api/notify", { session_id: "x", level: "invalid" });
      expect(res.status).toBe(400);
    });
  });

  // ── Room fanout notification ──
  describe("room fanout", () => {
    it("muted member does not get inbox copy", async () => {
      await post("/api/heartbeat", { session_id: "fanout-sender", pid: 1 });
      await post("/api/heartbeat", { session_id: "fanout-muted", pid: 2 });
      await post("/api/rooms/join", { session_id: "fanout-muted", room: "muted-room" });
      await post("/api/notify", { session_id: "fanout-muted", room: "muted-room", level: "mute" });
      await post("/api/message", { from: "fanout-sender", to: "#muted-room", content: "You won't see this" });

      const inbox = await get("/api/inbox/fanout-muted", masterKey);
      const msgs = await inbox.json() as unknown[];
      expect(msgs.length).toBe(0);
    });

    it("mentions-only member gets inbox copy only when @mentioned", async () => {
      await post("/api/heartbeat", { session_id: "fanout-mentioner", pid: 1 });
      await post("/api/heartbeat", { session_id: "fanout-target", pid: 2 });
      await post("/api/rooms/join", { session_id: "fanout-target", room: "mention-room" });
      await post("/api/rename", { session_id: "fanout-target", name: "target-user" });
      await post("/api/notify", { session_id: "fanout-target", room: "mention-room", level: "mentions" });

      // Without mention
      await post("/api/message", { from: "fanout-mentioner", to: "#mention-room", content: "No mention here" });
      const inbox1 = await get("/api/inbox/fanout-target", masterKey);
      const msgs1 = await inbox1.json() as unknown[];
      expect(msgs1.length).toBe(0);

      // With mention
      await post("/api/message", { from: "fanout-mentioner", to: "#mention-room", content: "@target-user hello!" });
      const inbox2 = await get("/api/inbox/fanout-target", masterKey);
      const msgs2 = await inbox2.json() as unknown[];
      expect(msgs2.length).toBe(1);
    });
  });

  // ── Inbox token ──
  describe("POST /api/inbox-token", () => {
    it("issues a scoped inbox token", async () => {
      await post("/api/heartbeat", { session_id: "token-agent", pid: 1 });
      const res = await post("/api/inbox-token", { session_id: "token-agent" });
      expect(res.status).toBe(200);
      const body = await res.json() as { token: string };
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(10);
    });
  });

  // ── Invite/connect ──
  describe("invite flow", () => {
    it("creates and redeems invite code", async () => {
      const inviteRes = await post("/api/invite", {});
      expect(inviteRes.status).toBe(200);
      const { code } = await inviteRes.json() as { code: string };

      const connectRes = await post("/api/connect", { code });
      expect(connectRes.status).toBe(200);
      const { key } = await connectRes.json() as { key: string };
      expect(typeof key).toBe("string");

      // Used code should fail
      const reusedRes = await post("/api/connect", { code });
      expect(reusedRes.status).toBe(400);
    });
  });

  // ── SSE ──
  describe("GET /api/sse/:sessionId", () => {
    it("rejects without auth", async () => {
      const res = await get("/api/sse/agent-a");
      expect(res.status).toBe(403);
    });

    it("connects with valid inbox token", async () => {
      await post("/api/heartbeat", { session_id: "agent-a", pid: process.pid });
      const tokenRes = await post("/api/inbox-token", { session_id: "agent-a" }, masterKey);
      const { token } = await tokenRes.json() as { token: string };

      const controller = new AbortController();
      const res = await fetch(`${BASE}/api/sse/agent-a?token=${token}`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      controller.abort();
    });

    it("pushes messages to SSE clients in real time", async () => {
      await post("/api/heartbeat", { session_id: "agent-a", pid: process.pid });
      await post("/api/heartbeat", { session_id: "agent-b", pid: process.pid });
      const tokenRes = await post("/api/inbox-token", { session_id: "agent-a" }, masterKey);
      const { token } = await tokenRes.json() as { token: string };

      const controller = new AbortController();
      const res = await fetch(`${BASE}/api/sse/agent-a?token=${token}`, {
        signal: controller.signal,
      });

      // Give SSE connection time to register
      await new Promise(r => setTimeout(r, 50));

      // Send a message to agent-a
      await post("/api/message", { from: "agent-b", to: "agent-a", content: "hello via SSE" }, masterKey);

      // Read SSE stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let collected = "";
      const readUntilData = async () => {
        while (!collected.includes("data: ")) {
          const { value, done } = await reader.read();
          if (done) break;
          collected += decoder.decode(value, { stream: true });
        }
      };
      await readUntilData();
      controller.abort();

      const dataLine = collected.split("\n").find(l => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const msg = JSON.parse(dataLine!.replace("data: ", ""));
      expect(msg.content).toBe("hello via SSE");
      expect(msg.from_agent).toBe("agent-b");
    });

    it("filters by rooms when rooms param is set", async () => {
      await post("/api/heartbeat", { session_id: "agent-a", pid: process.pid });
      await post("/api/heartbeat", { session_id: "agent-b", pid: process.pid });

      // agent-a joins both rooms
      await post("/api/rooms/join", { session_id: "agent-a", room: "general" }, masterKey);
      await post("/api/rooms/join", { session_id: "agent-a", room: "deploys" }, masterKey);
      await post("/api/rooms/join", { session_id: "agent-b", room: "general" }, masterKey);
      await post("/api/rooms/join", { session_id: "agent-b", room: "deploys" }, masterKey);

      const tokenRes = await post("/api/inbox-token", { session_id: "agent-a" }, masterKey);
      const { token } = await tokenRes.json() as { token: string };

      // SSE filtered to only "general"
      const controller = new AbortController();
      const res = await fetch(`${BASE}/api/sse/agent-a?token=${token}&rooms=general`, {
        signal: controller.signal,
      });
      await new Promise(r => setTimeout(r, 50));

      // Send to #general (should arrive)
      await post("/api/message", { from: "agent-b", to: "#general", content: "general msg" }, masterKey);
      // Send to #deploys (should NOT arrive via SSE)
      await post("/api/message", { from: "agent-b", to: "#deploys", content: "deploys msg" }, masterKey);

      // Small delay to let SSE events flush
      await new Promise(r => setTimeout(r, 100));

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let collected = "";

      // Read available data with a timeout
      const readAvailable = async () => {
        const timeoutPromise = new Promise<void>(r => setTimeout(r, 200));
        const readPromise = (async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            collected += decoder.decode(value, { stream: true });
          }
        })();
        await Promise.race([readPromise, timeoutPromise]);
      };
      await readAvailable();
      controller.abort();

      const dataLines = collected.split("\n").filter(l => l.startsWith("data: "));
      const messages = dataLines.map(l => JSON.parse(l.replace("data: ", "")));

      // Should have the general message but NOT the deploys message
      expect(messages.some((m: { content: string }) => m.content === "general msg")).toBe(true);
      expect(messages.some((m: { content: string }) => m.content === "deploys msg")).toBe(false);
    });

    it("delivers all messages when no rooms filter", async () => {
      await post("/api/heartbeat", { session_id: "agent-a", pid: process.pid });
      await post("/api/heartbeat", { session_id: "agent-b", pid: process.pid });
      await post("/api/rooms/join", { session_id: "agent-a", room: "general" }, masterKey);
      await post("/api/rooms/join", { session_id: "agent-b", room: "general" }, masterKey);

      const tokenRes = await post("/api/inbox-token", { session_id: "agent-a" }, masterKey);
      const { token } = await tokenRes.json() as { token: string };

      // SSE with no rooms filter
      const controller = new AbortController();
      const res = await fetch(`${BASE}/api/sse/agent-a?token=${token}`, {
        signal: controller.signal,
      });
      await new Promise(r => setTimeout(r, 50));

      // Send a DM and a room message
      await post("/api/message", { from: "agent-b", to: "agent-a", content: "dm msg" }, masterKey);
      await post("/api/message", { from: "agent-b", to: "#general", content: "room msg" }, masterKey);

      await new Promise(r => setTimeout(r, 100));

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let collected = "";
      const readAvailable = async () => {
        const timeoutPromise = new Promise<void>(r => setTimeout(r, 200));
        const readPromise = (async () => {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            collected += decoder.decode(value, { stream: true });
          }
        })();
        await Promise.race([readPromise, timeoutPromise]);
      };
      await readAvailable();
      controller.abort();

      const dataLines = collected.split("\n").filter(l => l.startsWith("data: "));
      const messages = dataLines.map(l => JSON.parse(l.replace("data: ", "")));

      expect(messages.some((m: { content: string }) => m.content === "dm msg")).toBe(true);
      expect(messages.some((m: { content: string }) => m.content === "room msg")).toBe(true);
    });
  });

  // ── Heartbeat response & auto-naming ──
  describe("heartbeat greeting payload", () => {
    it("returns name, unread count, and online roster", async () => {
      await post("/api/heartbeat", { session_id: "other-agent", pid: 1111 });
      await post("/api/message", { from: "other-agent", to: "greeted", content: "hi" }, masterKey);

      const res = await post("/api/heartbeat", { session_id: "greeted", pid: 2222 });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; name: string; unread: number; online: { id: string }[] };
      expect(body.ok).toBe(true);
      expect(body.unread).toBe(1);
      expect(body.online.some(a => a.id === "other-agent")).toBe(true);
      expect(body.online.some(a => a.id === "greeted")).toBe(false);
    });

    it("auto-names an unnamed agent from its tab title", async () => {
      const res = await post("/api/heartbeat", { session_id: "titled", pid: 3333, title: "Auth Refactor!" });
      const body = await res.json() as { name: string };
      expect(body.name).toBe("Auth-Refactor");
    });

    it("suffixes colliding auto-names with a session-id fragment", async () => {
      await post("/api/heartbeat", { session_id: "aaaa1111", pid: 4444, title: "worker" });
      const res = await post("/api/heartbeat", { session_id: "bbbb2222", pid: 5555, title: "worker" });
      const body = await res.json() as { name: string };
      expect(body.name).toBe("worker-bbbb");
    });

    it("does not overwrite a manual rename with the tab title", async () => {
      await post("/api/heartbeat", { session_id: "manual", pid: 6666, title: "tab-name" });
      await post("/api/rename", { session_id: "manual", name: "my-chosen-name" }, masterKey);
      const res = await post("/api/heartbeat", { session_id: "manual", pid: 6666, title: "tab-name-changed" });
      const body = await res.json() as { name: string };
      expect(body.name).toBe("my-chosen-name");
    });

    it("propagates a tab rename when the name came from the old title", async () => {
      await post("/api/heartbeat", { session_id: "renamer", pid: 7777, title: "old-tab" });
      const res = await post("/api/heartbeat", { session_id: "renamer", pid: 7777, title: "new-tab" });
      const body = await res.json() as { name: string };
      expect(body.name).toBe("new-tab");
    });

    it("does not wipe context fields on a bare heartbeat", async () => {
      await post("/api/heartbeat", { session_id: "ctx-keeper", pid: 8888, cwd: "/tmp/project" });
      await post("/api/heartbeat", { session_id: "ctx-keeper", pid: 8888 });
      const res = await get("/api/agents", masterKey);
      const agents = await res.json() as { session_id: string; cwd: string }[];
      const agent = agents.find(a => a.session_id === "ctx-keeper");
      expect(agent?.cwd).toBe("/tmp/project");
    });
  });

  describe("name-based addressing", () => {
    it("inbox accepts a friendly name and resolves it to the session", async () => {
      await post("/api/heartbeat", { session_id: "name-sess", pid: 11111, title: "namey" });
      await post("/api/message", { from: "x", to: "namey", content: "by name" }, masterKey);
      const res = await get("/api/inbox/namey", masterKey);
      const msgs = await res.json() as { to_agent: string; content: string }[];
      expect(msgs.length).toBe(1);
      expect(msgs[0].to_agent).toBe("name-sess");
      expect(msgs[0].content).toBe("by name");
    });
  });

  // ── GET /api/status ──
  describe("GET /api/status", () => {
    it("returns server info and online agents", async () => {
      await post("/api/heartbeat", { session_id: "status-agent", pid: 9999 });
      const res = await get("/api/status", masterKey);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        server: { version: string; mesh: boolean; peers: number };
        agents_online: { id: string }[];
      };
      expect(body.server.version).toBeTruthy();
      expect(body.server.mesh).toBe(false);
      expect(body.agents_online.some(a => a.id === "status-agent")).toBe(true);
    });

    it("includes caller identity and unread count when session_id given", async () => {
      await post("/api/heartbeat", { session_id: "status-me", pid: 10101 });
      await post("/api/message", { from: "someone", to: "status-me", content: "ping" }, masterKey);
      const res = await get("/api/status?session_id=status-me", masterKey);
      const body = await res.json() as { agent: { session_id: string; unread: number; rooms: string[] } };
      expect(body.agent.session_id).toBe("status-me");
      expect(body.agent.unread).toBe(1);
    });
  });
});

// Regression: with a cluster key set, DMs route through the mesh router — its
// local-delivery path must still push to SSE listeners (it used to skip them).
describe("mesh-enabled SSE delivery", () => {
  const MESH_DB = "/tmp/agent-hotline-mesh-test.db";

  function cleanMeshDb() {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(MESH_DB + suffix); } catch { /* ignore */ }
    }
  }

  it("pushes locally-delivered DMs to SSE listeners when mesh is on", async () => {
    cleanMeshDb();
    const store = createStore(MESH_DB);
    const { app, masterKey: meshKey } = createServer(store, { port: 0, clusterKey: "test-cluster-key" });
    const srv: HttpServer = await new Promise(resolve => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = srv.address();
    const base = `http://localhost:${typeof addr === "object" && addr ? addr.port : 0}`;

    try {
      await fetch(`${base}/api/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "mesh-receiver", pid: 1212 }),
      });
      const tokenRes = await fetch(`${base}/api/inbox-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${meshKey}` },
        body: JSON.stringify({ session_id: "mesh-receiver" }),
      });
      const { token } = await tokenRes.json() as { token: string };

      const controller = new AbortController();
      const sseRes = await fetch(`${base}/api/sse/mesh-receiver?token=${token}`, { signal: controller.signal });
      expect(sseRes.status).toBe(200);
      await new Promise(r => setTimeout(r, 50));

      await fetch(`${base}/api/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${meshKey}` },
        body: JSON.stringify({ from: "mesh-sender", to: "mesh-receiver", content: "dm via mesh" }),
      });

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let collected = "";
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !collected.includes("dm via mesh")) {
        const result = await Promise.race([
          reader.read(),
          new Promise<null>(r => setTimeout(() => r(null), 200)),
        ]);
        if (result === null) continue;
        if (result.done) break;
        collected += decoder.decode(result.value, { stream: true });
      }
      controller.abort();

      expect(collected).toContain("dm via mesh");
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()));
      store.close();
      cleanMeshDb();
    }
  });
});
