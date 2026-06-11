import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { hostname, platform } from "node:os";
import { log } from "./log.js";

const execAsync = promisify(execCb);

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

/** Run a shell command and return trimmed stdout, or fallback on failure.
 * Async on purpose: context resolution runs on the server's request path
 * neighborhood and must never block the event loop (lsof can take seconds). */
async function run(cmd: string, fallback = ""): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: "utf-8", timeout: 2000 });
    return stdout.trim();
  } catch {
    return fallback;
  }
}

/** Get the cwd of a process by PID. */
async function getCwd(pid: number): Promise<string> {
  const os = platform();
  if (os === "darwin") {
    // lsof -p PID -d cwd -Fn -> output like "p1234\nn/path/to/dir"
    const out = await run(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`);
    const match = out.match(/\nn(.+)/);
    return match?.[1] ?? "";
  }
  if (os === "linux") {
    return run(`readlink -f /proc/${pid}/cwd 2>/dev/null`);
  }
  return "";
}

/** Get process command name for agent type detection. */
async function getAgentType(pid: number): Promise<string> {
  const comm = (await run(`ps -p ${pid} -o comm= 2>/dev/null`)).toLowerCase();
  if (comm.includes("claude")) return "claude-code";
  if (comm.includes("codex")) return "codex";
  if (comm.includes("cursor")) return "cursor";
  if (comm.includes("windsurf")) return "windsurf";
  return comm || "unknown";
}

/** Get git branch for a directory. */
async function getGitBranch(cwd: string): Promise<string> {
  if (!cwd) return "";
  return run(`git -C "${cwd}" branch --show-current 2>/dev/null`);
}

/** Get dirty files (unstaged + staged). */
async function getGitDirtyFiles(cwd: string): Promise<string[]> {
  if (!cwd) return [];
  const [unstaged, staged] = await Promise.all([
    run(`git -C "${cwd}" diff --name-only 2>/dev/null`),
    run(`git -C "${cwd}" diff --staged --name-only 2>/dev/null`),
  ]);
  const combined = [unstaged, staged].filter(Boolean).join("\n");
  if (!combined) return [];
  return [...new Set(combined.split("\n").filter(Boolean))];
}

/** Get git remote origin URL. */
async function getGitRemote(cwd: string): Promise<string> {
  if (!cwd) return "";
  return run(`git -C "${cwd}" remote get-url origin 2>/dev/null`);
}

/** Get child processes of a PID. */
async function getChildProcesses(pid: number): Promise<{ pid: number; command: string }[]> {
  const childPids = await run(`pgrep -P ${pid} 2>/dev/null`);
  if (!childPids) return [];
  const pids = childPids.split("\n").filter(Boolean).map(Number).filter(n => !isNaN(n));
  const commands = await Promise.all(
    pids.map(cpid => run(`ps -p ${cpid} -o args= 2>/dev/null`)),
  );
  const result: { pid: number; command: string }[] = [];
  for (let i = 0; i < pids.length; i++) {
    if (commands[i]) result.push({ pid: pids[i], command: commands[i] });
  }
  return result;
}

/**
 * Resolve context for a KNOWN cwd (e.g. supplied by the Claude Code hook,
 * which is authoritative — the claude process's kernel cwd can belong to a
 * different session when sessions share an app process).
 */
export async function resolveContextForCwd(cwd: string, pid: number): Promise<AgentContext> {
  const [agent_type, branch, dirty_files, cwd_remote] = await Promise.all([
    getAgentType(pid),
    getGitBranch(cwd),
    getGitDirtyFiles(cwd),
    getGitRemote(cwd),
  ]);
  return {
    cwd,
    branch,
    dirty_files,
    cwd_remote,
    machine: hostname(),
    agent_type,
    conversation_recent: "",
    background_processes: [],
  };
}

/**
 * Resolve live context for an agent by PID.
 * Results are cached for 5s to avoid repeated subprocess spawning.
 */
export async function resolveContext(pid: number, sessionId: string): Promise<AgentContext> {
  const cached = cache.get(pid);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.context;
  }

  const [cwd, agent_type] = await Promise.all([getCwd(pid), getAgentType(pid)]);
  const [branch, dirty_files, cwd_remote, background_processes] = await Promise.all([
    getGitBranch(cwd),
    getGitDirtyFiles(cwd),
    getGitRemote(cwd),
    getChildProcesses(pid),
  ]);

  const context: AgentContext = {
    cwd,
    branch,
    dirty_files,
    cwd_remote,
    machine: hostname(),
    agent_type,
    conversation_recent: "",
    background_processes,
  };

  cache.set(pid, { context, timestamp: Date.now() });
  log("info", `context resolved for PID ${pid}: cwd=${cwd}, branch=${branch}`);
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
