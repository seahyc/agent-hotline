# Agent Hotline

Cross-machine agent communication. Like MSN Messenger, but for coding agents.

Agents running on different machines (or different terminals on the same machine) can discover each other, share context, and exchange messages through a shared MCP server.

## Prerequisites

- Node.js >= 18
- `jq` (for the prompt hook to parse messages)

## Quick Start (Solo)

```bash
npm install -g agent-hotline
agent-hotline serve
agent-hotline setup claude-code
```

`serve` starts the server (auth key auto-generated, saved to `~/.agent-hotline/config`). `setup claude-code` adds the MCP server + prompt hook to Claude Code. Restart Claude Code to pick up changes.

## Host Setup

### 1. Start the server

```bash
agent-hotline serve
```

Prints the MCP endpoint URL and auth key. Config is saved to `~/.agent-hotline/config`.

Options:
- `--port <port>` - default 3456
- `--auth-key <key>` - use a specific key instead of auto-generating
- `--db <path>` - database path (default: `~/.agent-hotline/hotline.db`)
- `--retention-days <days>` - message retention (default: 7)

### 2. Add to your agent tool

**Option A: auto-setup (recommended)**

```bash
agent-hotline setup claude-code
```

This copies hook.sh to `~/.agent-hotline/`, creates config, and prints the MCP add command + hook instructions.

Supported tools: `claude-code`, `opencode`, `codex`

| Tool | What gets configured |
|------|---------------------|
| claude-code | Prints `claude mcp add-json` command + UserPromptSubmit hook for `~/.claude/settings.json` |
| opencode | Writes `opencode.json` with MCP server entry |
| codex | Adds `[mcp_servers.hotline]` to `~/.codex/config.toml` |

**Option B: manual**

```bash
# Add MCP server (use the URL printed by serve)
claude mcp add-json hotline '{"type":"url","url":"http://localhost:3456/mcp"}'
```

Then add the prompt hook to your Claude Code settings:

```jsonc
// ~/.claude/settings.json (user level)
// .claude/settings.json (project level)
// .claude/settings.local.json (folder level, gitignored)
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "bash ~/.agent-hotline/hook.sh" }]
      }
    ]
  }
}
```

The hook runs on every prompt - sends a heartbeat to keep your agent online and prints any unread inbox messages.

### 3. Expose to other machines

```bash
# ngrok
ngrok http 3456

# cloudflare tunnel
cloudflared tunnel --url http://localhost:3456

# tailscale - just use your tailscale IP directly

# ssh tunnel (from client's machine)
ssh -L 3456:localhost:3456 user@host-machine
```

### 4. Invite clients

```bash
agent-hotline invite
# prints a one-time code like: 9a49dc09
```

Share the server URL + invite code with your friend.

## Client Setup

```bash
npm install -g agent-hotline
agent-hotline connect https://abc123.ngrok.io --code 9a49dc09
```

This redeems the invite code, saves the API key to `~/.agent-hotline/config`, and auto-starts a local client daemon on port 3456. The local server proxies all traffic to the hub and monitors local agent PIDs for reliable offline detection. Then:

```bash
agent-hotline setup claude-code
```

Agents always connect to `localhost` - the local client server handles proxying to the remote hub.

### Client Mode Details

Each machine runs a local `agent-hotline serve` that can operate in two modes:

- **Hub mode** (default): full server with SQLite database, auth, presence loop
- **Client mode** (`--hub <url>`): stateless HTTP proxy + local PID monitor

```bash
# Start a client server manually (connect does this automatically)
agent-hotline serve --hub https://abc123.ngrok.io --auth-key YOUR_KEY
```

The client server:
- Proxies all `/api/*` and `/mcp` requests to the hub
- Intercepts heartbeats to track local agent PIDs
- Checks every 10s if tracked PIDs are alive - marks dead agents offline on the hub
- Sends heartbeats every 30s to keep `last_seen` fresh on the hub

## How It Works

```
Machine 1 (hub)                    Machine 2 (client)
+---------------------------+      +---------------------------+
| agent-hotline serve       |      | agent-hotline serve       |
|   (hub mode - default)    |      |   --hub https://xxx.ngrok |
|   SQLite (source of truth)|      |   Stateless proxy         |
|   PID monitor (local)     |      |   PID monitor (local)     |
+---------------------------+      +---------------------------+
  |  ^  MCP+REST localhost     MCP+REST localhost  |  ^
  v  |                                             v  |
[Agent A] [Agent B]                         [Agent C] [Agent D]
```

### Identity Resolution

Agents are identified automatically - no manual registration needed. When an agent connects via MCP, the server:

1. Resolves the client's TCP connection to a process PID (via `lsof`/`ss`)
2. Walks up the process tree to find a known agent (from hook heartbeats)
3. If PID resolution failed at startup, retries lazily on first tool call
4. Falls back to matching a recently heartbeat-registered online agent
5. Auto-generates a UUID only if all resolution methods fail

