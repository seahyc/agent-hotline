import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { log } from "./log.js";
import type { Store } from "./store.js";

const execAsync = promisify(execCb);

/** Run a command without ever blocking the event loop (this runs on the server). */
async function run(cmd: string, timeout = 2000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: "utf-8", timeout });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Resolve a session_id for a client PID.
 *
 * Resolution order:
 * 1. DB lookup: check this PID and walk up the process tree
 * 2. Claude Code filesystem: ~/.claude/projects/{encoded-cwd}/{uuid}/
 * 3. Codex filesystem: ~/.codex/history.jsonl
 * 4. Returns null if no match (caller should auto-generate)
 */
export async function resolveSessionId(pid: number, store: Store): Promise<string | null> {
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

    const processName = await getProcessName(current);

    // Check if this is a Claude Code process
    if (processName && processName.toLowerCase().includes("claude")) {
      const claudeId = await resolveFromClaudeCode(current);
      if (claudeId) {
        log("info", `identity resolved via Claude Code filesystem: PID ${pid} -> ancestor PID ${current} (${processName}) -> ${claudeId}`);
        return claudeId;
      }
    }

    // Check if this is a Codex process
    if (processName && processName.toLowerCase().includes("codex")) {
      const codexId = resolveFromCodex();
      if (codexId) {
        log("info", `identity resolved via Codex filesystem: PID ${pid} -> ancestor PID ${current} (${processName}) -> ${codexId}`);
        return codexId;
      }
    }

    // Move to parent
    current = await getParentPid(current);
  }

  log("info", `identity unresolved for PID ${pid} (walked ${visited.size} ancestors)`);
  return null;
}

/** Get the CWD of a process by PID. */
export async function getCwdForPid(pid: number): Promise<string> {
  const os = platform();
  if (os === "darwin") {
    const out = await run(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`);
    // lsof may return multiple process sections; find the one for our specific PID
    const lines = out.split("\n");
    let foundPid = false;
    for (const line of lines) {
      if (line === `p${pid}`) { foundPid = true; continue; }
      if (foundPid && line.startsWith("n")) return line.slice(1);
      if (foundPid && line.startsWith("p")) break;
    }
    return "";
  }
  if (os === "linux") {
    return run(`readlink -f /proc/${pid}/cwd 2>/dev/null`, 500);
  }
  return "";
}

/** Resolve Claude Code session_id from process CWD → ~/.claude/projects/ filesystem */
export async function resolveFromClaudeCode(pid: number): Promise<string | null> {
  try {
    const cwd = await getCwdForPid(pid);
    if (!cwd) return null;

    // Encode: /Users/foo/bar → -Users-foo-bar
    const encoded = cwd.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encoded);

    // Find most recently modified session UUID directory
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name))
      .map(e => ({ name: e.name, mtime: statSync(join(projectDir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    return dirs[0]?.name ?? null;
  } catch {
    return null;
  }
}

/** Get the parent PID of a process. Returns null on failure. */
async function getParentPid(pid: number): Promise<number | null> {
  const os = platform();
  if (os === "darwin" || os === "linux") {
    const out = await run(`ps -p ${pid} -o ppid= 2>/dev/null`, 500);
    const ppid = parseInt(out, 10);
    return isNaN(ppid) || ppid <= 0 ? null : ppid;
  }
  return null;
}

/** Get the command name for a PID. Returns null on failure. */
async function getProcessName(pid: number): Promise<string | null> {
  const os = platform();
  if (os === "darwin" || os === "linux") {
    return (await run(`ps -p ${pid} -o comm= 2>/dev/null`, 500)) || null;
  }
  return null;
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
