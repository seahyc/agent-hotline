import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Returns the MCP URL. For localhost, no key needed (trusted). For remote, appends ?key= from config. */
export function mcpUrl(serverUrl: string): string {
  // Localhost is trusted by the server, no key needed
  if (serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1")) {
    return `${serverUrl}/mcp`;
  }
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
