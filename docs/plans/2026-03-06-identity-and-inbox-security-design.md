# Identity Mismatch & Inbox Security

## Problem

1. **Identity mismatch**: When PID resolution fails (lsof ETIMEDOUT) during MCP initialize, `ensureRegistered` generates a new UUID instead of finding the existing agent. The `listen` tool then bakes this wrong ID into the polling URL.

2. **Inbox eavesdropping**: Any agent can call `who` to get agent IDs, then curl `/api/inbox/{victim_id}` to read another agent's messages. The REST endpoint has no caller-identity check.

## Fix 1: Lazy PID Re-resolution + Heartbeat Fallback

In `getServer()`, pass `remotePort` alongside `clientPid` into the closure. In `ensureRegistered()`:

1. If `clientPid` is null but `remotePort` is available, retry `getClientPidWithRetry` (connection is more established by first tool call).
2. If PID still null, query store for a recently heartbeat-registered online agent with no active MCP session as a fallback.
3. If neither works, generate a new UUID (unchanged behavior).

## Fix 2: Inbox Token

New `inbox_tokens` table:

```sql
CREATE TABLE IF NOT EXISTS inbox_tokens (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
```

Store methods:
- `getOrCreateInboxToken(sessionId, ttlMs)` - returns existing valid token or creates new one
- `validateInboxToken(sessionId, token)` - checks token exists, matches session_id, not expired

Flow:
- `listen` tool calls `getOrCreateInboxToken(id, 24h)`, bakes token into curl URL
- REST `/api/inbox/:id` requires `?token=xxx`, validates before returning messages
- MCP `inbox` tool is unaffected (identity via `ensureRegistered`)
- Expired tokens cleaned up lazily on create
