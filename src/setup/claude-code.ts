import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mcpUrl } from "./auth.js";
import { copyHookScript } from "./hook.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

export function setupClaudeCode(agentName: string, serverUrl: string): void {
  const hotlineDir = join(homedir(), ".agent-hotline");

  const resolvedMcpUrl = mcpUrl(serverUrl);

  // --- Install hook.sh and config ---
  copyHookScript();
  const configDst = join(hotlineDir, "config");
  if (!existsSync(configDst)) {
    if (!existsSync(hotlineDir)) mkdirSync(hotlineDir, { recursive: true });
    writeFileSync(configDst, `HOTLINE_SERVER=${serverUrl}\n`, "utf-8");
  }

  console.log(`${GREEN}${BOLD}Setup complete${RESET}`);
  console.log();
  console.log(`  Installed hook.sh to ${DIM}~/.agent-hotline/hook.sh${RESET}`);
  console.log(`  Config at ${DIM}~/.agent-hotline/config${RESET}`);
  console.log();
  console.log(`${CYAN}Add the MCP server manually:${RESET}`);
  console.log(`  claude mcp add-json hotline '${JSON.stringify({ type: "url", url: resolvedMcpUrl })}'`);
  console.log();
  console.log(`${CYAN}Add the prompt hook to your Claude Code settings:${RESET}`);
  console.log(`  ${DIM}{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"bash ~/.agent-hotline/hook.sh"}]}]}}${RESET}`);
  console.log();
}
