import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { copyHookScript } from "./hook.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

export function setupCodex(_agentName: string, serverUrl: string): void {
  const hotlineDir = join(homedir(), ".agent-hotline");

  copyHookScript();
  const configDst = join(hotlineDir, "config");
  if (!existsSync(configDst)) {
    if (!existsSync(hotlineDir)) mkdirSync(hotlineDir, { recursive: true });
    writeFileSync(configDst, `HOTLINE_SERVER=${serverUrl}\n`, "utf-8");
  }

  console.log(`${GREEN}${BOLD}Setup complete${RESET}`);
  console.log();
  console.log(`  Installed hook.sh to ${DIM}~/.agent-hotline/hook.sh${RESET}`);
  console.log(`  Config at ${DIM}~/.agent-hotline/config${RESET}`);
  console.log();
  console.log(`${CYAN}Codex has no session hooks — agents are auto-discovered by the server's`);
  console.log(`process scanner (within ~30s of starting) and named after their folder.${RESET}`);
  console.log();
  console.log(`${CYAN}Use the CLI (identity auto-resolved):${RESET}`);
  console.log(`  agent-hotline status    # server + identity + inbox`);
  console.log(`  agent-hotline who       # who's online`);
  console.log(`  agent-hotline send <agent> "hello"`);
  console.log(`  agent-hotline wait      # run in background; exits when a message arrives`);
  console.log();
}
