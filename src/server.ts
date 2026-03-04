import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Store, EventType } from "./store.js";

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
At the START of each session:
1. Call \`checkin\` with your status, cwd, branch, files, and background processes.
2. Call \`who\` to see other online agents.
3. Call \`inbox\` to read unread messages.
4. Call \`listen\` and run the returned command in background to receive messages in real-time.
When your status changes, call \`checkin\` again.
IMPORTANT: When a background listener wakes you with a message, call \`listen\` again after processing it.`;

export function createServer(store: Store, opts?: { authKey?: string }) {
  // Auth is always enforced. Auto-generate a master key if none provided.
  const masterKey = opts?.authKey ?? store.createApiKey("master-auto");

  // Register the provided master key as an API key (auto-generated ones are already stored)
  if (opts?.authKey && !store.validateApiKey(opts.authKey)) {
    store.addApiKey(opts.authKey, "master");
  }
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const getServer = () => {
    let sessionAgent: string | null = null;

    const mcpServer = new McpServer(
      { name: "hotline", version: "0.1.0" },
      { instructions: INSTRUCTIONS },
    );

    // ── Tool: checkin ──
    mcpServer.registerTool("checkin", {
      description: "Push your context to the server",
      inputSchema: {
        agent_name: z.string(),
        agent_type: z.string().describe("e.g. claude-code, opencode, codex, cursor, windsurf"),
        machine: z.string(),
        cwd: z.string(),
        cwd_remote: z.string().optional(),
        branch: z.string(),
        status: z.string(),
        dirty_files: z.array(z.string()).optional(),
        background_processes: z.array(z.object({
          pid: z.number(),
          port: z.number().optional(),
          command: z.string(),
          description: z.string(),
        })).optional(),
        git_diff: z.string().optional(),
        conversation_recent: z.string().optional(),
        session_id: z.string().optional(),
        terminal: z.string().optional(),
        pid: z.number().optional(),
      },
    }, async (args) => {
      sessionAgent = args.agent_name;
      const existing = store.getAgent(args.agent_name);
      const wasOffline = !existing || !existing.online;
      store.upsertAgent({
        agent_name: args.agent_name,
        agent_type: args.agent_type,
        machine: args.machine,
        cwd: args.cwd,
        cwd_remote: args.cwd_remote ?? "",
        branch: args.branch,
        status: args.status,
        dirty_files: args.dirty_files ? JSON.stringify(args.dirty_files) : "[]",
        background_processes: args.background_processes ? JSON.stringify(args.background_processes) : "[]",
        git_diff: args.git_diff ?? "",
        conversation_recent: args.conversation_recent ?? "",
        session_id: args.session_id ?? "",
        terminal: args.terminal ?? "",
        pid: args.pid ?? 0,
      });
      if (wasOffline) {
        notifySubscribers(store, "agent_online", args.agent_name,
          `${args.agent_name} is now online (${args.machine}, ${args.cwd})`);
      }
      return {
        content: [{ type: "text", text: `Checked in as ${args.agent_name}` }],
      };
    });

    // ── Tool: who ──
    mcpServer.registerTool("who", {
      description: "See agents. Defaults to online only. Set `all: true` to include offline agents. Optionally filter by `cwd_filter` (substring matched against agents' cwd).",
      inputSchema: {
        cwd_filter: z.string().optional(),
        all: z.boolean().optional().default(false),
      },
    }, async (args) => {
      let agents = args.all ? store.getAgents(args.cwd_filter) : store.getOnlineAgents();
      if (!args.all && args.cwd_filter) {
        const filter = args.cwd_filter.toLowerCase();
        agents = agents.filter((a) => a.cwd.toLowerCase().includes(filter));
      }
      const list = agents.map((a) => ({
        name: a.agent_name,
        type: a.agent_type,
        machine: a.machine,
        cwd: a.cwd,
        cwd_remote: a.cwd_remote,
        branch: a.branch,
        status: a.status,
        dirty_files: JSON.parse(a.dirty_files || "[]"),
        background_processes: JSON.parse(a.background_processes || "[]"),
        session_id: a.session_id || undefined,
        terminal: a.terminal || undefined,
        pid: a.pid || undefined,
        last_seen: a.last_seen,
        online: a.online,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    });

    // ── Tool: message ──
    mcpServer.registerTool("message", {
      description: "Send a message to another agent (or '*' to broadcast to all online agents)",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        content: z.string(),
      },
    }, async (args) => {
      if (sessionAgent && args.from !== sessionAgent) {
        return {
          content: [{ type: "text", text: `Error: 'from' must match your checked-in identity (${sessionAgent})` }],
          isError: true,
        };
      }
      if (args.to === "*") {
        const agents = store.getOnlineAgents();
        let count = 0;
        for (const a of agents) {
          if (a.agent_name !== args.from) {
            store.createMessage(args.from, a.agent_name, args.content);
            count++;
          }
        }
        return {
          content: [{ type: "text", text: `Broadcast sent to ${count} online agent(s)` }],
        };
      }
      store.createMessage(args.from, args.to, args.content);
      return {
        content: [{ type: "text", text: `Message sent to ${args.to}` }],
      };
    });

    // ── Tool: inbox ──
    mcpServer.registerTool("inbox", {
      description: "Read your unread messages (must checkin first)",
      inputSchema: {
        mark_read: z.boolean().optional().default(true),
      },
    }, async (args) => {
      if (!sessionAgent) {
        return {
          content: [{ type: "text", text: "Error: Call checkin first" }],
          isError: true,
        };
      }
      const messages = store.getUnreadMessages(sessionAgent);
      if (args.mark_read) {
        store.markRead(sessionAgent);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    });

    // ── Tool: subscribe ──
    mcpServer.registerTool("subscribe", {
      description: "Manage your event subscriptions (must checkin first). Events: agent_online, agent_offline. Subscribed events appear as system messages in your inbox.",
      inputSchema: {
        add: z.array(z.enum(["agent_online", "agent_offline"])).optional(),
        remove: z.array(z.enum(["agent_online", "agent_offline"])).optional(),
      },
    }, async (args) => {
      if (!sessionAgent) {
        return {
          content: [{ type: "text", text: "Error: Call checkin first" }],
          isError: true,
        };
      }
      if (args.add?.length) {
        store.subscribe(sessionAgent, args.add);
      }
      if (args.remove?.length) {
        store.unsubscribe(sessionAgent, args.remove);
      }
      const current = store.getSubscriptions(sessionAgent);
      return {
        content: [{ type: "text", text: `Subscriptions for ${sessionAgent}: ${current.length ? current.join(", ") : "none"}` }],
      };
    });

    // ── Tool: listen ──
    mcpServer.registerTool("listen", {
      description: [
        "Get a background polling command that watches your inbox and exits when a message arrives (must checkin first).",
        "Run the returned command as a background process. When it exits, you will be woken up with the message.",
        "IMPORTANT: After processing the message, call `listen` again to resume monitoring.",
      ].join(" "),
      inputSchema: {
        poll_interval: z.number().optional().default(3),
      },
    }, async (args) => {
      if (!sessionAgent) {
        return {
          content: [{ type: "text", text: "Error: Call checkin first" }],
          isError: true,
        };
      }
      const serverUrl = "http://localhost:3456";
      const cmd = [
        `AGENT="${sessionAgent}"`,
        `SERVER="${serverUrl}"`,
        `PIDFILE=~/.agent-hotline/poller-$AGENT.pid`,
        `[ -f ~/.agent-hotline/config ] && . ~/.agent-hotline/config`,
        `hcurl() { if [ -n "$HOTLINE_AUTH_KEY" ]; then curl -H "Authorization: Bearer $HOTLINE_AUTH_KEY" "$@"; else curl "$@"; fi; }`,
        // Kill existing poller if running
        `if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then kill "$(cat "$PIDFILE")" 2>/dev/null; fi`,
        `echo $$ > "$PIDFILE"`,
        `trap 'rm -f "$PIDFILE"' EXIT`,
        `while true; do`,
        `  MSGS=$(hcurl -sf "$SERVER/api/inbox/$AGENT" 2>/dev/null)`,
        `  if [ -n "$MSGS" ] && [ "$MSGS" != "[]" ]; then`,
        `    echo "$MSGS" | jq -r '.[] | "[\\(.from_agent)] \\(.content)"' 2>/dev/null`,
        `    exit 0`,
        `  fi`,
        `  sleep ${args.poll_interval}`,
        `done`,
      ].join("; ");
      return {
        content: [{ type: "text", text: `Run this command in the background to listen for messages:\n\n${cmd}\n\nWhen this exits with a message, process it and call \`listen\` again to resume.` }],
      };
    });

    // ── Tool: checkout ──
    mcpServer.registerTool("checkout", {
      description: "Mark yourself as offline (call before exiting)",
      inputSchema: {},
    }, async () => {
      if (!sessionAgent) {
        return {
          content: [{ type: "text", text: "Error: Call checkin first" }],
          isError: true,
        };
      }
      store.markOffline(sessionAgent);
      notifySubscribers(store, "agent_offline", sessionAgent,
        `${sessionAgent} went offline`);
      return {
        content: [{ type: "text", text: `${sessionAgent} checked out` }],
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

    // ── Resource template: hotline://agent/{name}/diff ──
    mcpServer.registerResource(
      "agent-diff",
      new ResourceTemplate("hotline://agent/{name}/diff", { list: undefined }),
      { description: "Agent's git diff", mimeType: "text/plain" },
      async (_uri, vars) => {
        const name = vars.name as string;
        const agent = store.getAgent(name);
        return {
          contents: [{
            uri: `hotline://agent/${name}/diff`,
            text: agent?.git_diff ?? "",
          }],
        };
      },
    );

    // ── Resource template: hotline://agent/{name}/conversation ──
    mcpServer.registerResource(
      "agent-conversation",
      new ResourceTemplate("hotline://agent/{name}/conversation", { list: undefined }),
      { description: "Agent's recent conversation", mimeType: "text/plain" },
      async (_uri, vars) => {
        const name = vars.name as string;
        const agent = store.getAgent(name);
        return {
          contents: [{
            uri: `hotline://agent/${name}/conversation`,
            text: agent?.conversation_recent ?? "",
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

    // Localhost is trusted for most routes (agents always connect locally)
    // Exception: inbox reads still require auth to prevent agents reading each other's inboxes
    const ip = req.ip ?? req.socket.remoteAddress ?? "";
    const isLocalhost = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    const isInboxRead = req.method === "GET" && req.path.startsWith("/api/inbox/");
    if (isLocalhost && !isInboxRead) {
      return next();
    }

    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryKey = req.query.key as string | undefined;
    const key = bearer || queryKey;

    if (!key || !store.validateApiKey(key)) {
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
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
          },
        });

        const { mcpServer: server, getSessionAgent } = getServer();

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

  // GET /api/inbox/:agentName - returns unread messages and marks them read
  app.get("/api/inbox/:agentName", (req, res) => {
    const { agentName } = req.params;
    const messages = store.getUnreadMessages(agentName);
    store.markRead(agentName);
    res.json(messages);
  });

  // GET /api/agents - returns all agents
  app.get("/api/agents", (_req, res) => {
    const agents = store.getAgents();
    res.json(agents);
  });

  // POST /api/checkin - register/update an agent via REST
  app.post("/api/checkin", (req, res) => {
    const body = req.body;
    if (!body?.agent_name) {
      res.status(400).json({ error: "agent_name is required" });
      return;
    }
    const existing = store.getAgent(body.agent_name);
    const wasOffline = !existing || !existing.online;
    store.upsertAgent({
      agent_name: body.agent_name,
      agent_type: body.agent_type ?? "",
      machine: body.machine ?? "",
      cwd: body.cwd ?? "",
      cwd_remote: body.cwd_remote ?? "",
      branch: body.branch ?? "",
      status: body.status ?? "",
      dirty_files: body.dirty_files ? JSON.stringify(body.dirty_files) : "[]",
      background_processes: body.background_processes ? JSON.stringify(body.background_processes) : "[]",
      git_diff: body.git_diff ?? "",
      conversation_recent: body.conversation_recent ?? "",
      session_id: body.session_id ?? "",
      terminal: body.terminal ?? "",
      pid: body.pid ?? 0,
    });
    if (wasOffline) {
      notifySubscribers(store, "agent_online", body.agent_name,
        `${body.agent_name} is now online (${body.machine ?? "unknown"}, ${body.cwd ?? ""})`);
    }
    res.json({ ok: true, agent_name: body.agent_name });
  });

  // POST /api/checkout - mark agent offline via REST
  app.post("/api/checkout", (req, res) => {
    const { agent_name } = req.body;
    if (!agent_name) {
      res.status(400).json({ error: "agent_name is required" });
      return;
    }
    store.markOffline(agent_name);
    notifySubscribers(store, "agent_offline", agent_name, `${agent_name} went offline`);
    res.json({ ok: true, agent_name });
  });

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
    if (to === "*") {
      const agents = store.getOnlineAgents();
      let count = 0;
      for (const a of agents) {
        if (a.agent_name !== from) {
          store.createMessage(from, a.agent_name, content);
          count++;
        }
      }
      res.json({ ok: true, broadcast: count });
    } else {
      store.createMessage(from, to, content);
      res.json({ ok: true, to });
    }
  });

  return { app, getServer, transports, masterKey };
}
