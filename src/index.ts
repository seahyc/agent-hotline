#!/usr/bin/env node

// Server-side deps (express, better-sqlite3) are imported lazily inside the
// serve action — every other command must start fast.
import { Command } from "commander";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { exec, spawn } from "node:child_process";
import { resolveMyIdentity } from "./cli-identity.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { Message } from "./store.js";

// ── ANSI colors (only when stdout is a terminal — agents get clean output) ──
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const RESET = useColor ? "\x1b[0m" : "";
const BOLD = useColor ? "\x1b[1m" : "";
const DIM = useColor ? "\x1b[2m" : "";
const CYAN = useColor ? "\x1b[36m" : "";
const GREEN = useColor ? "\x1b[32m" : "";
const YELLOW = useColor ? "\x1b[33m" : "";
const MAGENTA = useColor ? "\x1b[35m" : "";
const RED = useColor ? "\x1b[31m" : "";

/** Error with a message meant directly for the user. */
class CliError extends Error {}

/** Print a real, actionable error and exit nonzero. */
function fail(message: string, opts?: { json?: boolean }): never {
  if (opts?.json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`${RED}Error:${RESET} ${message}`);
  }
  process.exit(1);
}

function emit(json: boolean | undefined, data: unknown, human: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    human();
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function printMessage(msg: Message): void {
  const time = formatTimestamp(msg.timestamp);
  console.log(
    `${DIM}${time}${RESET} ${CYAN}${BOLD}${msg.from_agent}${RESET} ${YELLOW}->${RESET} ${GREEN}${msg.to_agent}${RESET}`,
  );
  console.log(`  ${msg.content}`);
  console.log();
}

function sendDesktopNotification(msg: Message): void {
  if (process.platform !== "darwin") return;
  const escaped = msg.content
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
  const title = `From ${msg.from_agent}`;
  exec(
    `osascript -e 'display notification "${escaped}" with title "Agent Hotline" subtitle "${title}"'`,
  );
}

function configDir(): string {
  return join(homedir(), ".agent-hotline");
}

function readConfig(): Record<string, string> {
  const configPath = join(configDir(), "config");
  const result: Record<string, string> = {};
  if (!existsSync(configPath)) return result;
  const lines = readFileSync(configPath, "utf-8").split("\n");
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return result;
}

function getAuthKey(opts: { authKey?: string }): string | undefined {
  return opts.authKey || process.env.HOTLINE_AUTH_KEY || readConfig().HOTLINE_AUTH_KEY || undefined;
}

function getServerUrl(opts: { server?: string }): string {
  return opts.server || process.env.HOTLINE_SERVER || readConfig().HOTLINE_SERVER || "http://localhost:3456";
}

function authHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

/** fetch + JSON with timeouts and errors that say what actually went wrong. */
async function fetchJson(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const { timeoutMs = 5000, ...rest } = init ?? {};
  let res: globalThis.Response;
  try {
    res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    const origin = new URL(url).origin;
    const code = e?.cause?.code ?? e?.code ?? "";
    let detail: string;
    if (code === "ECONNREFUSED") {
      detail = "connection refused — is the server running? Start it with: agent-hotline serve";
    } else if (e?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
      detail = `request timed out after ${timeoutMs}ms`;
    } else {
      detail = e?.cause?.message || e?.message || String(e);
    }
    throw new CliError(`cannot reach hotline server at ${origin}: ${detail}`);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw new CliError(`server returned ${res.status}${body?.error ? `: ${body.error}` : ""} (${new URL(url).pathname})`);
  }
  return body;
}

function defaultDbPath(): string {
  const dir = join(homedir(), ".agent-hotline");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "hotline.db");
}

/**
 * Resolve agent identity: explicit --agent > server-side PID resolution
 * (DB-backed, exact — works with multiple agents in the same directory) >
 * local filesystem heuristic as a last resort.
 */
async function resolveIdentity(opts: { agent?: string; server?: string; authKey?: string }): Promise<string | null> {
  if (opts.agent) return opts.agent;
  try {
    const body = await fetchJson(`${getServerUrl(opts)}/api/resolve`, {
      method: "POST",
      headers: authHeaders(getAuthKey(opts)),
      body: JSON.stringify({ pid: process.ppid }),
      timeoutMs: 3000,
    });
    if (body?.session_id) return body.session_id;
  } catch { /* server down or unresolved — fall back */ }
  return resolveMyIdentity();
}

