# Design: Scoped notifications & directory-derived rooms

**Date:** 2026-06-14
**Status:** Approved (pending spec review)

## Problem

After v0.4.0 (real-time push via `wait`, Stop-hook re-engagement), it *felt* like
every Claude Code session was being notified by every other agent. Investigation
showed scoping is actually intact — DMs route to one recipient, room messages only
to members. The real causes:

1. **Broadcast (`*`) is loud and easy.** A coordinator agent ran `send *`, which the
   server fans out as an individual DM to every online agent (`server.ts:500-517`).
   The live DB showed one agent hitting 23 distinct recipients at the same instant.
2. **The Stop hook blocks idle on *any* unread message** (`hook.sh:122-134`), so a
   single broadcast traps every session in "can't go idle" until handled.
3. **No middle ground between DM and machine-wide blast.** Agents working the same
   project had no natural shared channel, so broadcast became the coordination tool.
4. **Cruft:** 8,265 stale agent rows (dead sessions, never purged) and truncated
   session-id phantoms polluting `room_members`.

## Goals

- Make machine-wide broadcast deliberate and respectful of recipient preferences.
- Re-engage agents only for messages that are actually for them.
- Give same-project agents an automatic shared room, so cohorts coordinate without
  broadcasting.
- Keep the agent roster and room membership clean automatically.

Non-goals (YAGNI): no deep `resolveAgent` rewrite; no manual room-management UI changes.

---

## Change 1 — Broadcast (`*`): opt-in + notify-aware

**CLI** (`index.ts` send): add `--all` (alias `--force`). When sending to `*`, pass
`force: true` in the POST body.

**Server** (`server.ts` broadcast branch ~500-518):
- If `to === "*"` and not `force` → `400`: `"Broadcast to N agents needs --all. Use a
  #room or DM for targeted messages."` (N = online count excluding sender).
- When forced, for each online agent compute `store.resolveNotifyLevel(sessionId, "*")`:
  - `mute` → skip
  - `mentions` → deliver only if @mentioned
  - `all` → deliver
- Tag each delivered message `msgType: "broadcast"` (column already exists; add
  `"broadcast"` to the documented value set).
- Response: `{ ok, broadcast: count, skipped }`.

Reuses existing notify machinery: `notify * mute` (or a global pref) permanently opts
an agent out of broadcasts, exactly like rooms.

## Change 2 — Stop hook: re-engage only on DM / @mention / room

**`hook.sh` Stop case:**
- Fetch inbox with `?mark_read=false` (stop consuming messages just to check liveness;
  the `UserPromptSubmit`/`SessionStart` hooks surface + mark them).
- Partition via `jq`: blocking = messages where `.msg_type != "broadcast"`.
- If any blocking → print them to stderr, `exit 2`. Else `exit 0` (broadcasts stay
  unread and surface on the next prompt).

Net: a `send --all` no longer traps sessions idle; DMs, mentions, and room messages
still re-engage. (Auto directory-rooms default to `notify: "mentions"`, so routine
project chatter doesn't block idle either — only @mentions do.)

## Change 3 — Purge stale agents & orphan members

**`store.ts`:**
- `purgeStaleAgents(maxAgeMs): number` → `DELETE FROM agents WHERE online = 0 AND
  last_seen < (now - maxAgeMs)`.
- `purgeOrphanRoomMembers(): number` → delete `room_members` rows whose `session_id`
  has no `agents` row (clears truncated-id phantoms; legit remote agents have rows via
  `upsertRemoteAgent`, so they survive).

**`presence.ts`:** in the existing hourly housekeeping block, also call
`purgeStaleAgents(24h)` and `purgeOrphanRoomMembers()`, logging counts. Run once at
startup (initialize `lastPurge = 0`) to backfill-clear the existing ~8,265 dead rows.

---

## Change 4 — Directory-derived rooms (recursive, git-aware)

### Core rule
On each heartbeat the server already refreshes the agent's `cwd` (async, off the
request path). From the cwd it computes a **directory chain**, then ensures the agent
is a member of a room for every chain entry **shared by ≥2 live agents**. A room only
materializes when shared — no lonely single-occupant rooms, no global catch-all.

