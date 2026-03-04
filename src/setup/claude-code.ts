import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mcpUrl } from "./auth.js";
import { copyHookScript } from "./hook.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export function setupClaudeCode(agentName: string, serverUrl: string): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const mcpickPath = join(homedir(), ".claude", "mcpick", "servers.json");
  const dir = join(homedir(), ".claude");
  const hotlineDir = join(homedir(), ".agent-hotline");

  const resolvedMcpUrl = mcpUrl(serverUrl);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // --- Install hook.sh and config ---
  copyHookScript();
  const configDst = join(hotlineDir, "config");
  if (!existsSync(configDst)) {
    writeFileSync(configDst, `HOTLINE_SERVER=${serverUrl}\n`, "utf-8");
  }

  let config: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      config = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      config = {};
    }
  }

  const changes: string[] = [];

  // --- MCPick config (preferred if mcpick directory exists) ---
  const mcpickDir = join(homedir(), ".claude", "mcpick");
  if (existsSync(mcpickDir)) {
    let mcpickConfig: { servers: Array<Record<string, unknown>> } = { servers: [] };
    if (existsSync(mcpickPath)) {
      try {
        mcpickConfig = JSON.parse(readFileSync(mcpickPath, "utf-8"));
      } catch {
        mcpickConfig = { servers: [] };
      }
    }
    const hasEntry = mcpickConfig.servers.some((s) => s.name === "hotline" || s.name === "agent-hotline");
    if (!hasEntry) {
      mcpickConfig.servers.push({
        name: "hotline",
        type: "http",
        url: resolvedMcpUrl,
      });
      writeFileSync(mcpickPath, JSON.stringify(mcpickConfig, null, 2) + "\n", "utf-8");
      changes.push("mcpick/servers.json (agent-hotline)");
    }
  } else {
    // Fallback: add to settings.json mcpServers
    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }
    const mcpServers = config.mcpServers as Record<string, unknown>;
    const desiredMcp = { type: "url", url: resolvedMcpUrl };
    const existing = mcpServers["hotline"] as Record<string, unknown> | undefined;
    if (!existing || existing.url !== desiredMcp.url || existing.type !== desiredMcp.type) {
      mcpServers["hotline"] = desiredMcp;
      changes.push("mcpServers.agent-hotline");
    }
  }

  // --- Hook config ---
  if (!config.hooks || typeof config.hooks !== "object") {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown>;

  const hookCommand = `bash ~/.agent-hotline/hook.sh`;

  const desiredHookEntry = {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: hookCommand,
      },
    ],
  };

  if (!Array.isArray(hooks.UserPromptSubmit)) {
    hooks.UserPromptSubmit = [];
  }
  const promptHooks = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

  // Check if an agent-hotline hook already exists
  const alreadyHasHook = promptHooks.some((entry) => {
    const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(innerHooks)) return false;
    return innerHooks.some(
      (h) => typeof h.command === "string" && (h.command.includes("agent-hotline") || h.command.includes("hook.sh")),
    );
  });

  if (!alreadyHasHook) {
    promptHooks.push(desiredHookEntry);
    changes.push("hooks.UserPromptSubmit");
  }


  // --- Write ---
  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  if (changes.length === 0) {
    console.log(`${DIM}Already configured - no changes needed.${RESET}`);
  } else {
    console.log(`${GREEN}${BOLD}Configured Claude Code${RESET}`);
    console.log(`${DIM}File: ${settingsPath}${RESET}`);
    console.log();
    for (const c of changes) {
      console.log(`  ${YELLOW}+${RESET} ${c}`);
    }
    console.log();
    console.log(`${DIM}Restart Claude Code to pick up changes.${RESET}`);
  }
}
