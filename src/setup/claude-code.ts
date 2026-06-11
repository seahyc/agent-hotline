import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { copyHookScript } from "./hook.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

const HOOK_COMMAND = "bash ~/.agent-hotline/hook.sh";
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;

interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command?: string }[];
}

/** Merge our hook into ~/.claude/settings.json for the given events. Idempotent. */
function installClaudeHooks(): { installed: string[]; error?: string } {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (e) {
      return { installed: [], error: `Could not parse ${settingsPath}: ${e}. Not modifying it.` };
    }
  } else {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
  }

  settings.hooks = settings.hooks ?? {};
  const installed: string[] = [];
  for (const event of HOOK_EVENTS) {
    const entries: HookEntry[] = settings.hooks[event] = settings.hooks[event] ?? [];
    const present = entries.some(e =>
      e.hooks?.some(h => h.command?.includes("agent-hotline/hook.sh")),
    );
    if (!present) {
      entries.push({ matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND }] });
      installed.push(event);
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return { installed };
}

export function setupClaudeCode(_agentName: string, serverUrl: string): void {
  const hotlineDir = join(homedir(), ".agent-hotline");

  // Install hook.sh and config
  copyHookScript();
  const configDst = join(hotlineDir, "config");
  if (!existsSync(configDst)) {
    if (!existsSync(hotlineDir)) mkdirSync(hotlineDir, { recursive: true });
    writeFileSync(configDst, `HOTLINE_SERVER=${serverUrl}\n`, "utf-8");
  }

  const { installed, error } = installClaudeHooks();

  console.log(`${GREEN}${BOLD}Setup complete${RESET}`);
  console.log();
  console.log(`  Installed hook.sh to ${DIM}~/.agent-hotline/hook.sh${RESET}`);
  console.log(`  Config at ${DIM}~/.agent-hotline/config${RESET}`);
  if (error) {
    console.log();
    console.log(`${RED}Could not update ~/.claude/settings.json automatically:${RESET} ${error}`);
    console.log(`${CYAN}Add the hooks manually for SessionStart, UserPromptSubmit, and Stop:${RESET}`);
    console.log(`  ${DIM}{"matcher":"","hooks":[{"type":"command","command":"${HOOK_COMMAND}"}]}${RESET}`);
  } else if (installed.length > 0) {
    console.log(`  Added hooks to ${DIM}~/.claude/settings.json${RESET}: ${installed.join(", ")}`);
  } else {
    console.log(`  Hooks already present in ${DIM}~/.claude/settings.json${RESET}`);
  }
  console.log();
  console.log(`${CYAN}Restart Claude Code, then agents register and get named automatically.${RESET}`);
  console.log(`  agent-hotline status    # server + identity + inbox at a glance`);
  console.log(`  agent-hotline who       # who's online`);
  console.log(`  agent-hotline send <agent> "hello"`);
  console.log();
}
