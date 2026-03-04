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
  let lastPurge = Date.now();
  const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly

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
        const subscribers = store.getSubscribers("agent_offline");
        for (const sub of subscribers) {
          if (sub !== agent.session_id) {
            store.createMessage("system", sub, `${agent.session_id} went offline`);
          }
        }
      }
    }
    // Purge old messages periodically
    if (retentionDays && Date.now() - lastPurge > PURGE_INTERVAL_MS) {
      const deleted = store.purgeOldMessages(retentionDays);
      if (deleted > 0) {
        console.log(`Purged ${deleted} messages older than ${retentionDays} days`);
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
