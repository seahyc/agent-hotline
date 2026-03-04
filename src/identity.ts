import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { log } from "./log.js";
import type { Store } from "./store.js";

/**
 * Resolve a session_id for a client PID.
 *
 * Resolution order:
 * 1. DB lookup: check if the hook already registered an agent with this PID
 * 2. Process name check + filesystem: if PID is a Codex process, read ~/.codex/history.jsonl
 * 3. Returns null if no match (caller should auto-generate)
 */
export function resolveSessionId(pid: number, store: Store): string | null {
  // 1. DB lookup (hook-registered agents)
  const agent = store.getAgentByPid(pid);
  if (agent) {
    log("info", `identity resolved via DB: PID ${pid} -> ${agent.session_id}`);
    return agent.session_id;
  }

  // 2. Check if the PID belongs to a Codex process, then read filesystem
  const processName = getProcessName(pid);
  if (processName && processName.toLowerCase().includes("codex")) {
    const codexId = resolveFromCodex();
    if (codexId) {
      log("info", `identity resolved via Codex filesystem: PID ${pid} (${processName}) -> ${codexId}`);
      return codexId;
    }
  }

  log("info", `identity unresolved for PID ${pid}`);
  return null;
}

/** Get the command name for a PID. Returns null on failure. */
function getProcessName(pid: number): string | null {
  try {
    const os = platform();
    if (os === "darwin" || os === "linux") {
      return execSync(`ps -p ${pid} -o comm= 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 500,
      }).trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the most recent session_id from ~/.codex/history.jsonl */
function resolveFromCodex(): string | null {
  try {
    const historyPath = join(homedir(), ".codex", "history.jsonl");
    const content = readFileSync(historyPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    // Read from the end to find the most recent entry with a session_id
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.session_id) return entry.session_id;
    }
  } catch {
    // File doesn't exist or parse error - that's fine
  }
  return null;
}
