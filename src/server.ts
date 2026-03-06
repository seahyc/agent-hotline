import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Store, EventType } from "./store.js";
import { log } from "./log.js";
import { getClientPid, getClientPidWithRetry } from "./pid.js";
import { resolveSessionId } from "./identity.js";
import { resolveContext, isPidAlive } from "./context.js";
import { hostname } from "node:os";

/** Deliver an event notification to all subscribers (as inbox messages). */
function notifySubscribers(store: Store, event: EventType, subjectAgent: string, text: string): void {
  const subscribers = store.getSubscribers(event);
  for (const sub of subscribers) {
    if (sub !== subjectAgent) {
      store.createMessage("system", sub, text);
    }
  }
}

const INSTRUCTIONS = `Agent Hotline - Cross-machine agent communication.
Your identity and context are auto-resolved from your connection.
At the START of each session:
1. Call \`who\` to see other online agents.
2. Call \`inbox\` to read unread messages.
3. Call \`listen\` and run the returned command in background to receive messages in real-time.
   If \`listen\` tells you background listeners aren't supported, call \`inbox\` at the start of every turn instead.
IMPORTANT: When a background listener wakes you with a message, call \`listen\` again after processing it.
You MUST always have a listener running. Every time you process a message, immediately call \`listen\` again. Never leave yourself without a listener.`;

