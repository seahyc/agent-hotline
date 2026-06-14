# Design: Scoped notifications & directory-derived rooms

**Date:** 2026-06-14
**Status:** Approved (pending spec review)

## Problem

After v0.4.0 (real-time push via `wait`, Stop-hook re-engagement), it *felt* like
every Claude Code session was being notified by every other agent. Scoping is actually
intact — DMs route to one recipient, room messages only to members. The real causes:

1. **Broadcast (`*`) is loud and easy.** A coordinator ran `send *`, which fans out an
   individual DM to every online agent (`server.ts:500-517`). The live DB showed one
   agent hitting 23 recipients at the same instant.
2. **The Stop hook blocks idle on *any* unread message** (`hook.sh:122-134`), so a single
   broadcast traps every session in "can't go idle" until handled.
3. **No middle ground between DM and machine-wide blast.** Same-project agents had no
   natural shared channel, so broadcast became the coordination tool.
4. **Cruft:** 8,265 stale agent rows (dead sessions, never purged) and truncated
   session-id phantoms polluting `room_members`.
5. **Over-built notify prefs.** A configurable per-agent / per-room notify-level system
   exists (`notify_prefs` table + `notify` CLI + `/api/notify` + a second vestigial
   `room_members.notify` column). In practice no agent ever changes it — it's complexity
   with no payoff, and the two stores don't even agree.

## Goals

- Make machine-wide broadcast deliberate.
- Re-engage agents only for messages actually addressed to them.
- Give same-project agents an automatic shared room, so cohorts coordinate without
  broadcasting.
- Keep the agent roster and room membership clean automatically.
- **Replace configurable notify prefs with one fixed, well-chosen default behavior**, and
  teach correct messaging etiquette in the agent skill instead of exposing knobs.

Non-goals (YAGNI): no per-agent notification configurability; no deep `resolveAgent`
rewrite; no manual room-management UI changes.

---

## Fixed notification model (replaces notify prefs)

No notify levels, no per-agent/per-room configuration. Behavior is hardcoded:

| Message kind                  | Inbox push + blocks idle? | Where it lives            |
|-------------------------------|---------------------------|---------------------------|
| **DM** (`send <agent>`)       | Yes                       | recipient inbox           |
| **Room msg, no `@`**          | No — nobody pinged        | room history only         |
| **Room msg, `@member`**       | Yes, **only @-ed members**| their inbox + room history|
| **Broadcast** (`send --all *`)| Delivered, but **no idle block** | every online inbox |

Members read non-mention room chatter on demand via `agent-hotline read --room <name>`
(`index.ts:839`) — it's a pull-based shared log. Only `@mentions` and DMs are push.

### Removal / cleanup
- Drop the `notify_prefs` table; delete `setNotifyPref`, `getNotifyPref`,
  `getGlobalNotifyPref`, `resolveNotifyLevel`.
- Remove the `notify` CLI command (`index.ts:890`) and the `POST /api/notify` endpoint.
- Drop the unused `room_members.notify` column and `getRoomMemberNotify`; `joinRoom`
  loses its `notify` parameter.

---

## Change 1 — Broadcast (`*`): opt-in only

**CLI** (`index.ts` send): add `--all` (alias `--force`). When sending to `*`, pass
`force: true` in the body.

**Server** (`server.ts` broadcast branch ~500-518):
- If `to === "*"` and not `force` → `400`: `"Broadcast to N agents needs --all. Use a
  #room or DM for targeted messages."` (N = online count excluding sender).
- When forced, deliver an inbox message to every online agent (except sender), tagged
  `msgType: "broadcast"`. No notify filtering (prefs are gone).
- Response: `{ ok, broadcast: count }`.

Broadcast messages do not block idle (see Stop hook), so a forced `*` reaches everyone
but surfaces on their next prompt rather than interrupting.

## Change 2 — Stop hook: re-engage only on DM / @mention

**`hook.sh` Stop case:**
- Fetch inbox with `?mark_read=false` (stop consuming messages just to check liveness;
  `UserPromptSubmit`/`SessionStart` surface + mark them).
- Partition via `jq`: blocking = messages where `.msg_type` is `direct` or `mention`.
  (Non-mention room messages never produce an inbox message; broadcasts are
  `msg_type=broadcast`.)
- If any blocking → print them to stderr, `exit 2`. Else `exit 0`.

## Change 3 — Room delivery: history + @mention only

**Server** (`server.ts` room branch ~466-496):
- Always `store.createRoomMessage(...)` for history.
- Deliver an inbox message (`msgType: "mention"`) + SSE notify **only** to resolved
  `@mentioned` ids that aren't the sender — whether or not they're room members.
- Remove the per-member fan-out loop and all `resolveNotifyLevel` calls.
- Sender still auto-joins the room (unchanged).

Net: posting to a room is quiet; tagging `@someone` pings exactly that someone.

## Change 4 — Purge stale agents & orphan members

**`store.ts`:**
- `purgeStaleAgents(maxAgeMs): number` → `DELETE FROM agents WHERE online = 0 AND
  last_seen < (now - maxAgeMs)`.
- `purgeOrphanRoomMembers(): number` → delete `room_members` rows whose `session_id`
  has no `agents` row (clears truncated-id phantoms; legit remote agents survive via
  `upsertRemoteAgent`).

**`presence.ts`:** in the existing hourly housekeeping block, also call
`purgeStaleAgents(24h)` + `purgeOrphanRoomMembers()`, logging counts. Initialize
`lastPurge = 0` so a one-time startup sweep clears the ~8,265 existing dead rows.

## Change 5 — Directory-derived rooms (recursive, git-aware)