### Directory chain
Built from the agent's cwd, bounded by the **outermost repo root** (the recursion
ceiling):
- `cwd` → each ancestor dir → innermost repo root (`git -C <cwd> rev-parse
  --show-toplevel`)
- then across submodule boundaries via `git -C <dir> rev-parse
  --show-superproject-working-tree`, repeated until empty → each superproject root.
- **No git repo:** chain = `[cwd]` only (no ancestor climb — there is no project
  boundary to bound it, and climbing would risk a `/Users/you` or `/` room).

The chain is computed during context resolution (`context.ts`) and cached on the agent
row (new `dir_chain` JSON column) so reconciliation never triggers git storms.

### Membership = shared chain entries ("deepest common dir")
Desired auto-rooms for an agent = every directory in its chain that also appears in ≥1
other **live** agent's cached chain. Two agents land together at their deepest shared
entry: same subdir → deep room; different subdirs same repo → repo-root room; submodule
agent + superproject agent → superproject room.

### Room keys (cross-machine merge)
- Repo root → repo basename (e.g. `agent-hotline`).
- Subdir within a repo → `<repoBasename>/<path-relative-to-that-repo-root>` (e.g.
  `agent-hotline/src`).
- No-repo dir → absolute path (machine-local; does not merge across machines).

Repo-name + relative-path keys let the same project on two machines merge via gossip
(`mergeRooms`), which is desirable.

### Dynamic reconciliation (handles cwd changes)
Membership is recomputed, not join-once:
- Add `room_members.source` column (`'manual'` default, `'auto'` for directory-rooms).
- `reconcileAutoRooms(sessionId, desiredRooms[])`: diff desired vs current `source='auto'`
  rows for that agent; join missing, leave stale. **Manual memberships are never
  touched.**
- Triggered (a) right after an agent's `dir_chain` is (re)resolved on heartbeat, and
  (b) in the presence-loop tick (every 30s) for the whole online set, so departures and
  moves are reflected promptly and idempotently.
- Auto-joined rooms default to `notify: "mentions"`.

### Interaction with other changes
- Broadcast becomes rarely-needed: project cohorts have a real room.
- Auto-room messages are room messages → they re-engage members, but the `"mentions"`
  default means only @mentions actually block idle.
- `purgeOrphanRoomMembers` + reconciliation shed auto-memberships when agents move/die.

---

## Affected files
- `src/context.ts` — return the repo-root/dir chain for a cwd.
- `src/store.ts` — `dir_chain` agent column; `room_members.source` column;
  `reconcileAutoRooms`, `purgeStaleAgents`, `purgeOrphanRoomMembers`; document
  `"broadcast"` msg_type.
- `src/server.ts` — broadcast `--force` gating + notify filter + `broadcast` tag;
  heartbeat → compute chain → reconcile.
- `src/presence.ts` — hourly stale/orphan purge + startup backfill; 30s auto-room
  reconcile pass.
- `src/index.ts` — `send --all/--force` flag.
- `src/hook.sh` — Stop hook: `mark_read=false` + filter `msg_type=broadcast`.

## Testing
- `server.test.ts`: broadcast rejected without `force`; muted recipient skipped;
  delivered broadcast tagged `broadcast`; heartbeat populates auto-rooms; two agents in
  the same repo share a room; submodule agent joins superproject room; cwd change
  reconciles (leaves stale, joins new); manual membership untouched by reconcile.
- `store.test.ts`: `purgeStaleAgents`, `purgeOrphanRoomMembers`, `reconcileAutoRooms`
  delta logic.
- `hook.sh`: manual verification with crafted inbox payloads (broadcast-only → exit 0;
  DM present → exit 2; `mark_read=false` honored).

## Migrations
- `ALTER TABLE agents ADD COLUMN dir_chain TEXT DEFAULT '[]'` (guarded try/catch like
  existing migrations).
- `ALTER TABLE room_members ADD COLUMN source TEXT DEFAULT 'manual'`.
- No change needed for `msg_type` (already migrated; new value only).

## Rollback / safety
- Directory-rooms only *add* `source='auto'` memberships and never touch manual rooms,
  so disabling the feature (skip reconcile) leaves manual rooms intact; a one-time
  `DELETE FROM room_members WHERE source='auto'` fully reverts.
- Broadcast gating is backward-incompatible for callers relying on bare `send *`; this
  is intentional and surfaced via a clear error message.
