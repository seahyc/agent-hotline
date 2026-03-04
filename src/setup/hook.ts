import { existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Copy hook.sh to ~/.agent-hotline/hook.sh */
export function copyHookScript(): void {
  const hotlineDir = join(homedir(), ".agent-hotline");
  if (!existsSync(hotlineDir)) {
    mkdirSync(hotlineDir, { recursive: true });
  }
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const hookSrc = join(thisDir, "hook.sh");
  const hookSrcAlt = join(thisDir, "..", "hook.sh");
  const hookDst = join(hotlineDir, "hook.sh");

  if (existsSync(hookSrc)) {
    copyFileSync(hookSrc, hookDst);
    chmodSync(hookDst, 0o755);
  } else if (existsSync(hookSrcAlt)) {
    copyFileSync(hookSrcAlt, hookDst);
    chmodSync(hookDst, 0o755);
  }
}
