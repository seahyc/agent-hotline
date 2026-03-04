import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Read HOTLINE_AUTH_KEY from ~/.agent-hotline/config, returns the MCP URL with ?key= if set. */
export function mcpUrl(serverUrl: string): string {
  const configPath = join(homedir(), ".agent-hotline", "config");
  let authKey: string | undefined;
  if (existsSync(configPath)) {
    for (const line of readFileSync(configPath, "utf-8").split("\n")) {
      if (line.startsWith("HOTLINE_AUTH_KEY=")) {
        authKey = line.slice("HOTLINE_AUTH_KEY=".length).trim();
      }
    }
  }
  return authKey ? `${serverUrl}/mcp?key=${authKey}` : `${serverUrl}/mcp`;
}
