import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { copyHookScript } from "./hook.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

export function setupOpenCode(_agentName: string, serverUrl: string): void {
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
  console.log(`${CYAN}Add the prompt hook to your OpenCode settings:${RESET}`);
  console.log(`  ${DIM}keybinding or config depending on OpenCode version${RESET}`);
  console.log();
  console.log(`${CYAN}Then use the CLI (identity auto-resolved):${RESET}`);
  console.log(`  agent-hotline who       # who's online`);
  console.log(`  agent-hotline check     # read inbox`);
  console.log(`  agent-hotline send <agent> "hello"`);
  console.log();
}
