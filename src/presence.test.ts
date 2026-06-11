import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hostname } from "node:os";
import { startPresenceLoop } from "./presence.js";
import type { Store } from "./store.js";
import type { Agent } from "./store.js";

const HOUR = 60 * 60 * 1000;

function makeAgent(name: string, lastSeen: number, extra?: Partial<Agent>): Agent {
  return {
    session_id: name,
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
    ...extra,
  } as Agent;
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
  } as unknown as Store;
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
    const staleAgent = makeAgent("stale", now - 2 * HOUR);
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
    const store = mockStore([makeAgent("old", now - 2 * HOUR)]);

    const loop = startPresenceLoop(store, 1000);

    vi.advanceTimersByTime(3000);

    expect(store.markOffline).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it("stop() prevents further checks", () => {
    const now = Date.now();
    const store = mockStore([makeAgent("old", now - 2 * HOUR)]);

    const loop = startPresenceLoop(store, 1000);

    vi.advanceTimersByTime(1000);
    expect(store.markOffline).toHaveBeenCalledTimes(1);

    loop.stop();

    vi.advanceTimersByTime(5000);
    expect(store.markOffline).toHaveBeenCalledTimes(1);
  });

  it("uses default interval of 30 seconds", () => {
    const now = Date.now();
    const store = mockStore([makeAgent("old", now - 2 * HOUR)]);

    const loop = startPresenceLoop(store);

    vi.advanceTimersByTime(29_999);
    expect(store.markOffline).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(store.markOffline).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  it("uses 1-hour threshold for remote agent staleness", () => {
    const now = Date.now();
    const fresh = makeAgent("fresh", now - HOUR + 60_000); // 59 min ago
    const stale = makeAgent("stale", now - HOUR - 60_000); // 61 min ago
    const store = mockStore([fresh, stale]);

    const loop = startPresenceLoop(store, 1000);
    vi.advanceTimersByTime(1000);

    expect(store.markOffline).toHaveBeenCalledTimes(1);
    expect(store.markOffline).toHaveBeenCalledWith("stale");

    loop.stop();
  });

  it("marks local agents offline immediately when their PID is dead", () => {
    const now = Date.now();
    // Fresh heartbeat, but the process is gone — PID check wins over the time threshold
    const deadPid = makeAgent("dead-pid", now, { pid: 999_999_999, machine: hostname() });
    const alivePid = makeAgent("alive-pid", now, { pid: process.pid, machine: hostname() });
    const store = mockStore([deadPid, alivePid]);

    const loop = startPresenceLoop(store, 1000);
    vi.advanceTimersByTime(1000);

    expect(store.markOffline).toHaveBeenCalledTimes(1);
    expect(store.markOffline).toHaveBeenCalledWith("dead-pid");

    loop.stop();
  });
});