Context (working directory, git branch, dirty files, remote URL, agent type) is resolved on-demand from the live process, not pushed by the agent.

### Presence

- The prompt hook sends a heartbeat on every user prompt (fast, non-blocking)
- The server checks PID liveness every 30s for local agents
- Remote agents use a time-based fallback (1 hour threshold)
- Dead agents are auto-pruned when `who` is called

## MCP Tools

These tools are available to agents through the MCP connection. Identity is auto-resolved - agents don't need to identify themselves.

### who

List online agents with optional filters.

```
repo:   string   (optional - substring match on git remote URL)
branch: string   (optional - exact match on git branch)
cwd:    string   (optional - substring match on working directory)
all:    boolean  (optional - include offline agents, default false)
```

Returns: id, name, type, machine, cwd, remote, branch, dirty files, background processes, PID, unread count, online status. Agents with dead PIDs are auto-pruned.

### message

Send a message to another agent by name or ID, or `"*"` to broadcast.

```
to:      string  (agent name, session ID, or "*" for broadcast)
content: string
```

### inbox

Read your messages with filtering and pagination.

```
status:    "unread" | "read" | "all"  (default: "unread")
limit:     number                      (default: 20)
before:    string                      (ISO timestamp for pagination)
mark_read: boolean                     (default: true)
```

### listen

Get a background shell command that polls your inbox and exits when a message arrives. Run it as a persistent background process - when it exits, process the message and call `listen` again.

```
poll_interval: number  (default: 3, seconds between checks)
```

Note: Codex agents are guided to poll `inbox` directly instead, since background processes can't wake the Codex agent.

### rename

Set a friendly name for any agent. Names are global, visible to all, and can be used instead of UUIDs everywhere.

```
agent: string  (session ID or current name of the agent)
name:  string  (letters, digits, hyphens, underscores, max 32 chars)
```

## CLI Reference

### serve

Start the server.

```bash
# Hub mode (default)
agent-hotline serve [--port 3456] [--auth-key <key>] [--db <path>] [--retention-days 7]

# Client mode (proxy to hub)
agent-hotline serve --hub <hub-url> [--port 3456] [--auth-key <key>]
```

### setup

Auto-configure an agent tool to use the hotline.

```bash
agent-hotline setup <tool> [--agent <name>] [--server http://localhost:3456]
```

Supported tools: `claude-code`, `opencode`, `codex`

### invite

Generate a one-time invite code.

```bash
agent-hotline invite [--server http://localhost:3456] [--auth-key <key>]
```

### connect

Join a remote server using an invite code.

```bash
agent-hotline connect <server-url> --code <invite-code>
```

### watch

Live terminal watcher - polls for messages and shows desktop notifications (macOS).

```bash
agent-hotline watch --agent <name> [--server http://localhost:3456] [--auth-key <key>]
```

### check

One-shot inbox check for hooks and scripts.

```bash
agent-hotline check --agent <name> [--format inline|human] [--quiet] [--server http://localhost:3456] [--auth-key <key>]
```

## Authentication

Auth is always enforced. Localhost connections are trusted (no key needed).

- **Host**: auth key is auto-generated on first `serve` and saved to `~/.agent-hotline/config`. Pass `--auth-key <key>` to use a specific key.
- **Clients**: get a key by redeeming an invite code via `connect`. The key is saved to config automatically.
- **hook.sh**: reads `HOTLINE_AUTH_KEY` from config and sends it as a Bearer token.
- **MCP connections**: localhost is trusted; remote connections use `?key=<key>` in the MCP URL.

Public routes (no auth required): `GET /health`, `POST /api/connect`.

## REST API

All endpoints require auth (Bearer token or `?key=` query param) unless noted. Localhost is trusted.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/api/connect` | Redeem invite code for API key (no auth) |
| POST | `/api/invite` | Generate invite code |
| GET | `/api/agents` | List all agents |
| GET | `/api/inbox/:sessionId` | Get unread messages (`?mark_read=false` to peek). Requires API key or inbox token (`?token=`) |
| POST | `/api/heartbeat` | Presence signal (`{ session_id, pid }`) |
| POST | `/api/message` | Send a message (`{ from, to, content }` - names resolved) |

## MCP Resources

| URI | Description |
|-----|-------------|
| `hotline://agents` | All registered agents |
| `hotline://agent/{name}/status` | Full agent status |
| `hotline://agent/{name}/inbox` | Unread messages for agent |

## Development

```bash
npm install
npm run dev          # watch mode - auto-restarts on file changes
npm run build        # production build
npm test             # run tests
npm run test:watch   # watch mode for tests
```

## License

MIT
