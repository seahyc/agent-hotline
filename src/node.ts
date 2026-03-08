import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const CONFIG_DIR = join(homedir(), ".agent-hotline");
const NODE_ID_FILE = join(CONFIG_DIR, "node-id");

let cachedNodeId: string | null = null;
let logicalClock = 0;

/** Get or create a persistent node ID (UUID stored in ~/.agent-hotline/node-id). */
export function getNodeId(): string {
  if (cachedNodeId) return cachedNodeId;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (existsSync(NODE_ID_FILE)) {
    cachedNodeId = readFileSync(NODE_ID_FILE, "utf-8").trim();
    if (cachedNodeId) return cachedNodeId;
  }

  cachedNodeId = randomUUID();
  writeFileSync(NODE_ID_FILE, cachedNodeId, "utf-8");
  return cachedNodeId;
}

/** Increment and return the logical clock (for LWW ordering). */
export function tick(): number {
  return ++logicalClock;
}

/** Merge a remote clock value — advance local clock if remote is ahead. */
export function mergeClock(remote: number): void {
  if (remote > logicalClock) {
    logicalClock = remote;
  }
}

/** Get current clock value without incrementing. */
export function getClock(): number {
  return logicalClock;
}
