import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startPresenceLoop } from "./presence.js";
import type { Store } from "./store.js";
import type { Agent } from "./store.js";

function makeAgent(name: string, lastSeen: number): Agent {
  return {
    agent_name: name,
    agent_type: "",
    machine: "",
    cwd: "",
    cwd_remote: "",
    branch: "",
    status: "",
    dirty_files: "[]",
    git_diff: "",
    conversation_recent: "",
    last_seen: lastSeen,
    online: 1,
  };
}

function mockStore(agents: Agent[]): Store {
  return {
    close: vi.fn(),
    upsertAgent: vi.fn(),
    getAgents: vi.fn(),
    getAgent: vi.fn(),
    createMessage: vi.fn(),
    getUnreadMessages: vi.fn(),
    markRead: vi.fn(),
    markOffline: vi.fn(),
    getOnlineAgents: vi.fn(() => agents),
  };
}

describe("startPresenceLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks stale agents offline after interval fires", () => {
    const now = Date.now();
    const staleAgent = makeAgent("stale", now - 3 * 60 * 1000); // 3 min ago
    const freshAgent = makeAgent("fresh", now - 30 * 1000); // 30s ago
    const store = mockStore([staleAgent, freshAgent]);

    const loop = startPresenceLoop(store, 1000);

    // Nothing called yet before interval fires
    expect(store.markOffline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(store.markOffline).toHaveBeenCalledTimes(1);
    expect(store.markOffline).toHaveBeenCalledWith("stale");

    loop.stop();
  });

  it("does not mark agents offline if all are fresh", () => {
    const now = Date.now();
    const store = mockStore([
      makeAgent("a", now - 10_000),
      makeAgent("b", now - 60_000),
    ]);

    const loop = startPresenceLoop(store, 500);
    vi.advanceTimersByTime(500);

    expect(store.markOffline).not.toHaveBeenCalled();

    loop.stop();
  });

  it("does nothing when no agents are online", () => {
    const store = mockStore([]);
    const loop = startPresenceLoop(store, 500);

    vi.advanceTimersByTime(500);

    expect(store.markOffline).not.toHaveBeenCalled();

    loop.stop();
  });

  it("runs repeatedly on each interval tick", () => {
    const now = Date.now();
    const store = mockStore([makeAgent("old", now - 5 * 60 * 1000)]);

    const loop = startPresenceLoop(store, 1000);

    vi.advanceTimersByTime(3000);

    expect(store.markOffline).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it("stop() prevents further checks", () => {
    const now = Date.now();
    const store = mockStore([makeAgent("old", now - 5 * 60 * 1000)]);

    const loop = startPresenceLoop(store, 1000);

    vi.advanceTimersByTime(1000);
    expect(store.markOffline).toHaveBeenCalledTimes(1);

    loop.stop();

    vi.advanceTimersByTime(5000);
    expect(store.markOffline).toHaveBeenCalledTimes(1);
  });

  it("uses default interval of 30 seconds", () => {
    const now = Date.now();
    const store = mockStore([makeAgent("old", now - 5 * 60 * 1000)]);

    const loop = startPresenceLoop(store);

    vi.advanceTimersByTime(29_999);
    expect(store.markOffline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(store.markOffline).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  it("uses 2-minute threshold for staleness", () => {
    const now = Date.now();
    // Agent seen 1m59s ago - should NOT be marked offline even after 1s interval
    const fresh = makeAgent("fresh", now - 119_000 + 1000);
    // Agent seen 2m01s ago - should be marked offline
    const stale = makeAgent("stale", now - 121_000 - 1000);
    const store = mockStore([fresh, stale]);

    const loop = startPresenceLoop(store, 1000);
    vi.advanceTimersByTime(1000);

    expect(store.markOffline).toHaveBeenCalledTimes(1);
    expect(store.markOffline).toHaveBeenCalledWith("stale");

    loop.stop();
  });
});
