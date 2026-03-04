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
 * 1. DB lookup: check this PID and walk up the process tree (TCP socket PID
 *    is often a child subprocess, not the agent itself)
 * 2. Process name check + filesystem: if any ancestor is a Codex process,
 *    read ~/.codex/history.jsonl
 * 3. Returns null if no match (caller should auto-generate)
 */
export function resolveSessionId(pid: number, store: Store): string | null {
  // Walk up the process tree, checking each PID against the DB
  const visited = new Set<number>();
  let current: number | null = pid;

  while (current && current > 1 && !visited.has(current)) {
    visited.add(current);

    // DB lookup (hook-registered agents)
    const agent = store.getAgentByPid(current);
    if (agent) {
      log("info", `identity resolved via DB: PID ${pid} -> ancestor PID ${current} -> ${agent.session_id}`);
      return agent.session_id;
    }

    // Check if this is a Codex process
    const processName = getProcessName(current);
    if (processName && processName.toLowerCase().includes("codex")) {
      const codexId = resolveFromCodex();
      if (codexId) {
        log("info", `identity resolved via Codex filesystem: PID ${pid} -> ancestor PID ${current} (${processName}) -> ${codexId}`);
        return codexId;
      }
    }

    // Move to parent
    current = getParentPid(current);
  }

  log("info", `identity unresolved for PID ${pid} (walked ${visited.size} ancestors)`);
  return null;
}

/** Get the parent PID of a process. Returns null on failure. */
function getParentPid(pid: number): number | null {
  try {
    const os = platform();
    if (os === "darwin" || os === "linux") {
      const ppid = parseInt(
        execSync(`ps -p ${pid} -o ppid= 2>/dev/null`, {
          encoding: "utf-8",
          timeout: 500,
        }).trim(),
        10,
      );
      return isNaN(ppid) || ppid <= 0 ? null : ppid;
    }
    return null;
  } catch {
    return null;
  }
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
