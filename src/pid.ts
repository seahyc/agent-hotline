import { execSync } from "node:child_process";
import { platform } from "node:os";
import { log } from "./log.js";

/**
 * Resolve the client PID from a TCP connection's remote port.
 * Works by querying OS-level socket-to-PID mappings.
 *
 * @param serverPort - The local server port (e.g. 3456)
 * @param remotePort - The client's ephemeral port from req.socket.remotePort
 * @returns The client process PID, or null if resolution fails
 */
export function getClientPid(serverPort: number, remotePort: number): number | null {
  try {
    const os = platform();
    let output: string;

    if (os === "darwin") {
      // macOS: lsof shows both sides of the connection; grep for the client side
      output = execSync(
        `lsof -nP -i :${serverPort} 2>/dev/null | grep ':${remotePort}->' | awk '{print $2}'`,
        { encoding: "utf-8", timeout: 1000 },
      );
    } else if (os === "linux") {
      // Linux: try ss first (faster, no extra install), fallback to lsof
      try {
        output = execSync(
          `ss -tnp 'sport = :${remotePort} and dport = :${serverPort}' 2>/dev/null | grep -oP 'pid=\\K[0-9]+'`,
          { encoding: "utf-8", timeout: 1000 },
        );
      } catch {
        output = execSync(
          `lsof -nP -i :${serverPort} 2>/dev/null | grep ':${remotePort}->' | awk '{print $2}'`,
          { encoding: "utf-8", timeout: 1000 },
        );
      }
    } else {
      return null;
    }

    const pid = parseInt(output.trim().split("\n")[0], 10);
    if (isNaN(pid) || pid <= 0) return null;
    log("info", `pid resolved: remote port ${remotePort} -> PID ${pid}`);
    return pid;
  } catch (e) {
    log("warn", `pid resolution failed for remote port ${remotePort} (${e instanceof Error ? e.message : "unknown"})`);
    return null;
  }
}

/**
 * Resolve client PID with a single retry after a short delay.
 * lsof/ss may not see brand-new connections immediately.
 */
export async function getClientPidWithRetry(serverPort: number, remotePort: number): Promise<number | null> {
  let pid = getClientPid(serverPort, remotePort);
  if (pid) return pid;

  // Retry once after delay - OS socket table may need time to reflect the connection
  await new Promise((r) => setTimeout(r, 200));
  pid = getClientPid(serverPort, remotePort);
  if (pid) log("info", `pid resolved on retry: remote port ${remotePort} -> PID ${pid}`);
  return pid;
}