### Core rule
On each heartbeat the server already refreshes the agent's `cwd` (async, off the request
path). From the cwd it computes a **directory chain** and ensures the agent is a member
of a room for every chain entry **shared by ≥2 live agents**. A room materializes only
when shared — no lonely single-occupant rooms, no global catch-all.

### Directory chain (recursion ceiling = outermost repo root)
- `cwd` → each ancestor dir → innermost repo root (`git -C <cwd> rev-parse
  --show-toplevel`)
- then across submodule boundaries via `git -C <dir> rev-parse
  --show-superproject-working-tree`, repeated until empty → each superproject root.
- **No git repo:** chain = `[cwd]` only (no ancestor climb — there is no project boundary
  to bound it; climbing would risk a `~` or `/` room).

Computed during context resolution (`context.ts`) and cached on the agent row (new
`dir_chain` JSON column) so reconciliation never triggers git storms.

### Membership = shared chain entries ("deepest common dir")
Desired auto-rooms for an agent = every directory in its chain that also appears in ≥1
other **live** agent's cached chain. Two agents meet at their deepest shared entry: same
subdir → deep room; different subdirs same repo → repo-root room; submodule agent +
superproject agent → superproject room.

### Room keys (cross-machine merge)
- Repo root → repo basename (e.g. `agent-hotline`).
- Subdir within a repo → `<repoBasename>/<path-relative-to-that-repo-root>` (e.g.
  `agent-hotline/src`).
- No-repo dir → absolute path (machine-local; does not merge across machines).

Repo-name + relative-path keys let the same project on two machines merge via gossip
(`mergeRooms`).

### Dynamic reconciliation (handles cwd changes mid-session)
- Add `room_members.source` column (`'manual'` default, `'auto'` for directory-rooms).
- `reconcileAutoRooms(sessionId, desiredRooms[])`: diff desired vs current `source='auto'`
  rows; join missing, leave stale. **Manual memberships are never touched.**
- Triggered (a) right after an agent's `dir_chain` is (re)resolved on heartbeat —
  reconciling the *whole online cohort* (`reconcileAllAutoRooms`), since a new arrival can
  cross the ≥2 threshold for agents already present, so they must converge immediately
  rather than waiting for the sweep — and (b) in the presence-loop tick (every 30s) as a
  backstop for departures. Both are idempotent.

### Why this is quiet by construction
With the fixed room model (Change 3), auto-rooms need no notify default: posting to a
project room never pings members; only an explicit `@agent` does. So a cohort can chatter
in its directory room without re-engaging anyone, and reach a specific teammate by name.

## Change 6 — Skill etiquette

Update the `agent-hotline` skill (`skills/agent-hotline/SKILL.md`) to teach correct usage now that
behavior is implicit:
- **DM** (`send <agent> …`) for a direct ask to one agent — always notifies them.
- **Room** (`send #room …`) to post to your project cohort — quiet; use it as the shared
  channel. Read with `read --room <name>`.
- **@mention** inside a room message to actually ping a specific member.
- **Broadcast** (`send --all * …`) only for genuine machine-wide announcements; it
  reaches everyone but does not interrupt them.
- Auto directory-rooms: you're placed in your project's room automatically; prefer it
  over broadcast for coordination.

---

## Affected files
- `src/context.ts` — return the repo-root/dir chain for a cwd.
- `src/store.ts` — `dir_chain` agent column; `room_members.source` column;
  `reconcileAutoRooms`, `purgeStaleAgents`, `purgeOrphanRoomMembers`; remove
  notify-pref functions + `room_members.notify`; document `"broadcast"` msg_type.
- `src/server.ts` — broadcast `--force` gating + `broadcast` tag; room branch →
  mention-only delivery; heartbeat → compute chain → reconcile; remove `/api/notify`.
- `src/presence.ts` — hourly stale/orphan purge + startup backfill; 30s auto-room
  reconcile pass.
- `src/index.ts` — `send --all/--force`; remove `notify` command.
- `src/hook.sh` — Stop hook: `mark_read=false` + block only on `direct`/`mention`.
- `skills/agent-hotline/SKILL.md` — messaging etiquette.

## Testing
- `server.test.ts`: broadcast rejected without `force`; forced broadcast delivers to all
  online tagged `broadcast`; room post with no `@` creates history but no inbox messages;
  room post with `@a` pings only `a`; heartbeat populates auto-rooms; two agents same
  repo share a room; submodule agent joins superproject room; cwd change reconciles
  (leaves stale, joins new); manual membership untouched by reconcile.
- `store.test.ts`: `purgeStaleAgents`, `purgeOrphanRoomMembers`, `reconcileAutoRooms`
  delta logic.
- `hook.sh`: manual verification (broadcast-only inbox → exit 0; DM/mention → exit 2;
  `mark_read=false` honored).

## Migrations
- `ALTER TABLE agents ADD COLUMN dir_chain TEXT DEFAULT '[]'` (guarded try/catch).
- `ALTER TABLE room_members ADD COLUMN source TEXT DEFAULT 'manual'`.
- `DROP TABLE IF EXISTS notify_prefs`.
- `room_members.notify` left in place but unused (SQLite column drop avoided for
  compatibility); code stops reading/writing it. `msg_type` unchanged (new value only).

## Rollback / safety
- Directory-rooms only add `source='auto'` memberships; `DELETE FROM room_members WHERE
  source='auto'` fully reverts, manual rooms intact.
- Broadcast gating is backward-incompatible for callers relying on bare `send *` —
  intentional, surfaced via a clear error.
- Removing notify prefs is one-way; acceptable since the feature is unused in practice.