async function requireIdentity(opts: { agent?: string; server?: string; authKey?: string; json?: boolean }): Promise<string> {
  const id = await resolveIdentity(opts);
  if (!id) {
    fail("could not resolve your identity. Is the hotline hook installed (agent-hotline setup claude-code) and the server running? You can pass --agent <name|id> explicitly.", opts);
  }
  return id;
}

const program = new Command();

program
  .name("agent-hotline")
  .description("Cross-machine agent communication - MSN Messenger for coding agents")
  .version(pkg.version);

// ── serve ──
program
  .command("serve")
  .description("Start the server (REST API + mesh peer node)")
  .option("--port <port>", "Port to listen on", "3456")
  .option("--auth-key <key>", "Authentication key")
  .option("--bootstrap <urls>", "Comma-separated bootstrap peer URLs (e.g. https://hotline.example.com)")
  .option("--cluster-key <key>", "Cluster key for mesh authentication (also reads HOTLINE_CLUSTER_KEY env)")
  .option("--db <path>", "Database file path")
  .option("--retention-days <days>", "Auto-delete messages older than N days (0 = keep forever)", "30")
  .action(async (opts) => {
    const { initLog, log } = await import("./log.js");
    const { createStore } = await import("./store.js");
    const { createServer, scanForAgents } = await import("./server.js");
    const { startPresenceLoop } = await import("./presence.js");
    initLog();

    const port = parseInt(opts.port, 10);
    const dbPath = opts.db ?? defaultDbPath();
    const retentionDays = parseInt(opts.retentionDays, 10);
    const clusterKey = opts.clusterKey || process.env.HOTLINE_CLUSTER_KEY || readConfig().HOTLINE_CLUSTER_KEY || undefined;
    const bootstrapRaw = opts.bootstrap || process.env.HOTLINE_BOOTSTRAP || readConfig().HOTLINE_BOOTSTRAP || "";
    const bootstrapUrls = bootstrapRaw
      ? (bootstrapRaw as string).split(",").map((u: string) => u.trim().replace(/\/+$/, "")).filter(Boolean)
      : [];

    const store = createStore(dbPath);
    const authKey = opts.authKey ?? readConfig().HOTLINE_AUTH_KEY ?? undefined;
    const { app, masterKey } = createServer(store, { authKey, port, clusterKey, bootstrapUrls });
    const presence = startPresenceLoop(store, undefined, retentionDays > 0 ? retentionDays : undefined);

    // Start gossip + relay long-poll loops if cluster key is configured
    let gossipHandle: { stop: () => void } | null = null;
    let mdnsHandle: { stop: () => void } | null = null;
    let relayPollHandle: { stop: () => void } | null = null;
    if (clusterKey) {
      const { startGossipLoop, startMdns, startRelayPoll } = await import("./peers.js");
      const selfAddr = `http://localhost:${port}`;
      gossipHandle = startGossipLoop(store, { clusterKey, bootstrapUrls, selfAddr });
      mdnsHandle = startMdns(store, { clusterKey, port });
      if (bootstrapUrls.length > 0) {
        relayPollHandle = startRelayPoll(store, { clusterKey, bootstrapUrls });
      }
      log("info", `mesh enabled: cluster key set, ${bootstrapUrls.length} bootstrap peers`);
    }

    // Save auth key to local config so hook.sh picks it up
    const cfgDir = configDir();
    if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "config");
    const existingConfig = existsSync(cfgPath) ? readFileSync(cfgPath, "utf-8") : "";
    const configLines = existingConfig.split("\n").filter((l) =>
      !l.startsWith("HOTLINE_AUTH_KEY=") &&
      !l.startsWith("HOTLINE_SERVER=") &&
      !l.startsWith("HOTLINE_CLUSTER_KEY=") &&
      !l.startsWith("HOTLINE_BOOTSTRAP=")
    );
    configLines.unshift(`HOTLINE_SERVER=http://localhost:${port}`);
    configLines.unshift(`HOTLINE_AUTH_KEY=${masterKey}`);
    if (clusterKey) configLines.unshift(`HOTLINE_CLUSTER_KEY=${clusterKey}`);
    if (bootstrapUrls.length > 0) configLines.unshift(`HOTLINE_BOOTSTRAP=${bootstrapUrls.join(",")}`);
    writeFileSync(cfgPath, configLines.filter(Boolean).join("\n") + "\n", "utf-8");

    const server = app.listen(port, () => {
      log("info", `server started on port ${port}, db=${dbPath}`);
      console.log();
      console.log(`${BOLD}${MAGENTA}  Agent Hotline${RESET} ${DIM}v${pkg.version}${RESET}`);
      console.log(`${DIM}  ────────────────────────────${RESET}`);
      console.log(`  ${GREEN}Web UI${RESET}        http://localhost:${port}/`);
      console.log(`  ${GREEN}REST API${RESET}      http://localhost:${port}/api/`);
      console.log(`  ${GREEN}Health${RESET}        http://localhost:${port}/health`);
      console.log(`  ${DIM}Database${RESET}      ${dbPath}`);
      console.log(`  ${DIM}Logs${RESET}          ~/.agent-hotline/server.log`);
      console.log(`  ${DIM}Retention${RESET}     ${retentionDays > 0 ? `${retentionDays} days` : "forever"}`);
      console.log(`  ${GREEN}Auth key${RESET}     ${masterKey}${opts.authKey ? "" : " (auto-generated)"}`);
      if (clusterKey) {
        console.log(`  ${GREEN}Mesh${RESET}         enabled (${bootstrapUrls.length} bootstrap peers)`);
      }
      console.log();
      console.log(`  ${CYAN}Wire into your coding tool:${RESET}`);
      console.log(`  agent-hotline setup claude-code`);
      console.log();
      console.log(`  ${DIM}Press Ctrl+C to stop${RESET}`);
      console.log();

      // Start agent scanner: auto-discover running Claude Code / Codex agents
      scanForAgents(store);
      setInterval(() => scanForAgents(store), 30_000);
    });

    // A failed bind (EADDRINUSE: another serve instance owns the port) must
    // exit rather than linger as a portless zombie — under launchd KeepAlive
    // the respawn retries the bind until the squatter goes away.
    server.on("error", (e) => {
      log("error", `listen failed on port ${port}: ${e}`);
      console.error(`${RED}Could not listen on port ${port}: ${e instanceof Error ? e.message : e}${RESET}`);
      process.exit(1);
    });

    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n${DIM}Shutting down...${RESET}`);
      // Best-effort cleanup, but the process MUST exit: a throw here would
      // leave a zombie serve process with its listener already closed.
      try {
        if (gossipHandle) gossipHandle.stop();
        if (mdnsHandle) mdnsHandle.stop();
        if (relayPollHandle) relayPollHandle.stop();
        presence.stop();
        server.close();
        store.close();
      } catch (e) {
        log("error", `shutdown cleanup failed: ${e}`);
      } finally {
        process.exit(0);
      }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ── service ── run the server supervised (launchd on macOS)
program
  .command("service")
  .description("Manage the server as a supervised background service (auto-restart, survives reboot)")
  .argument("<action>", "install | uninstall | status")
  .option("--port <port>", "Port to listen on", "3456")
  .action(async (action, opts) => {
    const { execSync } = await import("node:child_process");
    const label = "com.agent-hotline.serve";
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

    if (process.platform !== "darwin") {
      console.log("Supervision is currently automated on macOS only. On Linux, create a systemd user unit:");
      console.log();
      console.log(`  [Unit]\n  Description=Agent Hotline\n  [Service]\n  ExecStart=${process.execPath} ${join(__dirname, "index.js")} serve\n  Restart=always\n  [Install]\n  WantedBy=default.target`);
      console.log();
      console.log("Save to ~/.config/systemd/user/agent-hotline.service, then: systemctl --user enable --now agent-hotline");
      return;
    }

    const launchctl = (cmd: string) => {
      try {
        return execSync(cmd, { encoding: "utf-8" }).trim();
      } catch (e: any) {
        return e?.stdout?.toString().trim() ?? "";
      }
    };

    if (action === "install") {
      // serve reads cluster key / bootstrap / auth key from ~/.agent-hotline/config,
      // so the plist stays minimal and re-config doesn't require reinstalling.
      const logDir = configDir();
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(__dirname, "index.js")}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${parseInt(opts.port, 10)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "serve.stdout.log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "serve.stderr.log")}</string>
</dict>
</plist>
`;
      const laDir = join(homedir(), "Library", "LaunchAgents");
      if (!existsSync(laDir)) mkdirSync(laDir, { recursive: true });
      launchctl(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`);
      writeFileSync(plistPath, plist, "utf-8");
      launchctl(`launchctl bootstrap gui/$(id -u) ${plistPath}`);
      console.log(`${GREEN}Installed and started${RESET} ${label}`);
      console.log(`${DIM}Plist: ${plistPath}${RESET}`);
      console.log(`${DIM}It restarts on crash and starts at login. Settings come from ~/.agent-hotline/config.${RESET}`);
    } else if (action === "uninstall") {
      launchctl(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`);
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(plistPath);
      } catch { /* not installed */ }
      console.log(`${GREEN}Uninstalled${RESET} ${label}`);
    } else if (action === "status") {
      const out = launchctl(`launchctl list | grep ${label} || true`);
      if (out) {
        console.log(`${GREEN}Running:${RESET} ${out}`);
      } else {
        console.log(`${DIM}Not loaded. Install with: agent-hotline service install${RESET}`);
      }
    } else {
      fail(`unknown action: ${action}. Use install, uninstall, or status.`);
    }
  });

