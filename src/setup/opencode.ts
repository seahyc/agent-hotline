import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mcpUrl } from "./auth.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export function setupOpenCode(agentName: string, serverUrl: string): void {
  const configPath = join(process.cwd(), "opencode.json");

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      config = {};
    }
  }

  const changes: string[] = [];

  if (!config.mcp || typeof config.mcp !== "object") {
    config.mcp = {};
  }
  const mcp = config.mcp as Record<string, unknown>;

  const desiredMcp = {
    type: "remote",
    url: mcpUrl(serverUrl),
  };

  const existing = mcp["hotline"] as Record<string, unknown> | undefined;
  if (!existing || existing.url !== desiredMcp.url || existing.type !== desiredMcp.type) {
    mcp["hotline"] = desiredMcp;
    changes.push("mcp.hotline");
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  if (changes.length === 0) {
    console.log(`${DIM}Already configured - no changes needed.${RESET}`);
  } else {
    console.log(`${GREEN}${BOLD}Configured OpenCode${RESET}`);
    console.log(`${DIM}File: ${configPath}${RESET}`);
    console.log();
    for (const c of changes) {
      console.log(`  ${YELLOW}+${RESET} ${c}`);
    }
    console.log();
    console.log(
      `${DIM}Agent name "${agentName}" is not embedded in opencode config.${RESET}`,
    );
    console.log(
      `${DIM}Use the agent-hotline MCP tools with your agent name at runtime.${RESET}`,
    );
  }
}
