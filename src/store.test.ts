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

  describe("dir_chain", () => {
    it("defaults to empty array and round-trips a provided chain", () => {
      store.upsertAgent({ session_id: "alice" });
      expect(store.getAgent("alice")!.dir_chain).toEqual([]);

      store.upsertAgent({ session_id: "alice", dir_chain: ["repo/src", "repo"] });
      expect(store.getAgent("alice")!.dir_chain).toEqual(["repo/src", "repo"]);
    });

    it("does not wipe dir_chain on a bare heartbeat upsert", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo"] });
      store.upsertAgent({ session_id: "alice", status: "busy" });
      expect(store.getAgent("alice")!.dir_chain).toEqual(["repo"]);
    });
  });

  describe("purgeStaleAgents", () => {
    it("deletes offline agents past the window, keeps online ones", () => {
      store.upsertAgent({ session_id: "online-agent" });
      store.upsertAgent({ session_id: "offline-a" });
      store.upsertAgent({ session_id: "offline-b" });
      store.markOffline("offline-a");
      store.markOffline("offline-b");

      // Negative maxAgeMs => cutoff is in the future => every offline row qualifies.
      const removed = store.purgeStaleAgents(-1000);
      expect(removed).toBe(2);
      expect(store.getAgent("online-agent")).not.toBeNull();
      expect(store.getAgent("offline-a")).toBeNull();
      expect(store.getAgent("offline-b")).toBeNull();
    });

    it("does not delete recently-seen offline agents with a real window", () => {
      store.upsertAgent({ session_id: "bob" });
      store.markOffline("bob");
      const removed = store.purgeStaleAgents(24 * 60 * 60 * 1000); // 24h window
      expect(removed).toBe(0);
      expect(store.getAgent("bob")).not.toBeNull();
    });
  });

  describe("purgeOrphanRoomMembers", () => {
    it("removes room_members whose session has no agent row", () => {
      store.upsertAgent({ session_id: "alice" });
      store.joinRoom("proj", "alice");
      store.joinRoom("proj", "ghost-session"); // no agent row
      expect(store.getRoomMembers("proj").sort()).toEqual(["alice", "ghost-session"]);

      const removed = store.purgeOrphanRoomMembers();
      expect(removed).toBe(1);
      expect(store.getRoomMembers("proj")).toEqual(["alice"]);
    });
  });

  describe("reconcileAutoRooms", () => {
    it("joins a room for a chain key shared by >=2 online agents", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo/src", "repo"] });
      store.upsertAgent({ session_id: "bob", dir_chain: ["repo/test", "repo"] });

      store.reconcileAutoRooms("alice");
      store.reconcileAutoRooms("bob");

      // Both share "repo" (repo root) -> auto-joined; subdirs are single-occupant -> no room.
      expect(store.getAgentRooms("alice")).toEqual(["repo"]);
      expect(store.getAgentRooms("bob")).toEqual(["repo"]);
      expect(store.getRoomMembers("repo").sort()).toEqual(["alice", "bob"]);
    });

    it("does not create a room for a single-occupant chain key", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["solo/src", "solo"] });
      store.upsertAgent({ session_id: "bob", dir_chain: ["other", "other"] });

      store.reconcileAutoRooms("alice");
      expect(store.getAgentRooms("alice")).toEqual([]);
    });

    it("joins the deepest shared key when two agents share a subdir", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo/src", "repo"] });
      store.upsertAgent({ session_id: "bob", dir_chain: ["repo/src", "repo"] });

      store.reconcileAutoRooms("alice");
      store.reconcileAutoRooms("bob");

      // Both "repo/src" and "repo" are shared -> member of both auto-rooms.
      expect(store.getAgentRooms("alice").sort()).toEqual(["repo", "repo/src"]);
      expect(store.getAgentRooms("bob").sort()).toEqual(["repo", "repo/src"]);
    });

    it("leaves stale auto rooms when the chain changes", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo/src", "repo"] });
      store.upsertAgent({ session_id: "bob", dir_chain: ["repo/src", "repo"] });
      store.reconcileAutoRooms("alice");
      store.reconcileAutoRooms("bob");
      expect(store.getAgentRooms("alice").sort()).toEqual(["repo", "repo/src"]);

      // Alice moves to a different subdir; "repo/src" no longer shared with her.
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo/docs", "repo"] });
      store.reconcileAutoRooms("alice");

      // "repo" still shared (both in repo); "repo/src" left (she's no longer there).
      expect(store.getAgentRooms("alice")).toEqual(["repo"]);
      expect(store.getRoomMembers("repo/src")).toEqual(["bob"]);
    });

    it("never touches manual memberships", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo/src", "repo"] });
      store.upsertAgent({ session_id: "bob", dir_chain: ["repo/src", "repo"] });
      store.joinRoom("hand-picked", "alice"); // manual

      store.reconcileAutoRooms("alice");

      const rooms = store.getAgentRooms("alice").sort();
      expect(rooms).toContain("hand-picked");
      expect(rooms).toContain("repo");
      expect(rooms).toContain("repo/src");

      // Moving away from the repo leaves auto rooms but keeps the manual one.
      store.upsertAgent({ session_id: "alice", dir_chain: ["elsewhere"] });
      store.reconcileAutoRooms("alice");
      expect(store.getAgentRooms("alice")).toEqual(["hand-picked"]);
    });

    it("reconcileAllAutoRooms reconciles every online agent", () => {
      store.upsertAgent({ session_id: "alice", dir_chain: ["repo", "repo"] });
      store.upsertAgent({ session_id: "bob", dir_chain: ["repo", "repo"] });
      store.reconcileAllAutoRooms();
      expect(store.getRoomMembers("repo").sort()).toEqual(["alice", "bob"]);
    });
  });
});
