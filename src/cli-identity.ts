import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

function getParentPid(pid: number): number | null {
  try {
    const os = platform();
    if (os === "darwin" || os === "linux") {
      const ppid = parseInt(
        execSync(`ps -p ${pid} -o ppid= 2>/dev/null`, { encoding: "utf-8", timeout: 500 }).trim(),
        10,
      );
      return isNaN(ppid) || ppid <= 0 ? null : ppid;
    }
    return null;
  } catch {
    return null;
  }
}

function getProcessName(pid: number): string | null {
  try {
    return execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: "utf-8", timeout: 500 }).trim() || null;
  } catch {
    return null;
  }
}

function getCwdForPid(pid: number): string {
  const os = platform();
  try {
    if (os === "darwin") {
      const out = execSync(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: "utf-8", timeout: 2000 });
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
      return execSync(`readlink -f /proc/${pid}/cwd 2>/dev/null`, { encoding: "utf-8", timeout: 500 }).trim();
    }
  } catch {}
  return "";
}

function resolveFromClaudeCode(pid: number): string | null {
  try {
    const cwd = getCwdForPid(pid);
    if (!cwd) return null;
    const encoded = cwd.replace(/\//g, "-");
    const projectDir = join(homedir(), ".claude", "projects", encoded);
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

/**
 * Resolve own session_id by walking the process tree from PPID,
 * looking for a Claude Code process and reading its session UUID from the filesystem.
 * Returns null if not resolvable.
 */
export function resolveMyIdentity(): string | null {
  const visited = new Set<number>();
  let current: number | null = process.ppid;

  while (current && current > 1 && !visited.has(current)) {
    visited.add(current);
    const name = (getProcessName(current) ?? "").toLowerCase();
    if (name.includes("claude")) {
      const id = resolveFromClaudeCode(current);
      if (id) return id;
    }
    current = getParentPid(current);
  }
  return null;
}
