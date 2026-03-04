import { existsSync, statSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_SIZE = 1024 * 1024; // 1MB cap

let logPath: string | null = null;

export function initLog(path?: string): void {
  logPath = path ?? join(homedir(), ".agent-hotline", "server.log");
  const dir = join(logPath, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function rotate(): void {
  if (!logPath || !existsSync(logPath)) return;
  const stat = statSync(logPath);
  if (stat.size <= MAX_SIZE) return;
  // Keep the newest half
  const content = readFileSync(logPath, "utf-8");
  const half = Math.floor(content.length / 2);
  const newlineAfterHalf = content.indexOf("\n", half);
  const trimmed = newlineAfterHalf >= 0 ? content.slice(newlineAfterHalf + 1) : content.slice(half);
  writeFileSync(logPath, trimmed, "utf-8");
}

export function log(level: "info" | "warn" | "error", msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  if (!logPath) {
    process.stderr.write(line);
    return;
  }
  appendFileSync(logPath, line, "utf-8");
  rotate();
}
