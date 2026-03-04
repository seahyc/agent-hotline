#!/usr/bin/env node

import { Command } from "commander";
import { createStore } from "./store.js";
import { createServer } from "./server.js";
import { startPresenceLoop } from "./presence.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
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
  .description("Start the MCP server")
  .option("--port <port>", "Port to listen on", "3456")
  .option("--auth-key <key>", "Authentication key")
  .option("--db <path>", "Database file path")
  .action((opts) => {
    const dbPath = opts.db ?? defaultDbPath();
    const port = parseInt(opts.port, 10);

    const store = createStore(dbPath);
    const { app } = createServer(store);
    const presence = startPresenceLoop(store);

    const server = app.listen(port, () => {
      console.log();
      console.log(`${BOLD}${MAGENTA}  Agent Hotline${RESET}`);
      console.log(`${DIM}  ────────────────────────────${RESET}`);
      console.log(`  ${GREEN}MCP endpoint${RESET}  http://localhost:${port}/mcp`);
      console.log(`  ${GREEN}REST API${RESET}      http://localhost:${port}/api/`);
      console.log(`  ${GREEN}Health${RESET}        http://localhost:${port}/health`);
      console.log(`  ${DIM}Database${RESET}      ${dbPath}`);
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
  });

// ── watch ──
program
  .command("watch")
  .description("Terminal inbox watcher")
  .requiredOption("--agent <name>", "Agent name to watch")
  .option("--server <url>", "Server URL", "http://localhost:3456")
  .action(async (opts) => {
    const { agent, server: serverUrl } = opts;
    const url = `${serverUrl}/api/inbox/${encodeURIComponent(agent)}`;

    console.log(
      `${BOLD}${MAGENTA}Agent Hotline${RESET} ${DIM}watching inbox for${RESET} ${CYAN}${agent}${RESET}`,
    );
    console.log(`${DIM}Server: ${serverUrl}${RESET}`);
    console.log(`${DIM}Polling every 5s... Press Ctrl+C to stop${RESET}`);
    console.log();

    const poll = async () => {
      try {
        const res = await fetch(url);
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
  .action(async (opts) => {
    const { agent, server: serverUrl, format, quiet } = opts;
    const url = `${serverUrl}/api/inbox/${encodeURIComponent(agent)}`;

    try {
      const res = await fetch(url);
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

program.parse();
