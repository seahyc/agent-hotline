import { createHash } from "node:crypto";
import type { Store, Peer } from "./store.js";
import { getNodeId, tick, mergeClock, getClock } from "./node.js";
import { log } from "./log.js";

const GOSSIP_INTERVAL_MS = 20_000; // 20s
const SUSPECT_THRESHOLD = 3; // missed rounds before suspect
const DEAD_THRESHOLD = 5; // missed rounds before dead

export interface GossipPeerInfo {
  nodeId: string;
  addr: string;
  lastSeen: number;
  agents: {
    session_id: string;
    name: string;
    online: boolean;
    last_seen_logical: number;
  }[];
}

export interface GossipPayload {
  nodeId: string;
  clusterKeyHash: string;
  peers: GossipPeerInfo[];
  rooms?: { name: string; members: string[] }[];
  pendingMessages?: { globalId: string; from: string; to: string; content: string; originNode: string; ttl: number }[];
}

/** Hash cluster key for mDNS TXT filtering (first 8 hex chars of sha256). */
export function hashClusterKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Build the gossip payload for this node. */
export function buildGossipPayload(store: Store, clusterKey: string, selfAddr: string): GossipPayload {
  const nodeId = getNodeId();
  const localAgents = store.getOnlineAgents().map((a) => ({
    session_id: a.session_id,
    name: a.name || "",
    online: a.online === 1,
    last_seen_logical: tick(),
  }));

  // Include self + known alive/suspect peers
  const peers: GossipPeerInfo[] = [
    {
      nodeId,
      addr: selfAddr,
      lastSeen: Date.now(),
      agents: localAgents,
    },
  ];

  for (const p of store.getPeers()) {
    if (p.status === "dead") continue;
    let agents: GossipPeerInfo["agents"] = [];
    try {
      agents = JSON.parse(p.agents_json);
    } catch { /* ignore */ }
    peers.push({
      nodeId: p.node_id,
      addr: p.addr,
      lastSeen: p.last_seen,
      agents,
    });
  }

  return {
    nodeId,
    clusterKeyHash: hashClusterKey(clusterKey),
    peers,
    rooms: store.getRoomsSnapshot(),
  };
}

/** Merge a received gossip payload into local state. */
export function mergeGossip(store: Store, payload: GossipPayload, localNodeId: string): void {
  for (const peer of payload.peers) {
    if (peer.nodeId === localNodeId) continue; // skip self

    // Upsert peer
    store.upsertPeer({
      node_id: peer.nodeId,
      addr: peer.addr,
      agents_json: JSON.stringify(peer.agents),
    });

    // Merge remote agents (LWW, origin-node authority)
    for (const agent of peer.agents) {
      mergeClock(agent.last_seen_logical);
      store.upsertRemoteAgent(
        {
          session_id: agent.session_id,
          name: agent.name || "",
          online: agent.online ? 1 : 0,
        } as any,
        peer.nodeId,
      );
    }
  }

  // Merge rooms
  if (payload.rooms) {
    store.mergeRooms(payload.rooms);
  }

  // Deliver any pending messages the relay piggybacked on the gossip response
  if (payload.pendingMessages?.length) {
    for (const msg of payload.pendingMessages) {
      if (store.hasSeenMessage(msg.globalId)) continue;
      store.markMessageSeen(msg.globalId);
      const localAgent = store.resolveAgent(msg.to);
      if (localAgent) {
        const agentRecord = store.getAgent(localAgent.session_id);
        const originNode = (agentRecord as any)?.origin_node;
        if (!originNode || originNode === "" || originNode === localNodeId) {
          store.createMessage(msg.from, localAgent.session_id, msg.content);
          log("info", `mesh: relay-gossip delivery ${msg.from} -> ${localAgent.session_id}`);
        }
      }
    }
  }
}

/** Pick up to N random peers for gossip, always including bootstrap URLs. */
function pickGossipTargets(store: Store, bootstrapUrls: string[], count: number): { addr: string; nodeId?: string }[] {
  const targets: { addr: string; nodeId?: string }[] = [];

  // Always include bootstrap peers
  for (const url of bootstrapUrls) {
    targets.push({ addr: url });
  }

  // Add random known alive/suspect peers
  const peers = store.getPeers().filter((p) => p.status !== "dead");
  const shuffled = peers.sort(() => Math.random() - 0.5);
  for (const p of shuffled) {
    if (targets.length >= count + bootstrapUrls.length) break;
    // Skip if already in bootstrap list
    if (targets.some((t) => t.addr === p.addr)) continue;
    targets.push({ addr: p.addr, nodeId: p.node_id });
  }

  return targets;
}

