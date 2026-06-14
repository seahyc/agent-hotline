import { execSync } from "node:child_process";
import { hostname } from "node:os";
import type { Store } from "./store.js";

const OFFLINE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour (fallback for remote agents)
const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

const localMachine = hostname();

/** Check if a process is still running on the local machine. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check if it exists
    return true;
  } catch {
    return false;
  }
}

export function startPresenceLoop(
  store: Store,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  retentionDays?: number,
) {
  // Start at 0 so the first tick runs a one-time startup sweep, clearing the
  // backlog of dead agent rows / orphan room members accumulated before purging.
  let lastPurge = 0;
  const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly
  const STALE_AGENT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

  const check = () => {
    const cutoff = Date.now() - OFFLINE_THRESHOLD_MS;
    for (const agent of store.getOnlineAgents()) {
      let shouldMarkOffline = false;

      // For local agents with a known PID, check if the process is still alive
      if (agent.pid > 0 && agent.machine === localMachine) {
        if (!isProcessAlive(agent.pid)) {
          shouldMarkOffline = true;
        }
      } else {
        // Remote agents: fall back to time-based threshold
        if (agent.last_seen < cutoff) {
          shouldMarkOffline = true;
        }
      }

      if (shouldMarkOffline) {
        store.markOffline(agent.session_id);
      }
    }
    // Keep automatic directory-rooms in sync with the live cohort every tick,
    // so cwd moves and departures reflect promptly (~30s) and idempotently.
    store.reconcileAllAutoRooms();

    // Purge old messages + stale agents/orphan members periodically (and once
    // on startup, since lastPurge starts at 0).
    if (Date.now() - lastPurge > PURGE_INTERVAL_MS) {
      if (retentionDays) {
        const deleted = store.purgeOldMessages(retentionDays);
        if (deleted > 0) {
          console.log(`Purged ${deleted} messages older than ${retentionDays} days`);
        }
      }
      const staleAgents = store.purgeStaleAgents(STALE_AGENT_MAX_AGE_MS);
      const orphanMembers = store.purgeOrphanRoomMembers();
      if (staleAgents > 0 || orphanMembers > 0) {
        console.log(`Purged ${staleAgents} stale agents and ${orphanMembers} orphan room members`);
      }
      lastPurge = Date.now();
    }
  };

  const timer = setInterval(check, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
