#!/usr/bin/env node

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { createStore } from "./store.js";
import { createServer } from "./server.js";
import { startPresenceLoop } from "./presence.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { exec, spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { Message } from "./store.js";

// ── ANSI colors ──
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

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

function authHeaders(key?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

function defaultDbPath(): string {
  const dir = join(homedir(), ".agent-hotline");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "hotline.db");
}

const program = new Command();

program
  .name("agent-hotline")
  .description("Cross-machine agent communication - MSN Messenger for coding agents")
  .version(pkg.version);

// ── serve ──
program
  .command("serve")
  .description("Start the MCP server (mesh peer node)")
  .option("--port <port>", "Port to listen on", "3456")
  .option("--auth-key <key>", "Authentication key")
  .option("--bootstrap <urls>", "Comma-separated bootstrap peer URLs (e.g. https://hotline.example.com)")
  .option("--cluster-key <key>", "Cluster key for mesh authentication (also reads HOTLINE_CLUSTER_KEY env)")
  .option("--db <path>", "Database file path")
  .option("--retention-days <days>", "Auto-delete messages older than N days (0 = keep forever)", "7")
  .action(async (opts) => {
    const { initLog, log } = await import("./log.js");
    initLog();

    const port = parseInt(opts.port, 10);
    const dbPath = opts.db ?? defaultDbPath();
    const retentionDays = parseInt(opts.retentionDays, 10);
    const clusterKey = opts.clusterKey || process.env.HOTLINE_CLUSTER_KEY || readConfig().HOTLINE_CLUSTER_KEY || undefined;
    const bootstrapUrls = opts.bootstrap
      ? (opts.bootstrap as string).split(",").map((u: string) => u.trim().replace(/\/+$/, ""))
      : [];

    const store = createStore(dbPath);
    const authKey = opts.authKey ?? readConfig().HOTLINE_AUTH_KEY ?? undefined;
    const { app, masterKey } = createServer(store, { authKey, port, clusterKey, bootstrapUrls });
    const presence = startPresenceLoop(store, undefined, retentionDays > 0 ? retentionDays : undefined);

    // Start gossip loop if cluster key is configured
    let gossipHandle: { stop: () => void } | null = null;
    let mdnsHandle: { stop: () => void } | null = null;
    if (clusterKey) {
      const { startGossipLoop, startMdns } = await import("./peers.js");
      const selfAddr = `http://localhost:${port}`;
      gossipHandle = startGossipLoop(store, { clusterKey, bootstrapUrls, selfAddr });
      mdnsHandle = startMdns(store, { clusterKey, port });
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
      !l.startsWith("HOTLINE_CLUSTER_KEY=")
    );
    configLines.unshift(`HOTLINE_SERVER=http://localhost:${port}`);
    configLines.unshift(`HOTLINE_AUTH_KEY=${masterKey}`);
    if (clusterKey) configLines.unshift(`HOTLINE_CLUSTER_KEY=${clusterKey}`);
    writeFileSync(cfgPath, configLines.filter(Boolean).join("\n") + "\n", "utf-8");

    const server = app.listen(port, () => {
      log("info", `server started on port ${port}, db=${dbPath}`);
      console.log();
      console.log(`${BOLD}${MAGENTA}  Agent Hotline${RESET}`);
      console.log(`${DIM}  ────────────────────────────${RESET}`);
      console.log(`  ${GREEN}MCP endpoint${RESET}  http://localhost:${port}/mcp`);
      console.log(`  ${GREEN}REST API${RESET}      http://localhost:${port}/api/`);
      console.log(`  ${GREEN}Health${RESET}        http://localhost:${port}/health`);
      console.log(`  ${DIM}Database${RESET}      ${dbPath}`);
      console.log(`  ${DIM}Retention${RESET}     ${retentionDays > 0 ? `${retentionDays} days` : "forever"}`);
      console.log(`  ${GREEN}Auth key${RESET}     ${masterKey}${opts.authKey ? "" : " (auto-generated)"}`);
      if (clusterKey) {
        console.log(`  ${GREEN}Mesh${RESET}         enabled (${bootstrapUrls.length} bootstrap peers)`);
      }
      console.log();
      const mcpUrl = `http://localhost:${port}/mcp`;
      console.log(`  ${CYAN}Add to Claude Code:${RESET}`);
      console.log(`  claude mcp add-json hotline '${JSON.stringify({ type: "url", url: mcpUrl })}'`);
      console.log();
      console.log(`  ${DIM}Press Ctrl+C to stop${RESET}`);
      console.log();
    });

    const shutdown = () => {
      console.log(`\n${DIM}Shutting down...${RESET}`);
      if (gossipHandle) gossipHandle.stop();
      if (mdnsHandle) mdnsHandle.stop();
      presence.stop();
      server.close();
      store.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ── watch ──
program
  .command("watch")
  .description("Terminal inbox watcher")
  .requiredOption("--agent <name>", "Agent name to watch")
  .option("--server <url>", "Server URL", "http://localhost:3456")
  .option("--auth-key <key>", "Authentication key")
  .action(async (opts) => {
    const { agent, server: serverUrl } = opts;
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
        const res = await fetch(url, { headers: authHeaders(key) });
        if (!res.ok) return;
        const messages = (await res.json()) as Message[];
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
  .description("One-shot inbox check (for hooks)")
  .requiredOption("--agent <name>", "Agent name to check")
  .option("--format <format>", "Output format: inline or human", "human")
  .option("--quiet", "Output nothing if no messages")
  .option("--server <url>", "Server URL", "http://localhost:3456")
  .option("--auth-key <key>", "Authentication key")
  .action(async (opts) => {
    const { agent, server: serverUrl, format, quiet } = opts;
    const key = getAuthKey(opts);
    const url = `${serverUrl}/api/inbox/${encodeURIComponent(agent)}`;

    try {
      const res = await fetch(url, { headers: authHeaders(key) });
      if (!res.ok) {
        if (!quiet) {
          console.error(`Failed to reach server: ${res.status}`);
        }
        process.exit(0);
      }
      const messages = (await res.json()) as Message[];

      if (messages.length === 0) {
        if (!quiet) {
          console.log("No unread messages.");
        }
        process.exit(0);
      }

      if (format === "inline") {
        // Compact format for injection into agent context
        const lines = messages.map(
          (m) =>
            `[${formatTimestamp(m.timestamp)}] ${m.from_agent}: ${m.content}`,
        );
        console.log(lines.join("\n"));
      } else {
        // Human-readable format
        for (const msg of messages) {
          printMessage(msg);
        }
      }
    } catch {
      if (!quiet) {
        console.error("Could not connect to server.");
      }
    }
    process.exit(0);
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
      console.error(
        `Unknown tool: ${tool}. Supported: ${supported.join(", ")}`,
      );
      process.exit(1);
    }

    const agent = opts.agent ?? "my-agent";
    const serverUrl = opts.server;

    console.log(`${BOLD}${MAGENTA}Agent Hotline Setup${RESET}`);
    console.log();
    console.log(`Tool:   ${CYAN}${tool}${RESET}`);
    console.log(`Agent:  ${GREEN}${agent}${RESET}`);
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
  .option("--server <url>", "Server URL", "http://localhost:3456")
  .option("--auth-key <key>", "Authentication key (master key)")
  .action(async (opts) => {
    const key = getAuthKey(opts);
    const serverUrl = opts.server;
    try {
      const res = await fetch(`${serverUrl}/api/invite`, {
        method: "POST",
        headers: authHeaders(key),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error(`Failed: ${res.status} ${(body as Record<string, string>).error || ""}`);
        process.exit(1);
      }
      const { code } = (await res.json()) as { code: string };
      console.log();
      console.log(`${BOLD}${MAGENTA}Invite Code${RESET}`);
      console.log();
      console.log(`  ${BOLD}${GREEN}${code}${RESET}`);
      console.log();
      console.log(`${DIM}Share this with your friend along with the server URL.${RESET}`);
      console.log(`${DIM}They run: agent-hotline connect ${serverUrl} --code ${code}${RESET}`);
      console.log();
    } catch {
      console.error("Could not connect to server.");
      process.exit(1);
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
      // Legacy invite code flow
      try {
        const res = await fetch(`${bootstrapUrl}/api/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: opts.code }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.error(`Failed: ${res.status} ${(body as Record<string, string>).error || ""}`);
          process.exit(1);
        }
        const { key } = (await res.json()) as { key: string };
        // Save config
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
        console.error("Could not connect to server.", e);
        process.exit(1);
      }
      return;
    }

    if (!clusterKey) {
      console.error("Either --cluster-key or --code is required.");
      process.exit(1);
    }

    // Save config + install hook.sh
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, "config");
    const localPort = 3456;
    writeFileSync(cfgPath, [
      `HOTLINE_CLUSTER_KEY=${clusterKey}`,
      `HOTLINE_SERVER=http://localhost:${localPort}`,
    ].join("\n") + "\n", "utf-8");

    // Copy hook.sh
    const { copyHookScript } = await import("./setup/hook.js");
    copyHookScript();

    // Auto-start local server as a background daemon with mesh enabled
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

    const localMcpUrl = `http://localhost:${localPort}/mcp`;

    console.log();
    console.log(`${BOLD}${GREEN}Connected to mesh!${RESET}`);
    console.log(`${DIM}Config saved to ${cfgPath}${RESET}`);
    console.log(`${GREEN}Local server started${RESET} on port ${localPort} (PID ${child.pid})`);
    console.log(`${DIM}Bootstrap peer: ${bootstrapUrl}${RESET}`);
    console.log();
    console.log(`${BOLD}Next steps${RESET} - add the MCP server and hook to your tool:`);
    console.log();
    console.log(`  ${CYAN}Claude Code (recommended):${RESET}`);
    console.log(`    agent-hotline setup claude-code`);
    console.log();
    console.log(`  ${CYAN}Claude Code (manual):${RESET}`);
    console.log(`    claude mcp add-json hotline '${JSON.stringify({ type: "url", url: localMcpUrl })}'`);
    console.log();
  });

program.parse();
