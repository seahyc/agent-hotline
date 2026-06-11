import { existsSync, statSync, appendFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_SIZE = 5 * 1024 * 1024; // 5MB per file, plus one rotated file (~10MB history)

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
  // Move the full file aside (replacing the previous rotation) and start fresh,
  // so a debugging session always has the last ~10MB of history on disk.
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch { /* best effort */ }
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
