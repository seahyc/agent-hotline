import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename } from "node:path";
import express from "express";
import type { Store, EventType } from "./store.js";
import { log } from "./log.js";
import { resolveSessionId } from "./identity.js";
import { resolveContext, resolveContextForCwd, isPidAlive } from "./context.js";
import { hostname } from "node:os";
import { getNodeId } from "./node.js";
import { buildGossipPayload, mergeGossip, hashClusterKey } from "./peers.js";
import { createMeshRouter, type MeshRouter } from "./mesh.js";
import { addSseClient, removeSseClient, notifySseClients, type SseClient } from "./sse.js";
import { UI_HTML } from "./ui.js";

const require = createRequire(import.meta.url);
const pkgVersion: string = require("../package.json").version;

/** Extract @mentioned session_ids from content. */
function extractMentions(content: string, store: Store): string[] {
  const names = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
  return names
    .map(n => store.resolveAgent(n)?.session_id)
    .filter((id): id is string => !!id);
}

/** Deliver an event notification to all subscribers (as inbox messages). */
function notifySubscribers(store: Store, event: EventType, subjectAgent: string, text: string): void {
  const subscribers = store.getSubscribers(event);
  for (const sub of subscribers) {
    if (sub !== subjectAgent) {
      const msgId = store.createMessage("system", sub, text);
      const msg = store.getMessage(msgId);
      if (msg) notifySseClients(sub, msg);
    }
  }
}

