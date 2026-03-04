import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "./store.js";
import { unlinkSync } from "node:fs";

const TEST_DB = "/tmp/agent-hotline-test.db";

describe("store", () => {
  let store: Store;

  beforeEach(() => {
    try {
      unlinkSync(TEST_DB);
      unlinkSync(TEST_DB + "-wal");
      unlinkSync(TEST_DB + "-shm");
    } catch {
      // ignore if files don't exist
    }
    store = createStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
  });

  describe("createStore", () => {
    it("creates tables without error", () => {
      const agents = store.getAgents();
      expect(agents).toEqual([]);
    });
  });

  describe("upsertAgent / getAgent / getAgents", () => {
    it("inserts a new agent and retrieves it", () => {
      store.upsertAgent({
        session_id: "alice",
        agent_type: "claude-code",
        machine: "mac-1",
        cwd: "/home/alice/project",
        branch: "main",
        status: "working on feature X",
      });

      const agent = store.getAgent("alice");
      expect(agent).not.toBeNull();
      expect(agent!.session_id).toBe("alice");
      expect(agent!.agent_type).toBe("claude-code");
      expect(agent!.cwd).toBe("/home/alice/project");
      expect(agent!.online).toBe(1);
      expect(agent!.last_seen).toBeGreaterThan(0);
    });

    it("updates existing agent on upsert", () => {
      store.upsertAgent({ session_id: "bob", status: "idle" });
      store.upsertAgent({ session_id: "bob", status: "busy" });

      const agents = store.getAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].status).toBe("busy");
    });

    it("returns null for unknown agent", () => {
      expect(store.getAgent("nobody")).toBeNull();
    });

    it("filters agents by room (cwd substring)", () => {
      store.upsertAgent({ session_id: "a1", cwd: "/home/user/project-x" });
      store.upsertAgent({ session_id: "a2", cwd: "/home/user/project-y" });
      store.upsertAgent({ session_id: "a3", cwd: "/home/user/project-x/sub" });

      const filtered = store.getAgents("project-x");
      expect(filtered).toHaveLength(2);
      const names = filtered.map((a) => a.session_id).sort();
      expect(names).toEqual(["a1", "a3"]);
    });
  });

  describe("getAgentByPid", () => {
    it("returns online agent with matching PID", () => {
      store.upsertAgent({ session_id: "alice", pid: 12345 });
      const agent = store.getAgentByPid(12345);
      expect(agent).not.toBeNull();
      expect(agent!.session_id).toBe("alice");
    });

    it("returns null for offline agent with matching PID", () => {
      store.upsertAgent({ session_id: "alice", pid: 12345 });
      store.markOffline("alice");
      expect(store.getAgentByPid(12345)).toBeNull();
    });

    it("returns null for unknown PID", () => {
      expect(store.getAgentByPid(99999)).toBeNull();
    });

    it("returns null for PID 0", () => {
      store.upsertAgent({ session_id: "alice", pid: 0 });
      expect(store.getAgentByPid(0)).toBeNull();
    });
  });

  describe("messages", () => {
    it("creates and retrieves unread messages", () => {
      store.createMessage("alice", "bob", "hey bob");
      store.createMessage("alice", "bob", "you there?");
      store.createMessage("charlie", "alice", "hi alice");

      const bobMsgs = store.getUnreadMessages("bob");
      expect(bobMsgs).toHaveLength(2);
      expect(bobMsgs[0].content).toBe("hey bob");
      expect(bobMsgs[0].from_agent).toBe("alice");
      expect(bobMsgs[0].timestamp).toBeGreaterThan(0);
      expect(bobMsgs[0].read).toBe(0);

      const aliceMsgs = store.getUnreadMessages("alice");
      expect(aliceMsgs).toHaveLength(1);
    });

    it("markRead marks all messages to agent as read", () => {
      store.createMessage("alice", "bob", "msg1");
      store.createMessage("alice", "bob", "msg2");

      store.markRead("bob");

      const msgs = store.getUnreadMessages("bob");
      expect(msgs).toHaveLength(0);
    });

    it("markRead does not affect other agents", () => {
      store.createMessage("alice", "bob", "for bob");
      store.createMessage("alice", "charlie", "for charlie");

      store.markRead("bob");

      expect(store.getUnreadMessages("bob")).toHaveLength(0);
      expect(store.getUnreadMessages("charlie")).toHaveLength(1);
    });
  });

  describe("online/offline", () => {
    it("upsertAgent sets online=1", () => {
      store.upsertAgent({ session_id: "alice" });
      expect(store.getAgent("alice")!.online).toBe(1);
    });

    it("markOffline sets online=0", () => {
      store.upsertAgent({ session_id: "alice" });
      store.markOffline("alice");
      expect(store.getAgent("alice")!.online).toBe(0);
    });

    it("getOnlineAgents returns only online agents", () => {
      store.upsertAgent({ session_id: "alice" });
      store.upsertAgent({ session_id: "bob" });
      store.markOffline("bob");

      const online = store.getOnlineAgents();
      expect(online).toHaveLength(1);
      expect(online[0].session_id).toBe("alice");
    });

    it("re-upsert brings agent back online", () => {
      store.upsertAgent({ session_id: "alice" });
      store.markOffline("alice");
      store.upsertAgent({ session_id: "alice" });
      expect(store.getAgent("alice")!.online).toBe(1);
    });
  });
});