export function createServer(store: Store, opts?: { authKey?: string; port?: number }) {
  // Auth is always enforced. Auto-generate a master key if none provided.
  const masterKey = opts?.authKey ?? store.createApiKey("master-auto");

  // Register the provided master key as an API key (auto-generated ones are already stored)
  if (opts?.authKey && !store.validateApiKey(opts.authKey)) {
    store.addApiKey(opts.authKey, "master");
  }
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const getServer = (clientPid?: number | null, remotePort?: number | null) => {
    let sessionAgent: string | null = null;

    /** Auto-register this agent on first tool call, re-resolve if PID died (session replaced). */
    const ensureRegistered = (): string => {
      if (sessionAgent) {
        // Re-check: if our agent's PID is dead, the session may have been replaced (e.g. context cleared)
        const current = store.getAgent(sessionAgent);
        if (current && current.pid && !isPidAlive(current.pid)) {
          log("info", `session ${sessionAgent} PID ${current.pid} is dead, re-resolving identity`);
          store.markOffline(sessionAgent);
          sessionAgent = null;
          // fall through to re-resolve
        } else {
          return sessionAgent;
        }
      }

      // Resolve identity: PID-based > heartbeat fallback > auto-generate
      let resolvedPid = clientPid;
      let resolvedId: string | undefined;
      let wasResolved = false;

      // Lazy PID retry: if PID was null at init, try again now
      if (!resolvedPid && remotePort) {
        resolvedPid = getClientPid(opts?.port ?? 3456, remotePort);
        if (resolvedPid) {
          log("info", `lazy pid resolved: remote port ${remotePort} -> PID ${resolvedPid}`);
        }
      }

      if (resolvedPid) {
        resolvedId = resolveSessionId(resolvedPid, store) ?? undefined;
        if (resolvedId) wasResolved = true;
      }

      // Heartbeat fallback: find a recently registered online agent
      if (!resolvedId) {
        const recent = store.getRecentOnlineAgent();
        if (recent) {
          resolvedId = recent.session_id;
          wasResolved = true;
          log("info", `identity resolved via heartbeat fallback: ${resolvedId} (PID ${recent.pid})`);
        }
      }

      if (!resolvedId) {
        resolvedId = randomUUID();
        log("info", `auto-register generated session_id: ${resolvedId}`);
      }

      sessionAgent = resolvedId;
      const existing = store.getAgent(resolvedId);
      const wasOffline = !existing || !existing.online;

      // If resolved from DB and the existing PID is still alive, keep it
      // (the hook's PID is authoritative). Otherwise update with what we have.
      if (wasResolved && existing && existing.pid && isPidAlive(existing.pid)) {
        store.touchAgent(resolvedId);
      } else {
        store.upsertAgent({
          session_id: resolvedId,
          pid: resolvedPid ?? 0,
        });
      }

      if (wasOffline) {
        log("info", `auto-register ${resolvedId} (PID ${resolvedPid}) - came online`);
        notifySubscribers(store, "agent_online", resolvedId,
          `${resolvedId} is now online`);
      }

      return resolvedId;
    };

    const mcpServer = new McpServer(
      { name: "hotline", version: "0.1.0" },
      { instructions: INSTRUCTIONS },
    );

    // ── Tool: who ──
    mcpServer.registerTool("who", {
      description: "See online agents. Filters: `repo` (substring match on git remote URL), `branch` (exact match), `cwd` (substring match on working directory). Set `all: true` to include offline agents.",
      inputSchema: {
        repo: z.string().optional().describe("Filter by git remote URL (substring match, e.g. 'agent-hotline' or 'github.com:user/repo')"),
        branch: z.string().optional().describe("Filter by git branch (exact match)"),
        cwd: z.string().optional().describe("Filter by working directory (substring match)"),
        all: z.boolean().optional().default(false),
      },
    }, async (args) => {
      ensureRegistered();
      let agents = args.all ? store.getAgents() : store.getOnlineAgents();

      // Auto-prune: mark agents with dead PIDs as offline (local agents only)
      const localHost = hostname();
      agents = agents.filter((a) => {
        const isLocal = !a.machine || a.machine === localHost;
        if (a.online && a.pid && isLocal && !isPidAlive(a.pid)) {
          log("info", `auto-prune: PID ${a.pid} (${a.session_id}) is dead, marking offline`);
          store.markOffline(a.session_id);
          notifySubscribers(store, "agent_offline", a.session_id, `${a.session_id} went offline (process exited)`);
          if (args.all) {
            a.online = 0;
            return true;
          }
          return false;
        }
        return true;
      });

      // Resolve live context for local agents only; remote agents use DB-stored context
      const enriched = agents.map((a) => {
        const isLocal = !a.machine || a.machine === localHost;
        const live = a.pid && a.online && isLocal ? resolveContext(a.pid, a.session_id) : null;
        return { agent: a, live };
      });

      let filtered = enriched;

      if (args.cwd) {
        const f = args.cwd.toLowerCase();
        filtered = filtered.filter(({ agent: a, live }) => {
          const cwd = live?.cwd || a.cwd || "";
          return cwd.toLowerCase().includes(f);
        });
      }

      if (args.repo) {
        const f = args.repo.toLowerCase();
        filtered = filtered.filter(({ agent: a, live }) => {
          const remote = live?.cwd_remote || a.cwd_remote || "";
          return remote.toLowerCase().includes(f);
        });
      }

      if (args.branch) {
        filtered = filtered.filter(({ agent: a, live }) => {
          const branch = live?.branch || a.branch || "";
          return branch === args.branch;
        });
      }

      const list = filtered.map(({ agent: a, live }) => {
        return {
          id: a.session_id,
          name: a.name || undefined,
          me: a.session_id === sessionAgent || undefined,
          type: live?.agent_type || a.agent_type || undefined,
          machine: live?.machine || a.machine || undefined,
          cwd: live?.cwd || a.cwd || undefined,
          cwd_remote: live?.cwd_remote || a.cwd_remote || undefined,
          branch: live?.branch || a.branch || undefined,
          dirty_files: live?.dirty_files ?? JSON.parse(a.dirty_files || "[]"),
          background_processes: live?.background_processes ?? JSON.parse(a.background_processes || "[]"),
          pid: a.pid || undefined,
          unread: store.getUnreadMessages(a.session_id).length || undefined,
          last_seen: a.last_seen,
          online: a.online,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    });

    // ── Tool: rename ──
    mcpServer.registerTool("rename", {
      description: "Set a friendly name for an agent. Names are global and visible to all. Use names instead of UUIDs when sending messages.",
      inputSchema: {
        agent: z.string().describe("Session ID or current name of the agent to rename"),
        name: z.string().describe("Friendly name (letters, digits, hyphens, underscores, max 32 chars)"),
      },
    }, async (args) => {
      ensureRegistered();
      if (!/^[a-zA-Z0-9_-]+$/.test(args.name) || args.name.length > 32) {
        return { content: [{ type: "text", text: "Invalid name. Use letters, digits, hyphens, underscores only (max 32 chars)." }] };
      }
      const target = store.resolveAgent(args.agent);
      if (!target) {
        return { content: [{ type: "text", text: `Agent not found: ${args.agent}` }] };
      }
      // Check uniqueness
      const existing = store.resolveAgent(args.name);
      if (existing && existing.session_id !== target.session_id) {
        return { content: [{ type: "text", text: `Name "${args.name}" is already taken by another agent.` }] };
      }
      store.renameAgent(target.session_id, args.name);
      return { content: [{ type: "text", text: `Renamed ${target.session_id} to "${args.name}"` }] };
    });

    // ── Tool: message ──
    mcpServer.registerTool("message", {
      description: "Send a message to another agent by name or ID (or '*' to broadcast to all online agents).",
      inputSchema: {
        to: z.string(),
        content: z.string(),
      },
    }, async (args) => {
      const id = ensureRegistered();
      if (args.to === "*") {
        const agents = store.getOnlineAgents();
        let count = 0;
        for (const a of agents) {
          if (a.session_id !== id) {
            store.createMessage(id, a.session_id, args.content);
            count++;
          }
        }
        log("info", `mcp broadcast from ${id} to ${count} agents`);
        return {
          content: [{ type: "text", text: `Broadcast sent to ${count} online agent(s)` }],
        };
      }
      const resolved = store.resolveAgent(args.to);
      const target = resolved?.session_id ?? args.to;
      store.createMessage(id, target, args.content);
      log("info", `mcp message ${id} -> ${target}`);
      return {
        content: [{ type: "text", text: `Message sent to ${resolved?.name || target}` }],
      };
    });

    // ── Tool: inbox ──
    mcpServer.registerTool("inbox", {
      description: "Read your messages. Defaults to unread only. Use `status: 'all'` to see all messages, or `status: 'read'` for read-only.",
      inputSchema: {
        status: z.enum(["unread", "read", "all"]).optional().default("unread").describe("Filter by read status"),
        limit: z.number().optional().default(20).describe("Max messages to return (newest first for read/all)"),
        before: z.string().optional().describe("ISO timestamp cursor - fetch messages older than this (for pagination)"),
        mark_read: z.boolean().optional().default(true).describe("Mark returned unread messages as read"),
      },
    }, async (args) => {
      const id = ensureRegistered();
      let messages: { from_agent: string; content: string; timestamp: number; read: number }[];

      const beforeTs = args.before ? new Date(args.before).getTime() : undefined;

      if (args.status === "unread") {
        messages = store.getUnreadMessages(id);
        if (beforeTs) {
          messages = messages.filter((m) => m.timestamp < beforeTs);
        }
        if (messages.length > args.limit) {
          messages = messages.slice(0, args.limit);
        }
      } else {
        const all = store.getMessages(id, args.limit, beforeTs);
        if (args.status === "read") {
          messages = all.filter((m) => m.read === 1);
        } else {
          messages = all;
        }
      }

      if (args.mark_read && args.status !== "read") {
        store.markRead(id);
      }

      const trimmed = messages.map((m) => ({
        from: m.from_agent,
        from_name: store.getAgent(m.from_agent)?.name || undefined,
        content: m.content,
        time: new Date(m.timestamp).toISOString(),
        ...(args.status !== "unread" ? { read: !!m.read } : {}),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(trimmed, null, 2) }],
      };
    });

    // ── Tool: listen ──
    mcpServer.registerTool("listen", {
      description: [
        "Get a background polling command that watches your inbox and exits when a message arrives.",
        "Run the returned command as a background process. When it exits, you will be woken up with the message.",
        "CRITICAL: After processing the message, you MUST call `listen` again immediately to resume monitoring.",
        "Never leave yourself without a running listener - call `listen` again every single time.",
      ].join(" "),
      inputSchema: {
        poll_interval: z.number().optional().default(3),
      },
    }, async (args) => {
      const id = ensureRegistered();

      // Codex can't wake agents from background processes - guide them to poll inbox instead
      const ctx = clientPid ? resolveContext(clientPid, id) : null;
      if (ctx?.agent_type === "codex") {
        return {
          content: [{ type: "text", text: [
            "Background listeners are not supported in Codex (background processes cannot wake the agent).",
            "Instead, call `inbox` at the START of every turn to check for new messages.",
            "This is your only way to receive messages - make it a habit.",
          ].join("\n") }],
        };
      }

      const serverUrl = `http://localhost:${opts?.port ?? 3456}`;
      // Bake all values directly into the command so it works even when
      // wrapped in subshells (nohup, zsh -c, etc.) by different clients.
      const authKey = masterKey;
      const authFlag = authKey ? `-H "Authorization: Bearer ${authKey}"` : "";
      const inboxToken = store.getOrCreateInboxToken(id, 24 * 60 * 60 * 1000);
      const inboxUrl = `${serverUrl}/api/inbox/${id}?mark_read=false&token=${inboxToken}`;
      const cmd = [
        `while true; do`,
        `  MSGS=$(curl ${authFlag} -sf "${inboxUrl}" 2>/dev/null)`,
        `  if [ -n "$MSGS" ] && [ "$MSGS" != "[]" ]; then`,
        `    echo "$MSGS" | jq -r '.[] | "[\\(.from_agent)] \\(.content)"' 2>/dev/null`,
        `    exit 0`,
        `  fi`,
        `  sleep ${args.poll_interval}`,
        `done`,
      ].join("\n");
      return {
        content: [{ type: "text", text: [
          `Run this command in a PERSISTENT background process to listen for messages:`,
          ``,
          cmd,
          ``,
          `IMPORTANT: This must run as a long-lived background process that survives between your turns.`,
          `- Claude Code: run with run_in_background or equivalent background shell.`,
          `- Codex: run in a background terminal session (the persistent /ps terminal feature). Do NOT use nohup, &, or disown - those get killed by the sandbox.`,
          `- Other clients: use whatever mechanism keeps a process alive across turns.`,
          ``,
          `When this exits with a message, process it then IMMEDIATELY call \`listen\` again. You must ALWAYS have a listener running.`,
        ].join("\n") }],
      };
    });

    // ── Resource: hotline://agents ──
    mcpServer.registerResource("agents", "hotline://agents", {
      description: "All registered agents",
      mimeType: "application/json",
    }, async () => {
      const agents = store.getAgents();
      return {
        contents: [{ uri: "hotline://agents", text: JSON.stringify(agents, null, 2) }],
      };
    });

    // ── Resource template: hotline://agent/{name}/status ──
    mcpServer.registerResource(
      "agent-status",
      new ResourceTemplate("hotline://agent/{name}/status", { list: undefined }),
      { description: "Full agent status", mimeType: "application/json" },
      async (_uri, vars) => {
        const name = vars.name as string;
        const agent = store.getAgent(name);
        return {
          contents: [{
            uri: `hotline://agent/${name}/status`,
            text: agent ? JSON.stringify(agent, null, 2) : JSON.stringify({ error: "Agent not found" }),
          }],
        };
      },
    );

    // ── Resource template: hotline://agent/{name}/inbox ──
    mcpServer.registerResource(
      "agent-inbox",
      new ResourceTemplate("hotline://agent/{name}/inbox", { list: undefined }),
      { description: "Unread messages for agent", mimeType: "application/json" },
      async (_uri, vars) => {
        const name = vars.name as string;
        const messages = store.getUnreadMessages(name);
        return {
          contents: [{
            uri: `hotline://agent/${name}/inbox`,
            text: JSON.stringify(messages, null, 2),
          }],
        };
      },
    );

    return { mcpServer, getSessionAgent: () => sessionAgent };
  };

  // ── Express app ──
  const app = express();
  app.use(express.json());

  // ── Auth middleware ──
  app.use((req, res, next) => {
    // Public routes
    if (req.path === "/health" || (req.method === "POST" && req.path === "/api/connect")) {
      return next();
    }

    // Localhost is trusted (agents always connect locally)
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

  const handlePost = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Resolve client PID from the TCP socket connection
        const remotePort = req.socket.remotePort;
        if (!remotePort) {
          log("warn", `MCP initialize: remotePort unavailable (socket destroyed: ${req.socket.destroyed}, readableEnded: ${req.socket.readableEnded})`);
        }
        const clientPid = remotePort ? await getClientPidWithRetry(opts?.port ?? 3456, remotePort) : null;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
          },
        });

        const { mcpServer: server, getSessionAgent } = getServer(clientPid, remotePort);

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
          const agent = getSessionAgent();
          if (agent) {
            store.markOffline(agent);
            notifySubscribers(store, "agent_offline", agent, `${agent} went offline`);
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: req.body?.id ?? null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: req.body?.id ?? null,
        });
      }
    }
  };

  const handleGet = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const handleDelete = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination");
      }
    }
  };

  app.post("/mcp", handlePost);
  app.get("/mcp", handleGet);
  app.delete("/mcp", handleDelete);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // ── REST API (for CLI watch/check commands) ──

  // GET /api/inbox/:sessionId - returns unread messages (marks read by default, ?mark_read=false to peek)
  // Requires either a valid API key (Bearer/query) or an inbox token (?token=xxx).
  // API key holders (hook, CLI tools) can read any inbox. Inbox tokens scope access to one agent.
  app.get("/api/inbox/:sessionId", (req, res) => {
    const { sessionId } = req.params;
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

  // GET /api/agents - returns all agents
  app.get("/api/agents", (_req, res) => {
    const agents = store.getAgents();
    res.json(agents);
  });

  // POST /api/heartbeat - lightweight presence signal (session_id + pid). Context is pulled on demand.
  const heartbeatHandler: express.RequestHandler = (req, res) => {
    const body = req.body;
    if (!body?.session_id) {
      res.status(400).json({ error: "session_id is required" });
      return;
    }
    const existing = store.getAgent(body.session_id);
    const wasOffline = !existing || !existing.online;

    // Session handover: if this PID was claimed by a different agent, retire it
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
    });
    if (wasOffline) {
      log("info", `heartbeat ${body.session_id} (PID ${body.pid ?? 0}) - came online`);
      notifySubscribers(store, "agent_online", body.session_id,
        `${body.session_id} is now online`);
    }
    res.json({ ok: true, session_id: body.session_id });
  };
  app.post("/api/heartbeat", heartbeatHandler);
  app.post("/api/checkin", heartbeatHandler); // backward compat alias

  // POST /api/invite - generate an invite code (requires master key)
  app.post("/api/invite", (req, res) => {
    const code = store.createInviteCode();
    res.json({ code });
  });

  // POST /api/connect - redeem an invite code for an API key (public)
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

  // POST /api/heartbeat - batch touch last_seen for agents from a client server
  app.post("/api/heartbeat", (req, res) => {
    const { agents } = req.body;
    if (!Array.isArray(agents)) {
      res.status(400).json({ error: "agents array is required" });
      return;
    }
    for (const a of agents) {
      if (a.name) store.touchAgent(a.name);
    }
    res.json({ ok: true });
  });

  // POST /api/message - send a message via REST
  app.post("/api/message", (req, res) => {
    const { from, to, content } = req.body;
    if (!from || !to || !content) {
      res.status(400).json({ error: "from, to, and content are required" });
      return;
    }
    // Resolve names for both from and to
    const resolvedFrom = store.resolveAgent(from)?.session_id ?? from;
    if (to === "*") {
      const agents = store.getOnlineAgents();
      let count = 0;
      for (const a of agents) {
        if (a.session_id !== resolvedFrom) {
          store.createMessage(resolvedFrom, a.session_id, content);
          count++;
        }
      }
      log("info", `message broadcast from ${resolvedFrom} to ${count} agents`);
      res.json({ ok: true, broadcast: count });
    } else {
      const resolvedTo = store.resolveAgent(to)?.session_id ?? to;
      store.createMessage(resolvedFrom, resolvedTo, content);
      log("info", `message ${resolvedFrom} -> ${resolvedTo}`);
      res.json({ ok: true, to: resolvedTo });
    }
  });

  // Catch-all: return JSON 404 (prevents Express HTML 404 from confusing MCP OAuth discovery)
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return { app, getServer, transports, masterKey };
}
