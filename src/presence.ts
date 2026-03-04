import type { Store } from "./store.js";

const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds

export function startPresenceLoop(
  store: Store,
  intervalMs: number = DEFAULT_INTERVAL_MS,
) {
  const check = () => {
    const cutoff = Date.now() - OFFLINE_THRESHOLD_MS;
    for (const agent of store.getOnlineAgents()) {
      if (agent.last_seen < cutoff) {
        store.markOffline(agent.agent_name);
      }
    }
  };

  const timer = setInterval(check, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
