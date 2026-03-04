import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export function setupCodex(agentName: string, serverUrl: string): void {
  const dir = join(homedir(), ".codex");
  const configPath = join(dir, "config.toml");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content = "";
  if (existsSync(configPath)) {
    content = readFileSync(configPath, "utf-8");
  }

  // Check if already configured
  if (content.includes("[mcp_servers.hotline]")) {
    console.log(`${DIM}Already configured - no changes needed.${RESET}`);
    console.log(`${DIM}File: ${configPath}${RESET}`);
    return;
  }

  const block = [
    "",
    "[mcp_servers.hotline]",
    'type = "url"',
    `url = "${serverUrl}/mcp"`,
    "",
  ].join("\n");

  content = content.trimEnd() + "\n" + block;

  writeFileSync(configPath, content, "utf-8");

  console.log(`${GREEN}${BOLD}Configured Codex${RESET}`);
  console.log(`${DIM}File: ${configPath}${RESET}`);
  console.log();
  console.log(`  ${YELLOW}+${RESET} mcp_servers.hotline`);
  console.log();
  console.log(
    `${DIM}Agent name "${agentName}" is not embedded in codex config.${RESET}`,
  );
  console.log(
    `${DIM}Use the agent-hotline MCP tools with your agent name at runtime.${RESET}`,
  );
}
