/**
 * Agent Hotline - CF Worker gossip peer & message relay.
 *
 * Implements the same gossip API as any node:
 *   POST /api/gossip  - receive gossip, merge, respond
 *   POST /api/message - store messages for relay to NAT nodes
 *   GET  /health      - liveness check
 */

interface Env {
  DB: D1Database;
  HOTLINE_CLUSTER_KEY: string;
}

interface GossipPeerInfo {
  nodeId: string;
  addr: string;
  lastSeen: number;
  agents: { session_id: string; name: string; online: boolean; last_seen_logical: number }[];
}

interface GossipPayload {
  nodeId: string;
  clusterKeyHash: string;
  peers: GossipPeerInfo[];
  pendingMessages?: MeshMessage[];
}

interface MeshMessage {
  globalId: string;
  from: string;
  to: string;
  content: string;
  originNode: string;
  ttl: number;
}

const WORKER_NODE_ID = "cf-worker-relay";

function validateAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  return token === env.HOTLINE_CLUSTER_KEY;
}

async function hashClusterKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check (public)
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", node: WORKER_NODE_ID });
    }

    // All other endpoints require auth
    if (!validateAuth(request, env)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (url.pathname === "/api/gossip" && request.method === "POST") {
      return handleGossip(request, env);
    }

    if (url.pathname === "/api/message" && request.method === "POST") {
      return handleMessage(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

async function handleGossip(request: Request, env: Env): Promise<Response> {
  const payload: GossipPayload = await request.json();
  if (!payload?.nodeId || !payload?.peers) {
    return Response.json({ error: "Invalid gossip payload" }, { status: 400 });
  }

  // Validate cluster key hash
  const expectedHash = await hashClusterKey(env.HOTLINE_CLUSTER_KEY);
  if (payload.clusterKeyHash && payload.clusterKeyHash !== expectedHash) {
    return Response.json({ error: "Cluster key mismatch" }, { status: 401 });
  }

  const now = Date.now();

  // Merge incoming peers (skip localhost — unreachable cross-machine)
  for (const peer of payload.peers) {
    if (peer.nodeId === WORKER_NODE_ID) continue;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(peer.addr ?? "")) continue;
    await env.DB.prepare(
      `INSERT INTO peers (node_id, addr, last_seen, status, agents_json, missed_gossip)
       VALUES (?, ?, ?, 'alive', ?, 0)
       ON CONFLICT(node_id) DO UPDATE SET
         addr = excluded.addr,
         last_seen = excluded.last_seen,
         agents_json = excluded.agents_json,
         missed_gossip = 0,
         status = 'alive'`,
    ).bind(peer.nodeId, peer.addr, now, JSON.stringify(peer.agents)).run();
  }

  // Build response with our view (exclude localhost peers — they're unreachable cross-machine)
  const dbPeers = await env.DB.prepare("SELECT * FROM peers WHERE status != 'dead'").all();
  const responsePeers: GossipPeerInfo[] = (dbPeers.results ?? [])
    .filter((p: any) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(p.addr ?? ""))
    .map((p: any) => ({
      nodeId: p.node_id,
      addr: p.addr,
      lastSeen: p.last_seen,
      agents: JSON.parse(p.agents_json || "[]"),
    }));

  // Include self
  responsePeers.push({
    nodeId: WORKER_NODE_ID,
    addr: new URL(request.url).origin,
    lastSeen: now,
    agents: [],
  });

  // Collect pending messages for the gossiping node's agents and include in response
  const incomingAgents = payload.peers
    .filter(p => p.nodeId === payload.nodeId)
    .flatMap(p => p.agents.map(a => a.session_id));

  const pendingMessages: MeshMessage[] = [];
  const toDelete: string[] = [];

  for (const agentId of incomingAgents) {
    const pending = await env.DB.prepare(
      "SELECT * FROM messages WHERE to_agent = ?",
    ).bind(agentId).all();

    for (const msg of pending.results ?? []) {
      pendingMessages.push({
        globalId: (msg as any).global_id,
        from: (msg as any).from_agent,
        to: (msg as any).to_agent,
        content: (msg as any).content,
        originNode: (msg as any).origin_node,
        ttl: (msg as any).ttl - 1,
      });
      toDelete.push((msg as any).global_id);
    }
  }

  // Delete delivered messages from relay store
  for (const id of toDelete) {
    await env.DB.prepare("DELETE FROM messages WHERE global_id = ?").bind(id).run();
  }

  const response: GossipPayload = {
    nodeId: WORKER_NODE_ID,
    clusterKeyHash: expectedHash,
    peers: responsePeers,
    ...(pendingMessages.length > 0 && { pendingMessages }),
  };

  return Response.json(response);
}

async function handleMessage(request: Request, env: Env): Promise<Response> {
  const msg: MeshMessage = await request.json();
  if (!msg.globalId || !msg.from || !msg.to || !msg.content) {
    return Response.json({ error: "Invalid message" }, { status: 400 });
  }

  // Dedup check
  const seen = await env.DB.prepare("SELECT 1 FROM seen_message_ids WHERE global_id = ?").bind(msg.globalId).first();
  if (seen) {
    return Response.json({ ok: true, accepted: false });
  }

  // Mark as seen
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO seen_message_ids (global_id, expires_at) VALUES (?, ?)",
  ).bind(msg.globalId, expires).run();

  // Try to find the target node and deliver directly (skip localhost — unreachable from Workers)
  const peers = await env.DB.prepare("SELECT * FROM peers WHERE status = 'alive'").all();
  for (const peer of peers.results ?? []) {
    const addr: string = (peer as any).addr ?? "";
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(addr)) continue;
    const agents: { session_id: string }[] = JSON.parse((peer as any).agents_json || "[]");
    if (agents.some(a => a.session_id === msg.to)) {
      try {
        const res = await fetch(`${addr}/api/message`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.HOTLINE_CLUSTER_KEY}`,
          },
          body: JSON.stringify({ ...msg, ttl: msg.ttl - 1 }),
        });
        if (res.ok) {
          return Response.json({ ok: true, accepted: true });
        }
      } catch {
        // Fall through to store
      }
    }
  }

  // Store for later delivery
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (global_id, from_agent, to_agent, content, timestamp, origin_node, ttl)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(msg.globalId, msg.from, msg.to, msg.content, Date.now(), msg.originNode, msg.ttl).run();

  // Purge expired seen IDs periodically (1 in 10 chance)
  if (Math.random() < 0.1) {
    await env.DB.prepare("DELETE FROM seen_message_ids WHERE expires_at < ?").bind(Date.now()).run();
    // Also purge old stored messages (older than 24h)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    await env.DB.prepare("DELETE FROM messages WHERE timestamp < ?").bind(cutoff).run();
  }

  return Response.json({ ok: true, accepted: true });
}
