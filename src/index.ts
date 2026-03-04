#!/usr/bin/env node

import { Command } from "commander";
import { createStore } from "./store.js";
import { createServer } from "./server.js";
import { startPresenceLoop } from "./presence.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec, execSync, spawn } from "node:child_process";
import { hostname } from "node:os";
import { basename } from "node:path";
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
  .version("0.1.0");

// ── serve ──
program
  .command("serve")
  .description("Start the MCP server (hub mode by default, or client mode with --hub)")
  .option("--port <port>", "Port to listen on", "3456")
  .option("--auth-key <key>", "Authentication key")
  .option("--hub <url>", "Hub server URL (enables client/proxy mode)")
  .option("--db <path>", "Database file path")
  .option("--retention-days <days>", "Auto-delete messages older than N days (0 = keep forever)", "7")
  .action(async (opts) => {
    const { initLog, log } = await import("./log.js");
    initLog();

    const port = parseInt(opts.port, 10);
    const hubUrl = opts.hub?.replace(/\/+$/, "");

    if (hubUrl) {
      // ── Client mode: stateless proxy to hub ──
      const authKey = opts.authKey ?? readConfig().HOTLINE_AUTH_KEY;
      if (!authKey) {
        console.error("Auth key required in client mode. Use --auth-key or run 'agent-hotline connect' first.");
        process.exit(1);
      }

      const { createClientServer } = await import("./client.js");
      const { app: clientApp, stop } = createClientServer({ hubUrl, authKey, port });

      // Save config pointing to localhost
      const cfgDir = configDir();
      if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
      const cfgPath = join(cfgDir, "config");
      const existingConfig = existsSync(cfgPath) ? readFileSync(cfgPath, "utf-8") : "";
      const configLines = existingConfig.split("\n").filter((l) =>
        !l.startsWith("HOTLINE_AUTH_KEY=") &&
        !l.startsWith("HOTLINE_SERVER=") &&
        !l.startsWith("HOTLINE_HUB=")
      );
      configLines.unshift(`HOTLINE_HUB=${hubUrl}`);
      configLines.unshift(`HOTLINE_SERVER=http://localhost:${port}`);
      configLines.unshift(`HOTLINE_AUTH_KEY=${authKey}`);
      writeFileSync(cfgPath, configLines.filter(Boolean).join("\n") + "\n", "utf-8");

      const server = clientApp.listen(port, () => {
        log("info", `client server started on port ${port}, hub=${hubUrl}`);
        console.log();
        console.log(`${BOLD}${MAGENTA}  Agent Hotline ${YELLOW}(client mode)${RESET}`);
        console.log(`${DIM}  ────────────────────────────${RESET}`);
        console.log(`  ${GREEN}Local proxy${RESET}   http://localhost:${port}`);
        console.log(`  ${GREEN}Hub${RESET}           ${hubUrl}`);
        console.log(`  ${GREEN}Health${RESET}        http://localhost:${port}/health`);
        console.log();
        console.log(`  ${CYAN}All traffic proxied to hub. PID monitoring active locally.${RESET}`);
        console.log(`  ${DIM}Press Ctrl+C to stop${RESET}`);
        console.log();
      });

      const shutdown = () => {
        console.log(`\n${DIM}Shutting down client...${RESET}`);
        stop();
        server.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } else {
      // ── Hub mode (default, unchanged) ──
      const dbPath = opts.db ?? defaultDbPath();
      const retentionDays = parseInt(opts.retentionDays, 10);

      const store = createStore(dbPath);
      const authKey = opts.authKey ?? readConfig().HOTLINE_AUTH_KEY ?? undefined;
      const { app, masterKey } = createServer(store, { authKey, port });
      const presence = startPresenceLoop(store, undefined, retentionDays > 0 ? retentionDays : undefined);

      // Save auth key to local config so hook.sh picks it up
      const cfgDir = configDir();
      if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
      const cfgPath = join(cfgDir, "config");
      const existingConfig = existsSync(cfgPath) ? readFileSync(cfgPath, "utf-8") : "";
      const configLines = existingConfig.split("\n").filter((l) => !l.startsWith("HOTLINE_AUTH_KEY=") && !l.startsWith("HOTLINE_SERVER="));
      configLines.unshift(`HOTLINE_SERVER=http://localhost:${port}`);
      configLines.unshift(`HOTLINE_AUTH_KEY=${masterKey}`);
      writeFileSync(cfgPath, configLines.filter(Boolean).join("\n") + "\n", "utf-8");

      const server = app.listen(port, () => {
        log("info", `hub server started on port ${port}, db=${dbPath}`);
        console.log();
        console.log(`${BOLD}${MAGENTA}  Agent Hotline${RESET}`);
        console.log(`${DIM}  ────────────────────────────${RESET}`);
        console.log(`  ${GREEN}MCP endpoint${RESET}  http://localhost:${port}/mcp`);
        console.log(`  ${GREEN}REST API${RESET}      http://localhost:${port}/api/`);
        console.log(`  ${GREEN}Health${RESET}        http://localhost:${port}/health`);
        console.log(`  ${DIM}Database${RESET}      ${dbPath}`);
        console.log(`  ${DIM}Retention${RESET}     ${retentionDays > 0 ? `${retentionDays} days` : "forever"}`);
        console.log(`  ${GREEN}Auth key${RESET}     ${masterKey}${opts.authKey ? "" : " (auto-generated)"}`);
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
        presence.stop();
        server.close();
        store.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    }
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

// ── checkin ──
function shell(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

program
  .command("checkin")
  .description("Register this agent with the hotline server (auto-gathers git context)")
  .requiredOption("--agent <name>", "Agent name")
  .option("--server <url>", "Server URL", "http://localhost:3456")
  .option("--auth-key <key>", "Authentication key")
  .option("--type <type>", "Agent type", "claude-code")
  .option("--status <status>", "What you're working on", "active")
  .option("--quiet", "No output on success")
  .action(async (opts) => {
    const cwd = process.cwd();
    const branch = shell("git branch --show-current");
    const cwdRemote = shell("git remote get-url origin");
    const dirtyFiles = shell("git diff --name-only && git diff --staged --name-only")
      .split("\n")
      .filter(Boolean);

    const body = {
      session_id: opts.agent,
      agent_type: opts.type,
      machine: hostname(),
      cwd,
      cwd_remote: cwdRemote,
      branch: branch || "unknown",
      status: opts.status,
      dirty_files: dirtyFiles,
    };

    const key = getAuthKey(opts);
    try {
      const res = await fetch(`${opts.server}/api/checkin`, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (!opts.quiet) console.error(`Checkin failed: ${res.status}`);
        process.exit(1);
      }
      if (!opts.quiet) {
        console.log(`Checked in as ${opts.agent} (${cwd}, ${branch || "no branch"})`);
      }
    } catch {
      if (!opts.quiet) console.error("Could not connect to server.");
    }
    process.exit(0);
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
  .description("Connect to a hotline server using an invite code")
  .argument("<url>", "Server URL (e.g. https://abc123.ngrok.io)")
  .requiredOption("--code <code>", "Invite code")
  .action(async (url, opts) => {
    const serverUrl = url.replace(/\/+$/, "");
    try {
      const res = await fetch(`${serverUrl}/api/connect`, {
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

      // Save config + install hook.sh
      const dir = configDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const cfgPath = join(dir, "config");
      const localPort = 3456;
      writeFileSync(cfgPath, [
        `HOTLINE_AUTH_KEY=${key}`,
        `HOTLINE_SERVER=http://localhost:${localPort}`,
        `HOTLINE_HUB=${serverUrl}`,
      ].join("\n") + "\n", "utf-8");

      // Copy hook.sh
      const { copyHookScript } = await import("./setup/hook.js");
      copyHookScript();

      // Auto-start local client server as a background daemon
      const scriptPath = join(__dirname, "index.js");
      const logPath = join(dir, "client.log");
      const child = spawn("node", [scriptPath, "serve", "--port", String(localPort), "--hub", serverUrl, "--auth-key", key], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.unref();

      const localMcpUrl = `http://localhost:${localPort}/mcp`;

      console.log();
      console.log(`${BOLD}${GREEN}Connected!${RESET}`);
      console.log(`${DIM}Config saved to ${cfgPath}${RESET}`);
      console.log(`${GREEN}Local client server started${RESET} on port ${localPort} (PID ${child.pid})`);
      console.log();
      console.log(`${BOLD}Next steps${RESET} - add the MCP server and hook to your tool:`);
      console.log();
      console.log(`  ${CYAN}Claude Code (recommended):${RESET}`);
      console.log(`    agent-hotline setup claude-code`);
      console.log();
      console.log(`  ${CYAN}Claude Code (manual):${RESET}`);
      console.log(`    claude mcp add-json hotline '${JSON.stringify({ type: "url", url: localMcpUrl })}'`);
      console.log(`    ${DIM}Then add to ~/.claude/settings.json hooks.UserPromptSubmit:${RESET}`);
      console.log(`    ${DIM}{"matcher": "", "hooks": [{"type": "command", "command": "bash ~/.agent-hotline/hook.sh"}]}${RESET}`);
      console.log();
      console.log(`  ${CYAN}Codex:${RESET}`);
      console.log(`    Add to ~/.codex/config.toml:`);
      console.log(`    ${DIM}[mcp_servers.hotline]${RESET}`);
      console.log(`    ${DIM}type = "url"${RESET}`);
      console.log(`    ${DIM}url = "${localMcpUrl}"${RESET}`);
      console.log();
      console.log(`  ${CYAN}OpenCode:${RESET}`);
      console.log(`    Add to opencode.json:`);
      console.log(`    ${DIM}"mcp": { "hotline": { "type": "remote", "url": "${localMcpUrl}" } }${RESET}`);
      console.log();
    } catch (e) {
      console.error("Could not connect to server.", e);
      process.exit(1);
    }
  });

program.parse();
