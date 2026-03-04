import express from "express";

const PID_CHECK_INTERVAL_MS = 10_000; // 10s
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s

/** Check if a process is still running on the local machine. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createClientServer(opts: { hubUrl: string; authKey: string; port: number }) {
  const { hubUrl, authKey, port } = opts;
  const app = express();
  const pidMap = new Map<string, number>(); // agent_name -> pid

  // Parse JSON bodies for intercepting checkin/checkout
  app.use(express.json({ limit: "10mb" }));

  // Rebuild raw body for proxying (needed for non-JSON or to forward exact bytes)
  app.use((req, _res, next) => {
    // Body already parsed by express.json; store it for re-serialization
    next();
  });

  const hubHeaders = (extra?: Record<string, string | undefined>): Record<string, string> => {
    const h: Record<string, string> = { Authorization: `Bearer ${authKey}` };
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined) h[k] = v;
      }
    }
    return h;
  };

  // ── Health ──
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: "client",
      hub: hubUrl,
      tracked_pids: Object.fromEntries(pidMap),
    });
  });

  // ── Intercept checkin to track PIDs ──
  app.post("/api/checkin", async (req, res) => {
    const body = req.body;
    if (body?.agent_name && body?.pid) {
      pidMap.set(body.agent_name, body.pid);
    }
    try {
      const upstream = await fetch(`${hubUrl}/api/checkin`, {
        method: "POST",
        headers: hubHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(502).json({ error: "Hub unreachable", detail: String(e) });
    }
  });

  // ── Intercept checkout to untrack PIDs ──
  app.post("/api/checkout", async (req, res) => {
    const body = req.body;
    if (body?.agent_name) {
      pidMap.delete(body.agent_name);
    }
    try {
      const upstream = await fetch(`${hubUrl}/api/checkout`, {
        method: "POST",
        headers: hubHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (e) {
      res.status(502).json({ error: "Hub unreachable", detail: String(e) });
    }
  });

  // ── MCP proxy (POST, GET, DELETE) ──
  const proxyMcp = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${authKey}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"] as string;
    if (req.headers["accept"]) headers["accept"] = req.headers["accept"] as string;

    try {
      const upstream = await fetch(`${hubUrl}/mcp`, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
        // @ts-ignore -- duplex needed for streaming in Node fetch
        duplex: req.method !== "GET" && req.method !== "HEAD" ? "half" : undefined,
      });

      // Copy status and relevant headers
      res.status(upstream.status);
      const sessionHeader = upstream.headers.get("mcp-session-id");
      if (sessionHeader) res.setHeader("mcp-session-id", sessionHeader);
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);

      // Check if this is a streaming (SSE) response
      if (contentType?.includes("text/event-stream")) {
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        // Pipe the stream
        if (upstream.body) {
          const reader = upstream.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); return; }
              res.write(value);
            }
          };
          pump().catch(() => res.end());
        } else {
          res.end();
        }
      } else {
        const data = await upstream.text();
        res.send(data);
      }
    } catch (e) {
      if (!res.headersSent) {
        res.status(502).json({ error: "Hub unreachable", detail: String(e) });
      }
    }
  };

  app.post("/mcp", proxyMcp);
  app.get("/mcp", proxyMcp);
  app.delete("/mcp", proxyMcp);

  // ── Generic API proxy (all other /api/* routes) ──
  app.all("/api/{*splat}", async (req, res) => {
    const path = req.originalUrl; // preserves query string
    const headers: Record<string, string> = { Authorization: `Bearer ${authKey}` };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"] as string;

    try {
      const fetchOpts: RequestInit = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        fetchOpts.body = JSON.stringify(req.body);
      }
      const upstream = await fetch(`${hubUrl}${path}`, fetchOpts);
      const contentType = upstream.headers.get("content-type");
      res.status(upstream.status);
      if (contentType) res.setHeader("content-type", contentType);
      const data = await upstream.text();
      res.send(data);
    } catch (e) {
      res.status(502).json({ error: "Hub unreachable", detail: String(e) });
    }
  });

  // ── PID monitor: check every 10s ──
  const pidCheckTimer = setInterval(async () => {
    for (const [agentName, pid] of pidMap) {
      if (!isProcessAlive(pid)) {
        pidMap.delete(agentName);
        // Notify hub that agent is offline
        try {
          await fetch(`${hubUrl}/api/checkout`, {
            method: "POST",
            headers: hubHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ agent_name: agentName }),
          });
        } catch {
          // Hub unreachable, will retry or hub's own presence will catch it
        }
      }
    }
  }, PID_CHECK_INTERVAL_MS);

  // ── Heartbeat: touch last_seen on hub every 30s ──
  const heartbeatTimer = setInterval(async () => {
    if (pidMap.size === 0) return;
    const agents = Array.from(pidMap.entries()).map(([name, pid]) => ({ name, pid }));
    try {
      await fetch(`${hubUrl}/api/heartbeat`, {
        method: "POST",
        headers: hubHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ agents }),
      });
    } catch {
      // Hub unreachable, skip this heartbeat
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    app,
    stop() {
      clearInterval(pidCheckTimer);
      clearInterval(heartbeatTimer);
    },
  };
}
