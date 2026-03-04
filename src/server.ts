import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Store } from "./store.js";

const INSTRUCTIONS = `Agent Hotline - Cross-machine agent communication.
At the START of each session:
1. Call \`checkin\` with your current status, cwd, branch, files, and background processes (pid, port, command, description).
2. Call \`who\` to see other online agents and their background processes (to avoid port conflicts).
3. Read your inbox for unread messages.
When your status changes significantly, call \`checkin\` again.
Before starting a process on a port, check \`who\` to see if another agent already uses that port.`;

export function createServer(store: Store) {
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const getServer = () => {
    const mcpServer = new McpServer(
      { name: "hotline", version: "0.1.0" },
      { instructions: INSTRUCTIONS },
    );

    // ── Tool: checkin ──
    mcpServer.registerTool("checkin", {
      description: "Push your context to the server",
      inputSchema: {
        agent_name: z.string(),
        agent_type: z.enum(["claude-code", "opencode", "codex"]),
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
      },
    }, async (args) => {
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
      });
      return {
        content: [{ type: "text", text: `Checked in as ${args.agent_name}` }],
      };
    });

    // ── Tool: who ──
    mcpServer.registerTool("who", {
      description: "See online agents. Optionally filter by `room` (substring matched against agents' cwd).",
      inputSchema: {
        room: z.string().optional(),
      },
    }, async (args) => {
      const agents = store.getAgents(args.room);
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
        last_seen: a.last_seen,
        online: a.online,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
      };
    });

    // ── Tool: message ──
    mcpServer.registerTool("message", {
      description: "Send a message to another agent (or '*' to broadcast)",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        content: z.string(),
      },
    }, async (args) => {
      if (args.to === "*") {
        const agents = store.getAgents();
        let count = 0;
        for (const a of agents) {
          if (a.agent_name !== args.from) {
            store.createMessage(args.from, a.agent_name, args.content);
            count++;
          }
        }
        return {
          content: [{ type: "text", text: `Broadcast sent to ${count} agent(s)` }],
        };
      }
      store.createMessage(args.from, args.to, args.content);
      return {
        content: [{ type: "text", text: `Message sent to ${args.to}` }],
      };
    });

    // ── Tool: inbox ──
    mcpServer.registerTool("inbox", {
      description: "Read your unread messages",
      inputSchema: {
        agent_name: z.string(),
        mark_read: z.boolean().optional().default(true),
      },
    }, async (args) => {
      const messages = store.getUnreadMessages(args.agent_name);
      if (args.mark_read) {
        store.markRead(args.agent_name);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
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

    return mcpServer;
  };

  // ── Express app ──
  const app = express();
  app.use(express.json());

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

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        const server = getServer();
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
    });
    res.json({ ok: true, agent_name: body.agent_name });
  });

  // POST /api/message - send a message via REST
  app.post("/api/message", (req, res) => {
    const { from, to, content } = req.body;
    if (!from || !to || !content) {
      res.status(400).json({ error: "from, to, and content are required" });
      return;
    }
    if (to === "*") {
      const agents = store.getAgents();
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

  return { app, getServer, transports };
}