// ── status ──
program
  .command("status")
  .description("One-shot diagnostic: server, your identity, inbox, who's online")
  .option("--agent <id>", "Agent name or session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    const serverUrl = getServerUrl(opts);
    const sessionId = await resolveIdentity(opts);
    const params = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
    try {
      const body = await fetchJson(`${serverUrl}/api/status${params}`, { headers: authHeaders(getAuthKey(opts)) });
      const data = { ...body, identity_resolved: !!sessionId };
      emit(opts.json, data, () => {
        const s = body.server ?? {};
        console.log();
        console.log(`${BOLD}${MAGENTA}Agent Hotline${RESET}  ${DIM}v${s.version} on ${serverUrl} · mesh ${s.mesh ? `on (${s.peers} peers)` : "off"}${RESET}`);
        if (body.agent) {
          const a = body.agent;
          const rooms = a.rooms?.length ? ` · rooms: ${a.rooms.map((r: string) => `#${r}`).join(", ")}` : "";
          console.log(`${GREEN}You${RESET}: ${CYAN}${BOLD}${a.name ?? a.session_id}${RESET} ${DIM}(${a.session_id.slice(0, 8)})${RESET} · ${a.unread} unread${rooms}`);
        } else if (sessionId) {
          console.log(`${YELLOW}You${RESET}: ${sessionId} ${DIM}(not yet registered on this server)${RESET}`);
        } else {
          console.log(`${YELLOW}Identity unresolved${RESET} — no hook heartbeat yet? Use --agent <id>.`);
        }
        const agents = body.agents_online ?? [];
        console.log(`${BOLD}Online${RESET} ${DIM}(${agents.length})${RESET}`);
        for (const a of agents) {
          const loc = [a.machine, a.branch, a.cwd?.split("/").pop()].filter(Boolean).join(" · ");
          console.log(`  ${GREEN}●${RESET} ${CYAN}${a.name ?? a.id.slice(0, 8)}${RESET}  ${DIM}${loc}${RESET}`);
        }
        console.log();
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── who ──
program
  .command("who")
  .description("See online agents")
  .option("--all", "Include offline agents")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);
    const url = `${serverUrl}/api/agents${opts.all ? "" : "?online=true"}`;

    try {
      const agents = await fetchJson(url, { headers: authHeaders(key) }) as Array<{
        session_id: string; name?: string; title?: string; online: number; machine?: string;
        cwd?: string; branch?: string; agent_type?: string; pid?: number; last_seen?: number;
      }>;

      emit(opts.json, agents, () => {
        if (agents.length === 0) {
          console.log(`${DIM}No agents ${opts.all ? "" : "online"}${RESET}`);
          return;
        }
        console.log();
        console.log(`${BOLD}${MAGENTA}Agents${RESET}  ${DIM}(${agents.length})${RESET}`);
        console.log();
        for (const a of agents) {
          const status = a.online ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
          const name = a.name ? `${CYAN}${BOLD}${a.name}${RESET} ${DIM}(${a.session_id.slice(0, 8)})${RESET}` : `${DIM}${a.session_id.slice(0, 16)}${RESET}`;
          const loc = [a.machine, a.branch ? `${a.branch}` : "", a.cwd?.split("/").pop()].filter(Boolean).join(" · ");
          console.log(`  ${status} ${name}  ${DIM}${loc}${RESET}`);
        }
        console.log();
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── watch ──
program
  .command("watch")
  .description("Terminal inbox watcher (for humans; agents should use 'wait')")
  .option("--agent <name>", "Agent name or session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .action(async (opts) => {
    const agent = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);
    const url = `${serverUrl}/api/inbox/${encodeURIComponent(agent)}`;

    console.log(
      `${BOLD}${MAGENTA}Agent Hotline${RESET} ${DIM}watching inbox for${RESET} ${CYAN}${agent}${RESET}`,
    );
    console.log(`${DIM}Server: ${serverUrl}${RESET}`);
    console.log(`${DIM}Polling every 5s... Press Ctrl+C to stop${RESET}`);
    console.log();

    const poll = async () => {
      try {
        const messages = await fetchJson(url, { headers: authHeaders(key) }) as Message[];
        for (const msg of messages) {
          printMessage(msg);
          sendDesktopNotification(msg);
        }
      } catch {
        // Server not reachable, silently retry
      }
    };

    await poll();
    const timer = setInterval(poll, 5000);

    const shutdown = () => {
      clearInterval(timer);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ── check ──
program
  .command("check")
  .description("One-shot inbox check (marks messages read)")
  .option("--agent <name>", "Agent name or session ID (auto-resolved if omitted)")
  .option("--format <format>", "Output format: inline or human", "human")
  .option("--quiet", "Output nothing if no messages")
  .option("--json", "Machine-readable output")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .action(async (opts) => {
    const agent = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);
    const url = `${serverUrl}/api/inbox/${encodeURIComponent(agent)}`;

    try {
      const messages = await fetchJson(url, { headers: authHeaders(key) }) as Message[];

      if (opts.json) {
        console.log(JSON.stringify(messages, null, 2));
        return;
      }
      if (messages.length === 0) {
        if (!opts.quiet) console.log("No unread messages.");
        return;
      }
      if (opts.format === "inline") {
        const lines = messages.map(
          (m) => `[${formatTimestamp(m.timestamp)}] ${m.from_agent}: ${m.content}`,
        );
        console.log(lines.join("\n"));
      } else {
        for (const msg of messages) {
          printMessage(msg);
        }
      }
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── send ──
program
  .command("send")
  .description("Send a message to an agent, room (#name), or everyone (*)")
  .argument("<to>", "Recipient: agent name/ID, #room, or * for broadcast")
  .argument("[message]", "Message content ('-' or omitted with --file/stdin)")
  .option("--file <path>", "Read message content from a file")
  .option("--agent <name>", "Your agent name or session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (to, message, opts) => {
    let content: string | undefined = message;
    if (opts.file) {
      if (content && content !== "-") fail("pass either a message argument or --file, not both", opts);
      try {
        content = readFileSync(opts.file, "utf-8");
      } catch (e: any) {
        fail(`could not read --file ${opts.file}: ${e?.message ?? e}`, opts);
      }
    } else if (content === "-" || (content === undefined && !process.stdin.isTTY)) {
      try {
        content = readFileSync(0, "utf-8");
      } catch {
        content = undefined;
      }
    }
    if (!content || !content.trim()) {
      fail("no message content. Pass it as an argument, via --file <path>, or pipe it on stdin.", opts);
    }

    const from = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    try {
      const result = await fetchJson(`${serverUrl}/api/message`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ from, to, content }),
      }) as Record<string, unknown>;

      emit(opts.json, result, () => {
        if (result.broadcast !== undefined) {
          console.log(`${GREEN}Broadcast sent to ${result.broadcast} agent(s)${RESET}`);
        } else if (result.room) {
          console.log(`${GREEN}Message sent to #${result.room} (${result.notified} notified)${RESET}`);
        } else if (result.method === "queued") {
          console.log(`${YELLOW}Message queued for ${result.to} (no reachable peer right now; will retry)${RESET}`);
        } else {
          console.log(`${GREEN}Message sent to ${result.to}${RESET}`);
        }
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── wait ──
program
  .command("wait")
  .description("Block until a message arrives, print it, and exit (run as a background task to get woken up)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--rooms <rooms>", "Comma-separated room names to also wait on")
  .option("--timeout <seconds>", "Exit code 2 if nothing arrives in time (0 = wait forever)", "0")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    const sessionId = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);
    const timeoutSec = parseInt(opts.timeout, 10) || 0;

    const drainInbox = async (): Promise<Message[]> => {
      return await fetchJson(`${serverUrl}/api/inbox/${encodeURIComponent(sessionId)}`, {
        headers: authHeaders(key),
      }) as Message[];
    };

    const printAll = (messages: Message[]) => {
      emit(opts.json, messages, () => {
        for (const m of messages) printMessage(m);
      });
    };

    try {
      // Anything already waiting? Deliver immediately.
      const pending = await drainInbox();
      if (pending.length > 0) {
        printAll(pending);
        process.exit(0);
      }

      const { token } = await fetchJson(`${serverUrl}/api/inbox-token`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ session_id: sessionId }),
      }) as { token: string };

      const params = new URLSearchParams({ token });
      if (opts.rooms) params.set("rooms", opts.rooms);
      const sseUrl = `${serverUrl}/api/sse/${encodeURIComponent(sessionId)}?${params.toString()}`;

      const signal = timeoutSec > 0 ? AbortSignal.timeout(timeoutSec * 1000) : undefined;
      let res: globalThis.Response;
      try {
        res = await fetch(sseUrl, { signal });
      } catch (e: any) {
        throw new CliError(`cannot open message stream: ${e?.cause?.message || e?.message || e}`);
      }
      if (!res.ok || !res.body) {
        throw new CliError(`message stream returned ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new CliError("message stream closed by server — is it restarting?");
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const event of events) {
            const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue; // heartbeat comment
            let received: Message;
            try {
              received = JSON.parse(dataLine.slice(6));
            } catch {
              continue;
            }
            // Drain the inbox so delivered messages are marked read (and any
            // that raced in alongside this one are included).
            const drained = await drainInbox().catch(() => [] as Message[]);
            printAll(drained.length > 0 ? drained : [received]);
            process.exit(0);
          }
        }
      } catch (e: any) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError") {
          if (opts.json) {
            console.log(JSON.stringify({ timeout: true, seconds: timeoutSec }));
          } else {
            console.log(`No message within ${timeoutSec}s.`);
          }
          process.exit(2);
        }
        throw e;
      }
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── rename ──
program
  .command("rename")
  .description("Set a friendly name for yourself")
  .argument("<name>", "Friendly name (letters, digits, hyphens, underscores, max 32 chars)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (name, opts) => {
    const sessionId = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    try {
      const body = await fetchJson(`${serverUrl}/api/rename`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ session_id: sessionId, name }),
      });
      emit(opts.json, body, () => {
        console.log(`${GREEN}Renamed to "${body.name}"${RESET}`);
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── rooms ──
program
  .command("rooms")
  .description("List rooms")
  .option("--all", "Show all rooms (not just joined)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    const sessionId = await resolveIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    const params = new URLSearchParams();
    if (sessionId) params.set("session_id", sessionId);
    if (opts.all) params.set("all", "true");

    try {
      const rooms = await fetchJson(`${serverUrl}/api/rooms?${params}`, { headers: authHeaders(key) }) as Array<{
        name: string; memberCount: number; joined?: boolean; notify?: string;
      }>;

      emit(opts.json, rooms, () => {
        if (rooms.length === 0) {
          console.log(`${DIM}No rooms${RESET}`);
          return;
        }
        console.log();
        console.log(`${BOLD}${MAGENTA}Rooms${RESET}  ${DIM}(${rooms.length})${RESET}`);
        console.log();
        for (const r of rooms) {
          const joined = r.joined ? `${GREEN}✓${RESET} ` : "  ";
          const notify = r.notify && r.notify !== "all" ? ` ${DIM}[${r.notify}]${RESET}` : "";
          console.log(`  ${joined}${CYAN}#${r.name}${RESET}  ${DIM}${r.memberCount} member(s)${RESET}${notify}`);
        }
        console.log();
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── join ──
program
  .command("join")
  .description("Join a room")
  .argument("<room>", "Room name (e.g. general or #general)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (room, opts) => {
    const sessionId = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    try {
      const body = await fetchJson(`${serverUrl}/api/rooms/join`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ session_id: sessionId, room }),
      });
      emit(opts.json, body, () => {
        console.log(`${GREEN}Joined #${body.room} (${body.memberCount} member(s))${RESET}`);
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── leave ──
program
  .command("leave")
  .description("Leave a room")
  .argument("<room>", "Room name (e.g. general or #general)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (room, opts) => {
    const sessionId = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    try {
      const body = await fetchJson(`${serverUrl}/api/rooms/leave`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ session_id: sessionId, room }),
      });
      emit(opts.json, body, () => {
        console.log(`${GREEN}Left #${body.room}${RESET}`);
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── read ──
program
  .command("read")
  .description("Browse room or DM history")
  .option("--room <name>", "Room name (e.g. general or #general)")
  .option("--dm <agent>", "Agent name or ID for DM history")
  .option("--limit <n>", "Max messages", "50")
  .option("--before <timestamp>", "Fetch messages before this ISO timestamp")
  .option("--agent <id>", "Your agent session ID (auto-resolved if omitted, required for --dm)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (opts) => {
    if (!opts.room && !opts.dm) {
      fail("specify --room <name> or --dm <agent>", opts);
    }
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    const params = new URLSearchParams();
    if (opts.room) params.set("room", opts.room);
    if (opts.dm) {
      const sessionId = await requireIdentity(opts);
      params.set("dm", opts.dm);
      params.set("session_id", sessionId);
    }
    params.set("limit", opts.limit);
    if (opts.before) params.set("before", opts.before);

    try {
      const msgs = await fetchJson(`${serverUrl}/api/messages?${params}`, { headers: authHeaders(key) }) as Array<{
        id: number; from: string; from_name?: string; content: string; time: string;
      }>;

      emit(opts.json, msgs, () => {
        if (msgs.length === 0) {
          console.log(`${DIM}No messages${RESET}`);
          return;
        }
        console.log();
        for (const m of msgs) {
          const name = m.from_name ? `${CYAN}${BOLD}${m.from_name}${RESET}` : `${DIM}${m.from.slice(0, 12)}${RESET}`;
          const time = new Date(m.time).toLocaleTimeString();
          console.log(`${DIM}${time}${RESET} ${name}`);
          console.log(`  ${m.content}`);
          console.log();
        }
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── notify ──
program
  .command("notify")
  .description("Set notification preferences for a room or globally")
  .argument("<level>", "Notification level: all, mentions, mute")
  .option("--room <name>", "Room name (omit for global default)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .option("--json", "Machine-readable output")
  .action(async (level, opts) => {
    if (!["all", "mentions", "mute"].includes(level)) {
      fail("invalid level. Use: all, mentions, mute", opts);
    }
    const sessionId = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    try {
      const body = await fetchJson(`${serverUrl}/api/notify`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ session_id: sessionId, room: opts.room, level }),
      });
      emit(opts.json, body, () => {
        const label = body.room ? `#${body.room}` : "Global";
        console.log(`${GREEN}${label} notifications: ${body.level}${RESET}`);
      });
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── listen ──
program
  .command("listen")
  .description("Print a raw SSE curl command (most agents should use 'wait' instead)")
  .option("--agent <id>", "Agent session ID (auto-resolved if omitted)")
  .option("--rooms <rooms>", "Comma-separated room names to subscribe to")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key")
  .action(async (opts) => {
    const sessionId = await requireIdentity(opts);
    const serverUrl = getServerUrl(opts);
    const key = getAuthKey(opts);

    try {
      const { token } = await fetchJson(`${serverUrl}/api/inbox-token`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ session_id: sessionId }),
      }) as { token: string };
      const params = new URLSearchParams({ token });
      if (opts.rooms) {
        params.set("rooms", opts.rooms);
      }
      const sseUrl = `${serverUrl}/api/sse/${sessionId}?${params.toString()}`;

      console.log();
      console.log(`${DIM}Tip: 'agent-hotline wait' blocks until one message arrives and then exits —`);
      console.log(`run it as a background task to get woken up. This raw stream never exits:${RESET}`);
      console.log();
      console.log(`curl -N -sf "${sseUrl}"`);
      console.log();
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e), opts);
    }
  });

// ── setup ──
program
  .command("setup")
  .description("Configure tool integration")
  .argument("<tool>", "Tool to configure: claude-code, opencode, codex")
  .option("--agent <name>", "Agent name")
  .option("--server <url>", "Server URL", "http://localhost:3456")
  .action(async (tool, opts) => {
    const supported = ["claude-code", "opencode", "codex"];
    if (!supported.includes(tool)) {
      fail(`unknown tool: ${tool}. Supported: ${supported.join(", ")}`);
    }

    const agent = opts.agent ?? "my-agent";
    const serverUrl = opts.server;

    console.log(`${BOLD}${MAGENTA}Agent Hotline Setup${RESET}`);
    console.log();
    console.log(`Tool:   ${CYAN}${tool}${RESET}`);
    console.log(`Server: ${serverUrl}`);
    console.log();

    if (tool === "claude-code") {
      const { setupClaudeCode } = await import("./setup/claude-code.js");
      setupClaudeCode(agent, serverUrl);
    } else if (tool === "opencode") {
      const { setupOpenCode } = await import("./setup/opencode.js");
      setupOpenCode(agent, serverUrl);
    } else if (tool === "codex") {
      const { setupCodex } = await import("./setup/codex.js");
      setupCodex(agent, serverUrl);
    }
  });

// ── invite ──
program
  .command("invite")
  .description("Generate an invite code for a friend to connect")
  .option("--server <url>", "Server URL")
  .option("--auth-key <key>", "Authentication key (master key)")
  .action(async (opts) => {
    const key = getAuthKey(opts);
    const serverUrl = getServerUrl(opts);
    try {
      const { code } = await fetchJson(`${serverUrl}/api/invite`, {
        method: "POST",
        headers: authHeaders(key),
      }) as { code: string };
      console.log();
      console.log(`${BOLD}${MAGENTA}Invite Code${RESET}`);
      console.log();
      console.log(`  ${BOLD}${GREEN}${code}${RESET}`);
      console.log();
      console.log(`${DIM}Share this with your friend along with the server URL.${RESET}`);
      console.log(`${DIM}They run: agent-hotline connect ${serverUrl} --code ${code}${RESET}`);
      console.log();
    } catch (e) {
      fail(e instanceof CliError ? e.message : String(e));
    }
  });

// ── connect ──
program
  .command("connect")
  .description("Connect to a mesh using an invite code or cluster key")
  .argument("<url>", "Bootstrap peer URL (e.g. https://hotline.example.com)")
  .option("--code <code>", "Invite code (legacy)")
  .option("--cluster-key <key>", "Cluster key for mesh authentication")
  .action(async (url, opts) => {
    const bootstrapUrl = url.replace(/\/+$/, "");
    const clusterKey = opts.clusterKey || process.env.HOTLINE_CLUSTER_KEY;

    if (opts.code) {
      try {
        const { key } = await fetchJson(`${bootstrapUrl}/api/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: opts.code }),
        }) as { key: string };
        const dir = configDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const cfgPath = join(dir, "config");
        writeFileSync(cfgPath, [
          `HOTLINE_AUTH_KEY=${key}`,
          `HOTLINE_SERVER=http://localhost:3456`,
        ].join("\n") + "\n", "utf-8");
        console.log(`${BOLD}${GREEN}Connected via invite code!${RESET}`);
        console.log(`${DIM}Config saved to ${cfgPath}${RESET}`);
      } catch (e) {
        fail(e instanceof CliError ? e.message : String(e));
      }
      return;
    }

    if (!clusterKey) {
      fail("either --cluster-key or --code is required.");
    }

    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, "config");
    const localPort = 3456;
    writeFileSync(cfgPath, [
      `HOTLINE_CLUSTER_KEY=${clusterKey}`,
      `HOTLINE_SERVER=http://localhost:${localPort}`,
    ].join("\n") + "\n", "utf-8");

    const { copyHookScript } = await import("./setup/hook.js");
    copyHookScript();

    const scriptPath = join(__dirname, "index.js");
    const child = spawn("node", [
      scriptPath, "serve",
      "--port", String(localPort),
      "--bootstrap", bootstrapUrl,
      "--cluster-key", clusterKey,
    ], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();

    console.log();
    console.log(`${BOLD}${GREEN}Connected to mesh!${RESET}`);
    console.log(`${DIM}Config saved to ${cfgPath}${RESET}`);
    console.log(`${GREEN}Local server started${RESET} on port ${localPort} (PID ${child.pid})`);
    console.log(`${DIM}Bootstrap peer: ${bootstrapUrl}${RESET}`);
    console.log();
    console.log(`${BOLD}Next steps${RESET} - wire into your coding tool:`);
    console.log();
    console.log(`  ${CYAN}Claude Code:${RESET}`);
    console.log(`    agent-hotline setup claude-code`);
    console.log();
  });

program.parseAsync().catch((e) => {
  fail(e instanceof CliError ? e.message : String(e?.message ?? e));
});