/** Start the gossip loop. Returns a stop function. */
export function startGossipLoop(
  store: Store,
  opts: { clusterKey: string; bootstrapUrls: string[]; selfAddr: string },
): { stop: () => void } {
  const { clusterKey, bootstrapUrls, selfAddr } = opts;
  const localNodeId = getNodeId();

  const gossipOnce = async () => {
    const targets = pickGossipTargets(store, bootstrapUrls, 2);
    const payload = buildGossipPayload(store, clusterKey, selfAddr);

    for (const target of targets) {
      try {
        const res = await fetch(`${target.addr}/api/gossip`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${clusterKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });

        if (res.ok) {
          const response = (await res.json()) as GossipPayload;
          mergeGossip(store, response, localNodeId);
          if (target.nodeId) {
            store.resetMissedGossip(target.nodeId);
          }
        } else {
          log("warn", `gossip to ${target.addr} returned ${res.status}`);
          if (target.nodeId) {
            store.incrementMissedGossip(target.nodeId);
          }
        }
      } catch (e) {
        log("warn", `gossip to ${target.addr} failed: ${e}`);
        if (target.nodeId) {
          store.incrementMissedGossip(target.nodeId);
        }
      }
    }

    // Failure detection: check missed gossip counts
    for (const peer of store.getPeers()) {
      if (peer.missed_gossip >= DEAD_THRESHOLD && peer.status !== "dead") {
        store.setPeerStatus(peer.node_id, "dead");
        log("info", `peer ${peer.node_id} marked dead (missed ${peer.missed_gossip} rounds)`);
      } else if (peer.missed_gossip >= SUSPECT_THRESHOLD && peer.status === "alive") {
        store.setPeerStatus(peer.node_id, "suspect");
        log("info", `peer ${peer.node_id} marked suspect (missed ${peer.missed_gossip} rounds)`);
      }
    }

    // Purge expired seen message IDs periodically
    store.purgeExpiredSeenIds();
  };

  // Initial gossip
  gossipOnce().catch((e) => log("error", `initial gossip failed: ${e}`));

  const timer = setInterval(() => {
    gossipOnce().catch((e) => log("error", `gossip loop error: ${e}`));
  }, GOSSIP_INTERVAL_MS);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Start mDNS announcer and listener. Returns a stop function. */
export function startMdns(
  store: Store,
  opts: { clusterKey: string; port: number },
): { stop: () => void } {
  let mdns: any;
  let announceTimer: ReturnType<typeof setInterval> | null = null;

  try {
    // Dynamic import since multicast-dns is optional
    mdns = require("multicast-dns")();
  } catch {
    log("warn", "multicast-dns not available, LAN discovery disabled");
    return { stop() {} };
  }

  const SERVICE_NAME = "_hotline._tcp.local";
  const keyHash = hashClusterKey(opts.clusterKey);
  const localNodeId = getNodeId();

  // Respond to queries
  mdns.on("query", (query: any) => {
    const isHotline = query.questions?.some(
      (q: any) => q.name === SERVICE_NAME && q.type === "PTR",
    );
    if (!isHotline) return;

    mdns.respond({
      answers: [
        { name: SERVICE_NAME, type: "PTR", data: `${localNodeId}.${SERVICE_NAME}` },
      ],
      additionals: [
        {
          name: `${localNodeId}.${SERVICE_NAME}`,
          type: "SRV",
          data: { port: opts.port, target: require("node:os").hostname() },
        },
        {
          name: `${localNodeId}.${SERVICE_NAME}`,
          type: "TXT",
          data: [`nodeId=${localNodeId}`, `clusterKeyHash=${keyHash}`],
        },
      ],
    });
  });

  // Listen for responses
  mdns.on("response", (response: any) => {
    const txtRecords = response.additionals?.filter((a: any) => a.type === "TXT") ?? [];
    const srvRecords = response.additionals?.filter((a: any) => a.type === "SRV") ?? [];

    for (const txt of txtRecords) {
      const data: string[] = Array.isArray(txt.data)
        ? txt.data.map((b: Buffer | string) => (typeof b === "string" ? b : b.toString()))
        : [];
      const nodeIdEntry = data.find((d) => d.startsWith("nodeId="));
      const keyHashEntry = data.find((d) => d.startsWith("clusterKeyHash="));

      if (!nodeIdEntry || !keyHashEntry) continue;
      const remoteNodeId = nodeIdEntry.split("=")[1];
      const remoteKeyHash = keyHashEntry.split("=")[1];

      // Filter by cluster key hash
      if (remoteKeyHash !== keyHash) continue;
      if (remoteNodeId === localNodeId) continue;

      // Find corresponding SRV record for port
      const srv = srvRecords.find((s: any) => s.name?.includes(remoteNodeId));
      if (!srv) continue;

      const addr = `http://${srv.data.target}:${srv.data.port}`;
      store.upsertPeer({ node_id: remoteNodeId, addr });
      log("info", `mDNS discovered peer: ${remoteNodeId} at ${addr}`);
    }
  });

  // Query periodically
  const query = () => {
    mdns.query({ questions: [{ name: SERVICE_NAME, type: "PTR" }] });
  };

  query();
  announceTimer = setInterval(query, 30_000); // every 30s

  return {
    stop() {
      if (announceTimer) clearInterval(announceTimer);
      try { mdns.destroy(); } catch { /* ignore */ }
    },
  };
}
