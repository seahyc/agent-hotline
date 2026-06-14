import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { hostname, platform } from "node:os";
import { basename, dirname, relative, isAbsolute } from "node:path";
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
  dir_chain: string[];
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

/** Keys for `startDir`, its ancestors, up to and including `root` (a repo root with
 * basename `base`). Root itself keys as `base`; nested dirs as `base/<relpath>`.
 * Leaf-first order. If `startDir` is not within `root`, returns just `[base]`. */
function keysFromDirToRoot(startDir: string, root: string, base: string): string[] {
  const rel0 = relative(root, startDir);
  if (rel0.startsWith("..") || isAbsolute(rel0)) return [base];
  const keys: string[] = [];
  let d = startDir;
  // Bounded climb: relative() shrinks to "" exactly at root, terminating the loop.
  for (let i = 0; i < 256; i++) {
    const rel = relative(root, d);
    keys.push(rel === "" ? base : `${base}/${rel}`);
    if (rel === "") break;
    d = dirname(d);
  }
  return keys;
}

/**
 * Compute the directory-room key chain for a cwd, leaf -> ceiling.
 * - Not in a git repo: `[cwd]` only (machine-local key; no ancestor climb).
 * - In a repo: cwd + each ancestor up to the repo root, keyed `<repoBasename>/<relpath>`
 *   (repo root itself = `<repoBasename>`).
 * - Then across submodule boundaries: the repo's superproject (if any) contributes its
 *   own chain (superproject basename + the submodule's path within it, up to its root),
 *   repeated until there is no superproject. Outermost superproject root is the ceiling.
 * All git calls tolerate failure (2s timeout in `run`); on no-repo we fall back to `[cwd]`.
 */
export async function computeDirChain(cwd: string): Promise<string[]> {
  if (!cwd) return [];
  const top = await run(`git -C "${cwd}" rev-parse --show-toplevel 2>/dev/null`);
  if (!top) return [cwd]; // no repo boundary; machine-local, no ancestor climb

  const chain: string[] = [];
  let startDir = cwd;
  let root = top;
  for (let depth = 0; depth < 64; depth++) {
    chain.push(...keysFromDirToRoot(startDir, root, basename(root)));
    const superRoot = await run(
      `git -C "${root}" rev-parse --show-superproject-working-tree 2>/dev/null`,
    );
    if (!superRoot) break;
    // This repo is a submodule sitting at `root` within the superproject.
    startDir = root;
    root = superRoot;
  }
  // Dedupe while preserving leaf-first order (defensive against odd nesting).
  return [...new Set(chain)];
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
  const [agent_type, branch, dirty_files, cwd_remote, dir_chain] = await Promise.all([
    getAgentType(pid),
    getGitBranch(cwd),
    getGitDirtyFiles(cwd),
    getGitRemote(cwd),
    computeDirChain(cwd),
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
    dir_chain,
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
  const [branch, dirty_files, cwd_remote, background_processes, dir_chain] = await Promise.all([
    getGitBranch(cwd),
    getGitDirtyFiles(cwd),
    getGitRemote(cwd),
    getChildProcesses(pid),
    computeDirChain(cwd),
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
    dir_chain,
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
