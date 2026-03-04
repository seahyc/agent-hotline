import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, platform } from "node:os";
import { log } from "./log.js";

export interface AgentContext {
  cwd: string;
  branch: string;
  dirty_files: string[];
  cwd_remote: string;
  machine: string;
  agent_type: string;
  conversation_recent: string;
  background_processes: { pid: number; command: string }[];
}

interface CacheEntry {
  context: AgentContext;
  timestamp: number;
}

const CACHE_TTL_MS = 5000;
const cache = new Map<number, CacheEntry>();

/** Run a shell command and return trimmed stdout, or fallback on failure. */
function exec(cmd: string, fallback = ""): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 2000 }).trim();
  } catch {
    return fallback;
  }
}

/** Get the cwd of a process by PID. */
function getCwd(pid: number): string {
  const os = platform();
  if (os === "darwin") {
    // lsof -p PID -d cwd -Fn -> output like "p1234\nn/path/to/dir"
    const out = exec(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`);
    const match = out.match(/\nn(.+)/);
    return match?.[1] ?? "";
  }
  if (os === "linux") {
    return exec(`readlink -f /proc/${pid}/cwd 2>/dev/null`);
  }
  return "";
}

/** Get process command name for agent type detection. */
function getAgentType(pid: number): string {
  const comm = exec(`ps -p ${pid} -o comm= 2>/dev/null`).toLowerCase();
  if (comm.includes("claude")) return "claude-code";
  if (comm.includes("codex")) return "codex";
  if (comm.includes("cursor")) return "cursor";
  if (comm.includes("windsurf")) return "windsurf";
  return comm || "unknown";
}

/** Get git branch for a directory. */
function getGitBranch(cwd: string): string {
  if (!cwd) return "";
  return exec(`git -C "${cwd}" branch --show-current 2>/dev/null`);
}

/** Get dirty files (unstaged + staged). */
function getGitDirtyFiles(cwd: string): string[] {
  if (!cwd) return [];
  const unstaged = exec(`git -C "${cwd}" diff --name-only 2>/dev/null`);
  const staged = exec(`git -C "${cwd}" diff --staged --name-only 2>/dev/null`);
  const combined = [unstaged, staged].filter(Boolean).join("\n");
  if (!combined) return [];
  return [...new Set(combined.split("\n").filter(Boolean))];
}

/** Get git remote origin URL. */
function getGitRemote(cwd: string): string {
  if (!cwd) return "";
  return exec(`git -C "${cwd}" remote get-url origin 2>/dev/null`);
}

/** Get child processes of a PID. */
function getChildProcesses(pid: number): { pid: number; command: string }[] {
  const childPids = exec(`pgrep -P ${pid} 2>/dev/null`);
  if (!childPids) return [];
  const pids = childPids.split("\n").filter(Boolean).map(Number);
  const result: { pid: number; command: string }[] = [];
  for (const cpid of pids) {
    if (isNaN(cpid)) continue;
    const command = exec(`ps -p ${cpid} -o args= 2>/dev/null`);
    if (command) {
      result.push({ pid: cpid, command });
    }
  }
  return result;
}

/** Read recent conversation from Claude Code history. */
function getConversationRecent(sessionId: string): string {
  try {
    // Claude Code stores history at ~/.claude/projects/*/conversation.jsonl
    // or via the session_id. For now, keep it simple - the history format
    // is complex and varies. Return empty for now, agents can use resources.
    return "";
  } catch {
    return "";
  }
}

/**
 * Resolve live context for an agent by PID.
 * Results are cached for 5s to avoid repeated subprocess spawning.
 */
export function resolveContext(pid: number, sessionId: string): AgentContext {
  const cached = cache.get(pid);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.context;
  }

  const cwd = getCwd(pid);
  const context: AgentContext = {
    cwd,
    branch: getGitBranch(cwd),
    dirty_files: getGitDirtyFiles(cwd),
    cwd_remote: getGitRemote(cwd),
    machine: hostname(),
    agent_type: getAgentType(pid),
    conversation_recent: getConversationRecent(sessionId),
    background_processes: getChildProcesses(pid),
  };

  cache.set(pid, { context, timestamp: Date.now() });
  log("info", `context resolved for PID ${pid}: cwd=${cwd}, branch=${context.branch}`);
  return context;
}

/** Check if a PID is alive. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = check existence without killing
    return true;
  } catch {
    return false;
  }
}

/** Clear the context cache (for testing). */
export function clearContextCache(): void {
  cache.clear();
}