/** Sanitize a free-form string (tab title, folder name) into a valid agent name. */
export function sanitizeName(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

/**
 * Give an unnamed agent a legible default name: terminal tab title if known,
 * else the cwd folder name. Collisions get a short session-id suffix, so
 * multiple agents in the same directory stay distinguishable.
 */
function autoNameAgent(store: Store, sessionId: string, title?: string, cwd?: string): void {
  const agent = store.getAgent(sessionId);
  if (!agent) return;

  // A tab rename should propagate: re-derive when the stored title changed and
  // the current name was itself derived from the old title (manual renames survive).
  const titleChanged = title && title !== agent.title;
  const nameWasFromTitle = agent.name !== "" && agent.title !== "" &&
    (agent.name === sanitizeName(agent.title) || agent.name.startsWith(`${sanitizeName(agent.title)}-`));
  if (agent.name && !(titleChanged && nameWasFromTitle)) {
    if (titleChanged) store.upsertAgent({ session_id: sessionId, title });
    return;
  }

  const base = sanitizeName(title || (cwd ? basename(cwd) : ""));
  if (!base) return;

  let name = base;
  let existing = store.resolveAgent(name);
  if (existing && existing.session_id !== sessionId) {
    name = `${base.slice(0, 27)}-${sessionId.slice(0, 4)}`;
    existing = store.resolveAgent(name);
    if (existing && existing.session_id !== sessionId) return; // give up, keep session_id
  }
  store.renameAgent(sessionId, name);
  if (title) store.upsertAgent({ session_id: sessionId, title });
  log("info", `auto-named ${sessionId} -> "${name}" (${title ? "tab title" : "cwd"})`);
}

// PIDs that recently failed to resolve — skip for a while instead of re-running
// lsof/ps against them on every scan.
const scanFailures = new Map<number, number>();
const SCAN_FAILURE_TTL_MS = 10 * 60 * 1000;

// PIDs already mapped to a session. Apps like the Codex desktop spawn several
// matching processes for one session; only one PID can live in the agents row,
// so without this cache the others would re-resolve (lsof/ps) every scan.
const scanResolved = new Map<number, string>();

/** Scan for running Claude Code and Codex agents and auto-register them. */
export async function scanForAgents(store: Store): Promise<void> {
  try {
    // Match the executable word itself (claude / codex), not any process whose
    // args merely mention them (MCP servers, helpers, this CLI...).
    const raw = execSync(String.raw`pgrep -f "(^|[ /])(claude|codex)( |$)" 2>/dev/null || true`, { encoding: "utf-8", timeout: 5000 });
    const pids = raw.split("\n").map(Number).filter(n => n > 0 && n !== process.pid);
    const now = Date.now();

    const livePids = new Set(pids);

    for (const pid of pids) {
      if (scanResolved.has(pid)) continue;
      const existing = store.getAgentByPid(pid);
      if (existing) {
        scanResolved.set(pid, existing.session_id);
        continue;
      }

      const failedAt = scanFailures.get(pid);
      if (failedAt && now - failedAt < SCAN_FAILURE_TTL_MS) continue;

      const sessionId = await resolveSessionId(pid, store);
      if (!sessionId) {
        scanFailures.set(pid, now);
        continue;
      }
      scanFailures.delete(pid);
      scanResolved.set(pid, sessionId);

      // Another PID of the same session already registered? Don't fight over the row.
      const knownSession = store.getAgent(sessionId);
      if (knownSession && knownSession.online && knownSession.pid !== pid) continue;

      const ctx = await resolveContext(pid, sessionId);
      store.upsertAgent({
        session_id: sessionId,
        pid,
        agent_type: ctx.agent_type,
        machine: ctx.machine,
        cwd: ctx.cwd,
        cwd_remote: ctx.cwd_remote,
        branch: ctx.branch,
      });
      autoNameAgent(store, sessionId, undefined, ctx.cwd);
      log("info", `auto-discovered: ${sessionId} (PID ${pid})`);
    }

    // Drop entries for processes that are gone, and stale failures
    for (const pid of scanResolved.keys()) {
      if (!livePids.has(pid)) scanResolved.delete(pid);
    }
    for (const [pid, ts] of scanFailures) {
      if (now - ts > SCAN_FAILURE_TTL_MS) scanFailures.delete(pid);
    }
  } catch (e) {
    log("warn", `scanForAgents failed: ${e}`);
  }
}

export function createServer(store: Store, opts?: {
  authKey?: string;
  port?: number;
  clusterKey?: string;
  bootstrapUrls?: string[];
}) {
  const masterKey = opts?.authKey ?? store.createApiKey("master-auto");
  if (opts?.authKey && !store.validateApiKey(opts.authKey)) {
    store.addApiKey(opts.authKey, "master");
  }

  const clusterKey = opts?.clusterKey;
  let meshRouter: MeshRouter | null = null;
  if (clusterKey) {
    meshRouter = createMeshRouter(store, { clusterKey });
  }

  const app = express();
  app.use(express.json());

  // ── Auth middleware ──
  app.use((req, res, next) => {
    if (req.path === "/health" || (req.method === "POST" && req.path === "/api/connect")) {
      return next();
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? "";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
      return next();
    }

    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryKey = req.query.key as string | undefined;
    const key = bearer || queryKey;

    if (!key || !store.validateApiKey(key)) {
      log("warn", `auth rejected ${req.method} ${req.path} from ${ip}`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  });

  // ── Health ──
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ── Web UI (humans) ──
  app.get("/", (_req, res) => {
    res.type("html").send(UI_HTML);
  });

  // ── GET /api/activity ── unified firehose for the web UI
  app.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string || "100", 10), 500);
    const rows = store.getRecentActivity(limit);
    res.json(rows.map(r => ({
      from: r.from_agent,
      from_name: store.getAgent(r.from_agent)?.name || undefined,
      to: r.to_agent || undefined,
      to_name: r.to_agent ? (store.getAgent(r.to_agent)?.name || undefined) : undefined,
      room: r.room || undefined,
      content: r.content,
      time: new Date(r.timestamp).toISOString(),
    })));
  });

  // ── GET /api/agents ──
  // ?online=true for online-only, optional hostname-based auto-pruning
  app.get("/api/agents", (req, res) => {
    const onlineOnly = req.query.online === "true";
    const localHost = hostname();

    let agents = onlineOnly ? store.getOnlineAgents() : store.getAgents();

    if (onlineOnly) {
      // Auto-prune dead local PIDs
      agents = agents.filter(a => {
        const isLocal = !a.machine || a.machine === localHost;
        if (a.online && a.pid && isLocal && !isPidAlive(a.pid)) {
          log("info", `auto-prune: PID ${a.pid} (${a.session_id}) is dead, marking offline`);
          store.markOffline(a.session_id);
          notifySubscribers(store, "agent_offline", a.session_id, `${a.session_id} went offline (process exited)`);
          return false;
        }
        return true;
      });
    }

    res.json(agents);
  });

  // ── GET /api/inbox/:sessionId ── (accepts a friendly name or session id)
  app.get("/api/inbox/:sessionId", (req, res) => {
    const sessionId = store.resolveAgent(req.params.sessionId)?.session_id ?? req.params.sessionId;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryKey = req.query.key as string | undefined;
    const hasApiKey = (bearer && store.validateApiKey(bearer)) || (queryKey && store.validateApiKey(queryKey));
    if (!hasApiKey) {
      const token = req.query.token as string | undefined;
      if (!token || !store.validateInboxToken(sessionId, token)) {
        res.status(403).json({ error: "Invalid or missing inbox token" });
        return;
      }
    }
    const messages = store.getUnreadMessages(sessionId);
    if (req.query.mark_read !== "false") {
      store.markRead(sessionId);
    }
    res.json(messages);
  });

  // ── GET /api/sse/:sessionId ── Server-Sent Events (accepts name or session id)
  app.get("/api/sse/:sessionId", (req, res) => {
    const sessionId = store.resolveAgent(req.params.sessionId)?.session_id ?? req.params.sessionId;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryKey = req.query.key as string | undefined;
    const hasApiKey = (bearer && store.validateApiKey(bearer)) || (queryKey && store.validateApiKey(queryKey));
    if (!hasApiKey) {
      const token = req.query.token as string | undefined;
      if (!token || !store.validateInboxToken(sessionId, token)) {
        res.status(403).json({ error: "Invalid or missing inbox token" });
        return;
      }
    }

    const roomsParam = req.query.rooms as string | undefined;
    const rooms = roomsParam ? roomsParam.split(",").map(r => r.trim()).filter(Boolean) : null;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.flushHeaders();

    const client: SseClient = { res, rooms };
    addSseClient(sessionId, client);
    log("info", `SSE connected: ${sessionId}${rooms ? ` (rooms: ${rooms.join(",")})` : ""}`);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      removeSseClient(sessionId, client);
      log("info", `SSE disconnected: ${sessionId}`);
    });
  });

  // ── POST /api/inbox-token ── generate scoped inbox token for listen/wait
  app.post("/api/inbox-token", (req, res) => {
    const { session_id } = req.body;
    if (!session_id) {
      res.status(400).json({ error: "session_id is required" });
      return;
    }
    const resolved = store.resolveAgent(session_id)?.session_id ?? session_id;
    const token = store.getOrCreateInboxToken(resolved, 24 * 60 * 60 * 1000);
    res.json({ token });
  });

  // ── POST /api/heartbeat ──
  // Body: { session_id, pid?, title?, cwd? } — title is the terminal tab name, if the
  // hook could capture one. Responds with enough for the hook to greet the agent.
  const heartbeatHandler: express.RequestHandler = (req, res) => {
    const body = req.body;
    if (!body?.session_id) {
      res.status(400).json({ error: "session_id is required" });
      return;
    }
    const existing = store.getAgent(body.session_id);
    const wasOffline = !existing || !existing.online;

    if (body.pid) {
      const prev = store.getAgentByPid(body.pid);
      if (prev && prev.session_id !== body.session_id) {
        log("info", `session handover: PID ${body.pid} moved from ${prev.session_id} to ${body.session_id}`);
        store.markOffline(prev.session_id);
        notifySubscribers(store, "agent_offline", prev.session_id,
          `${prev.session_id} went offline (session replaced by ${body.session_id})`);
      }
    }

    store.upsertAgent({
      session_id: body.session_id,
      pid: body.pid ?? 0,
      ...(body.cwd ? { cwd: body.cwd } : {}),
    });
    const title = typeof body.title === "string" ? body.title.slice(0, 128) : undefined;
    autoNameAgent(store, body.session_id, title, body.cwd);

    if (wasOffline) {
      log("info", `heartbeat ${body.session_id} (PID ${body.pid ?? 0}) - came online`);
      notifySubscribers(store, "agent_online", body.session_id,
        `${body.session_id} is now online`);
    }

    const agent = store.getAgent(body.session_id);
    const online = store.getOnlineAgents()
      .filter(a => a.session_id !== body.session_id)
      .slice(0, 50)
      .map(a => ({ id: a.session_id, name: a.name || undefined, machine: a.machine || undefined }));
    res.json({
      ok: true,
      session_id: body.session_id,
      name: agent?.name ?? "",
      unread: store.getUnreadMessages(body.session_id).length,
      online,
    });

    // Refresh context (cwd, branch, agent type) off the request path — the hook
    // has sub-second curl timeouts and must never wait on lsof/git.
    // When the hook supplies a cwd, trust it over the process's kernel cwd:
    // sessions sharing one claude app process all report the app's launch dir.
    const pid = body.pid;
    if (pid && isPidAlive(pid)) {
      const ctxPromise = body.cwd
        ? resolveContextForCwd(body.cwd, pid)
        : resolveContext(pid, body.session_id);
      ctxPromise
        .then((ctx) => {
          if (!ctx.cwd) return;
          store.upsertAgent({
            session_id: body.session_id,
            pid,
            agent_type: ctx.agent_type,
            machine: ctx.machine,
            cwd: ctx.cwd,
            cwd_remote: ctx.cwd_remote,
            branch: ctx.branch,
            dir_chain: ctx.dir_chain,
          });
          autoNameAgent(store, body.session_id, title, ctx.cwd);
          // This agent's directory chain just changed, which can cross (or drop
          // below) the >=2-sharer threshold for its whole cohort — e.g. it's the
          // second agent to enter a repo, so the first must join too. Reconcile
          // all online agents so project rooms converge immediately rather than
          // waiting for the next presence sweep.
          store.reconcileAllAutoRooms();
        })
        .catch((e) => log("warn", `context refresh failed for ${body.session_id}: ${e}`));
    }
  };
  app.post("/api/heartbeat", heartbeatHandler);
  app.post("/api/checkin", heartbeatHandler);

  // ── GET /api/status ── one-shot diagnostic: server + caller identity + inbox
  app.get("/api/status", (req, res) => {
    const sessionId = req.query.session_id as string | undefined;
    const peers = store.getPeers().filter(p => p.status !== "dead");
    const onlineAgents = store.getOnlineAgents().map(a => ({
      id: a.session_id,
      name: a.name || undefined,
      machine: a.machine || undefined,
      branch: a.branch || undefined,
      cwd: a.cwd || undefined,
    }));
    const result: Record<string, unknown> = {
      server: {
        version: pkgVersion,
        port: opts?.port ?? 3456,
        mesh: !!clusterKey,
        peers: peers.length,
      },
      agents_online: onlineAgents,
    };
    if (sessionId) {
      const agent = store.resolveAgent(sessionId);
      if (agent) {
        result.agent = {
          session_id: agent.session_id,
          name: agent.name || undefined,
          unread: store.getUnreadMessages(agent.session_id).length,
          rooms: store.getAgentRooms(agent.session_id),
        };
      }
    }
    res.json(result);
  });

  // ── POST /api/resolve ── resolve session_id from a PID (for CLI identity)
  app.post("/api/resolve", async (req, res) => {
    const { pid } = req.body;
    if (!pid) {
      res.status(400).json({ error: "pid is required" });
      return;
    }
    const sessionId = await resolveSessionId(Number(pid), store);
    if (!sessionId) {
      res.status(404).json({ error: "Could not resolve session_id for this PID" });
      return;
    }
    res.json({ session_id: sessionId });
  });

  // ── POST /api/message ──
  app.post("/api/message", async (req, res) => {
    const body = req.body;

    // Mesh relay message (from another node)
    if (body.globalId && body.originNode && meshRouter) {
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (clusterKey && bearer !== clusterKey) {
        res.status(401).json({ error: "Invalid cluster key" });
        return;
      }
      const accepted = await meshRouter.receiveRelayed(body);
      res.json({ ok: true, accepted });
      return;
    }

    const { from, to, content } = body;
    if (!from || !to || !content) {
      res.status(400).json({ error: "from, to, and content are required" });
      return;
    }

    const resolvedFrom = store.resolveAgent(from)?.session_id ?? from;
    const mentionedIds = extractMentions(content, store);

    // Room message — quiet by construction: always recorded in history, but only
    // @mentioned agents get an inbox push. Non-mention chatter is pull-based
    // (read --room). Sender auto-joins so they show up as a member.
    if (to.startsWith("#")) {
      const roomName = to.slice(1);
      store.joinRoom(roomName, resolvedFrom);
      store.createRoomMessage(resolvedFrom, roomName, content, { mentionsJson: JSON.stringify(mentionedIds) });
      const pinged = new Set<string>();
      for (const mid of mentionedIds) {
        if (mid !== resolvedFrom && !pinged.has(mid)) {
          pinged.add(mid);
          const mentionId = store.createMessage(resolvedFrom, mid, content, {
            room: roomName, msgType: "mention", mentionsJson: JSON.stringify(mentionedIds),
          });
          const mentionMsg = store.getMessage(mentionId);
          if (mentionMsg) notifySseClients(mid, mentionMsg);
        }
      }
      log("info", `room message from ${resolvedFrom} to #${roomName} (${pinged.size} pinged)`);
      res.json({ ok: true, room: roomName, notified: pinged.size });
      return;
    }

    // Broadcast — deliberate machine-wide blast, opt-in via --all/--force.
    if (to === "*") {
      const agents = store.getOnlineAgents();
      const recipients = agents.filter(a => a.session_id !== resolvedFrom);
      if (!body.force) {
        res.status(400).json({
          error: `Broadcast to ${recipients.length} agents needs --all. Use a #room or DM for targeted messages.`,
        });
        return;
      }
      let count = 0;
      for (const a of recipients) {
        const bcId = store.createMessage(resolvedFrom, a.session_id, content, { msgType: "broadcast" });
        const bcMsg = store.getMessage(bcId);
        if (bcMsg) notifySseClients(a.session_id, bcMsg);
        count++;
      }
      log("info", `forced broadcast from ${resolvedFrom} to ${count} agents`);
      res.json({ ok: true, broadcast: count });
      return;
    }

    // Direct message
    if (meshRouter) {
      const result = await meshRouter.route(resolvedFrom, to, content);
      log("info", `message ${resolvedFrom} -> ${result.target} (${result.method})`);
      res.json({ ok: true, to: result.target, method: result.method });
    } else {
      const resolvedTo = store.resolveAgent(to)?.session_id ?? to;
      const dmId = store.createMessage(resolvedFrom, resolvedTo, content, { mentionsJson: JSON.stringify(mentionedIds) });
      const dmMsg = store.getMessage(dmId);
      if (dmMsg) notifySseClients(resolvedTo, dmMsg);
      log("info", `message ${resolvedFrom} -> ${resolvedTo}`);
      res.json({ ok: true, to: resolvedTo });
    }
  });

  // ── POST /api/rename ──
  app.post("/api/rename", (req, res) => {
    const { session_id, name } = req.body;
    if (!session_id || !name) {
      res.status(400).json({ error: "session_id and name are required" });
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 32) {
      res.status(400).json({ error: "Invalid name. Use letters, digits, hyphens, underscores only (max 32 chars)" });
      return;
    }
    const target = store.resolveAgent(session_id);
    if (!target) {
      res.status(404).json({ error: `Agent not found: ${session_id}` });
      return;
    }
    const existing = store.resolveAgent(name);
    if (existing && existing.session_id !== target.session_id) {
      res.status(409).json({ error: `Name "${name}" is already taken` });
      return;
    }
    store.renameAgent(target.session_id, name);
    res.json({ ok: true, session_id: target.session_id, name });
  });

  // ── GET /api/rooms ──
  app.get("/api/rooms", (req, res) => {
    const sessionId = req.query.session_id as string | undefined;
    const all = req.query.all === "true";
    const myRooms = sessionId ? new Set(store.getAgentRooms(sessionId)) : new Set<string>();
    const allRooms = store.listRooms();
    const filtered = (all || !sessionId) ? allRooms : allRooms.filter(r => myRooms.has(r.name));
    const result = filtered.map(r => {
      const members = store.getRoomMembers(r.name);
      return {
        name: r.name,
        memberCount: r.memberCount,
        members: members.map(sid => {
          const agent = store.getAgent(sid);
          return { id: sid, name: agent?.name || undefined };
        }),
        joined: sessionId ? myRooms.has(r.name) : undefined,
      };
    });
    res.json(result);
  });

  // ── POST /api/rooms/join ──
  app.post("/api/rooms/join", (req, res) => {
    const { session_id, room } = req.body;
    if (!session_id || !room) {
      res.status(400).json({ error: "session_id and room are required" });
      return;
    }
    const roomName = (room as string).replace(/^#/, "");
    store.joinRoom(roomName, session_id);
    const members = store.getRoomMembers(roomName);
    res.json({ ok: true, room: roomName, memberCount: members.length });
  });

  // ── POST /api/rooms/leave ──
  app.post("/api/rooms/leave", (req, res) => {
    const { session_id, room } = req.body;
    if (!session_id || !room) {
      res.status(400).json({ error: "session_id and room are required" });
      return;
    }
    const roomName = (room as string).replace(/^#/, "");
    store.leaveRoom(roomName, session_id);
    res.json({ ok: true, room: roomName });
  });

  // ── GET /api/messages ── browse room or DM history
  app.get("/api/messages", (req, res) => {
    const sessionId = req.query.session_id as string | undefined;
    const room = req.query.room as string | undefined;
    const dm = req.query.dm as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string || "50", 10), 200);
    const before = req.query.before as string | undefined;
    const beforeTs = before ? new Date(before).getTime() : undefined;

    if (room) {
      const roomName = room.replace(/^#/, "");
      const msgs = store.getRoomMessages(roomName, limit, beforeTs);
      res.json(msgs.map(m => ({
        id: m.id,
        from: m.from_agent,
        from_name: store.getAgent(m.from_agent)?.name || undefined,
        content: m.content,
        time: new Date(m.timestamp).toISOString(),
        ...(m.reply_to_id ? { reply_to: m.reply_to_id } : {}),
      })));
      return;
    }

    if (dm && sessionId) {
      const resolved = store.resolveAgent(dm);
      const targetId = resolved?.session_id ?? dm;
      const myMessages = store.getMessages(sessionId, limit * 2, beforeTs);
      const theirMessages = store.getMessages(targetId, limit * 2, beforeTs);
      const allMsgs = [...myMessages, ...theirMessages]
        .filter(m =>
          (m.from_agent === sessionId && m.to_agent === targetId) ||
          (m.from_agent === targetId && m.to_agent === sessionId)
        )
        .filter(m => !m.room)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
      const seen = new Set<number>();
      const deduped = allMsgs.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      res.json(deduped.map(m => ({
        id: m.id,
        from: m.from_agent,
        from_name: store.getAgent(m.from_agent)?.name || undefined,
        content: m.content,
        time: new Date(m.timestamp).toISOString(),
        ...(m.reply_to_id ? { reply_to: m.reply_to_id } : {}),
      })));
      return;
    }

    res.status(400).json({ error: "Specify ?room=name or ?dm=agent&session_id=id" });
  });

  // ── POST /api/invite ──
  app.post("/api/invite", (_req, res) => {
    const code = store.createInviteCode();
    res.json({ code });
  });

  // ── POST /api/connect ──
  app.post("/api/connect", (req, res) => {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: "code is required" });
      return;
    }
    const key = store.redeemInviteCode(code);
    if (!key) {
      res.status(400).json({ error: "Invalid or already used invite code" });
      return;
    }
    res.json({ key });
  });

  // ── POST /api/gossip ──
  app.post("/api/gossip", (req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (clusterKey && bearer !== clusterKey) {
      res.status(401).json({ error: "Invalid cluster key" });
      return;
    }
    if (!clusterKey) {
      res.status(400).json({ error: "Mesh not configured (no cluster key)" });
      return;
    }

    const payload = req.body;
    if (!payload?.nodeId || !payload?.peers) {
      res.status(400).json({ error: "Invalid gossip payload" });
      return;
    }

    const expectedHash = hashClusterKey(clusterKey);
    if (payload.clusterKeyHash && payload.clusterKeyHash !== expectedHash) {
      res.status(401).json({ error: "Cluster key mismatch" });
      return;
    }

    const localNodeId = getNodeId();
    mergeGossip(store, payload, localNodeId);

    if (meshRouter) {
      meshRouter.retryPending().catch((e) => log("error", `retry pending failed: ${e}`));
    }

    const selfAddr = `http://localhost:${opts?.port ?? 3456}`;
    const response = buildGossipPayload(store, clusterKey, selfAddr);
    res.json(response);
  });

  // Catch-all: JSON 404
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return { app, masterKey, meshRouter };
}
