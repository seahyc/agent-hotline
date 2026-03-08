import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { getNodeId } from "./node.js";
import { log } from "./log.js";

const MAX_TTL = 3;

export interface MeshMessage {
  globalId: string;
  from: string;
  to: string;
  content: string;
  originNode: string;
  ttl: number;
}

export interface MeshRouter {
  /** Route a message: local delivery, direct to peer, relay, or queue. */
  route(from: string, to: string, content: string): Promise<{ delivered: boolean; target: string; method: string }>;
  /** Receive a relayed message from another node. */
  receiveRelayed(msg: MeshMessage): Promise<boolean>;
  /** Retry delivering pending messages (called each gossip cycle). */
  retryPending(): Promise<void>;
}

export function createMeshRouter(store: Store, opts: { clusterKey: string }): MeshRouter {
  const localNodeId = getNodeId();
  const { clusterKey } = opts;

  /** Try to deliver a message directly to a peer node. */
  async function deliverToPeer(addr: string, msg: MeshMessage): Promise<boolean> {
    try {
      const res = await fetch(`${addr}/api/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${clusterKey}`,
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Find which peer node hosts a given agent. */
  function findPeerForAgent(agentId: string): { nodeId: string; addr: string } | null {
    for (const peer of store.getPeers()) {
      if (peer.status === "dead") continue;
      // Skip localhost peers from other nodes — we can't reach their localhost
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(peer.addr);
      if (isLocalhost && peer.node_id !== localNodeId) continue;
      try {
        const agents = JSON.parse(peer.agents_json) as { session_id: string }[];
        if (agents.some((a) => a.session_id === agentId)) {
          return { nodeId: peer.node_id, addr: peer.addr };
        }
      } catch { /* ignore */ }
    }
    return null;
  }

  return {
    async route(from, to, content) {
      const globalId = randomUUID();

      // 1. Local agent? → local SQLite delivery
      const localAgent = store.resolveAgent(to);
      if (localAgent) {
        // Check if it's truly local (no origin_node or origin_node is us)
        const agentRecord = store.getAgent(localAgent.session_id);
        const originNode = (agentRecord as any)?.origin_node;
        if (!originNode || originNode === "" || originNode === localNodeId) {
          store.createMessage(from, localAgent.session_id, content);
          store.markMessageSeen(globalId);
          log("info", `mesh: local delivery ${from} -> ${localAgent.session_id}`);
          return { delivered: true, target: localAgent.session_id, method: "local" };
        }
      }

      // 2. Known peer? → direct delivery to target's node
      const resolvedTo = localAgent?.session_id ?? to;
      const peer = findPeerForAgent(resolvedTo);
      if (peer) {
        const msg: MeshMessage = { globalId, from, to: resolvedTo, content, originNode: localNodeId, ttl: MAX_TTL };
        const delivered = await deliverToPeer(peer.addr, msg);
        if (delivered) {
          store.markMessageSeen(globalId);
          log("info", `mesh: direct delivery ${from} -> ${resolvedTo} via ${peer.nodeId}`);
          return { delivered: true, target: resolvedTo, method: "direct" };
        }
      }

      // 3. Relay via any reachable peer (try all alive peers, skip foreign localhost)
      const msg: MeshMessage = { globalId, from, to: resolvedTo, content, originNode: localNodeId, ttl: MAX_TTL };
      for (const p of store.getPeers()) {
        if (p.status === "dead") continue;
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(p.addr);
        if (isLocalhost && p.node_id !== localNodeId) continue;
        const relayed = await deliverToPeer(p.addr, msg);
        if (relayed) {
          store.markMessageSeen(globalId);
          log("info", `mesh: relayed ${from} -> ${resolvedTo} via ${p.node_id}`);
          return { delivered: true, target: resolvedTo, method: "relay" };
        }
      }

      // 4. Queue for later delivery
      store.createMessageWithGlobalId(from, resolvedTo, content, globalId, "pending");
      store.markMessageSeen(globalId);
      log("info", `mesh: queued ${from} -> ${resolvedTo} (no reachable peer)`);
      return { delivered: false, target: resolvedTo, method: "queued" };
    },

    async receiveRelayed(msg) {
      // Dedup check
      if (store.hasSeenMessage(msg.globalId)) {
        log("info", `mesh: dedup - already seen ${msg.globalId}`);
        return false;
      }
      store.markMessageSeen(msg.globalId);

      // Is the target a local agent?
      const localAgent = store.resolveAgent(msg.to);
      if (localAgent) {
        const agentRecord = store.getAgent(localAgent.session_id);
        const originNode = (agentRecord as any)?.origin_node;
        if (!originNode || originNode === "" || originNode === localNodeId) {
          store.createMessage(msg.from, localAgent.session_id, msg.content);
          log("info", `mesh: received relay, local delivery ${msg.from} -> ${localAgent.session_id}`);
          return true;
        }
      }

      // Forward if TTL allows
      if (msg.ttl > 1) {
        const peer = findPeerForAgent(msg.to);
        if (peer) {
          const forwarded = await deliverToPeer(peer.addr, { ...msg, ttl: msg.ttl - 1 });
          if (forwarded) {
            log("info", `mesh: forwarded ${msg.from} -> ${msg.to} via ${peer.nodeId}`);
            return true;
          }
        }
      }

      // Store as pending for retry
      store.createMessageWithGlobalId(msg.from, msg.to, msg.content, msg.globalId, "pending");
      log("info", `mesh: stored pending relay ${msg.from} -> ${msg.to}`);
      return true;
    },

    async retryPending() {
      const pending = store.getPendingMessages();
      for (const msg of pending) {
        const peer = findPeerForAgent(msg.to_agent);
        if (peer) {
          const meshMsg: MeshMessage = {
            globalId: msg.global_id,
            from: msg.from_agent,
            to: msg.to_agent,
            content: msg.content,
            originNode: localNodeId,
            ttl: MAX_TTL,
          };
          const delivered = await deliverToPeer(peer.addr, meshMsg);
          if (delivered) {
            store.markDelivered(msg.global_id);
            log("info", `mesh: retry succeeded ${msg.from_agent} -> ${msg.to_agent}`);
          }
        }
      }
    },
  };
}
