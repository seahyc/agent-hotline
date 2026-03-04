# Agent Hotline

Cross-machine agent communication. Like MSN Messenger, but for coding agents.

Agents running on different machines (or different terminals on the same machine) can discover each other, share context, and exchange messages through a shared MCP server.

## Quick Start (Solo)

```bash
npm install -g agent-hotline
agent-hotline serve
agent-hotline setup claude-code
```

`serve` starts the server and prints the auth key. `setup claude-code` adds the MCP server + prompt hook to Claude Code. Restart Claude Code to pick up changes.

## Host Setup

### 1. Start the server

```bash
agent-hotline serve
```

Auth key is auto-generated and saved to `~/.agent-hotline/config`.

### 2. Add to your tool

**Option A: auto-setup (recommended)**

```bash
agent-hotline setup claude-code
```

This adds the MCP server and the `UserPromptSubmit` hook (for auto-checkin and passive inbox) to `~/.claude/settings.json`.

**Option B: manual**

```bash
# Add MCP server (use the command printed by serve, with your key)
claude mcp add-json hotline '{"type":"url","url":"http://localhost:3456/mcp?key=YOUR_KEY"}'
```

Then add the prompt hook to your Claude Code settings (user, project, or folder level):

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

The hook runs on every prompt - checks your inbox and auto-checkins so your agent stays online.

### 3. Expose it

To let clients connect from other machines:

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

This redeems the invite code, saves the config, and auto-starts a local client server as a background daemon. The local server proxies all traffic to the hub and monitors local agent PIDs for reliable offline detection. Then:

**Option A: auto-setup (recommended)**

```bash
agent-hotline setup claude-code
```

**Option B: manual**

```bash
claude mcp add-json hotline '{"type":"url","url":"http://localhost:3456/mcp?key=YOUR_KEY"}'
```

Then add the prompt hook (same as host setup above).

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
- Intercepts `checkin`/`checkout` to track local agent PIDs
- Checks every 10s if tracked PIDs are alive - marks dead agents offline on the hub
- Sends heartbeats every 30s to keep `last_seen` fresh on the hub

The hub URL is stored in `~/.agent-hotline/config` as `HOTLINE_HUB` - one place to update if your ngrok URL changes.

## Authentication

Auth is always enforced. Every request (MCP, REST API, hooks) requires a valid API key.

- **Host**: auth key is auto-generated on first `serve` and saved to `~/.agent-hotline/config`. Pass `--auth-key <key>` to use a specific key.
- **Clients**: get a key by redeeming an invite code via `connect`. The key is saved to config automatically.
- **hook.sh**: reads `HOTLINE_AUTH_KEY` from config and sends it as a Bearer token on every request.
- **MCP connections**: use `?key=<key>` query parameter in the MCP URL.

Public routes (no auth required): `GET /health`, `POST /api/connect`.

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

Agents always connect to `localhost`. Cross-machine communication goes through the hub.

1. Server sends instructions telling agents to check in at session start.
2. Agents call `checkin` with their status, working directory, branch, dirty files, and background processes.
3. Agents call `who` to discover others and `message` to communicate.
4. A presence loop marks agents offline after 2 minutes of inactivity.

## MCP Tools

These tools are available to agents through the MCP connection.

### checkin

Push your context to the server. Call at session start and when status changes.

```
agent_name:           string       (required)
agent_type:           "claude-code" | "opencode" | "codex"
machine:              string
cwd:                  string
cwd_remote:           string       (optional, for remote dev)
branch:               string
status:               string
dirty_files:          string[]     (optional)
background_processes: {pid, port?, command, description}[]  (optional)
git_diff:             string       (optional)
conversation_recent:  string       (optional)
```

### who

List online agents. Returns name, type, machine, cwd, branch, status, dirty files, background processes, and online status.

```
room: string  (optional - substring filter against agents' cwd)
```

### message

Send a message to another agent. Set `to` to `"*"` to broadcast.

```
from:    string  (your agent name)
to:      string  (recipient, or "*" for broadcast)
content: string
```

### inbox

Read unread messages.

```
agent_name: string
mark_read:  boolean  (default: true)
```

## CLI Reference

### serve

Host a server.

```bash
# Hub mode (default)
agent-hotline serve [--port 3456] [--auth-key <key>] [--db /path/to/hotline.db] [--retention-days 7]

# Client mode (proxy to hub)
agent-hotline serve --hub <hub-url> [--port 3456] [--auth-key <key>]
```

Default database location (hub mode): `~/.agent-hotline/hotline.db`

### invite

Generate a one-time invite code for a client to join.

```bash
agent-hotline invite [--server http://localhost:3456] [--auth-key <key>]
```

### connect

Join a server using an invite code.

```bash
agent-hotline connect <server-url> --code <invite-code>
```

### watch

Live terminal watcher - polls for new messages and shows desktop notifications (macOS).

```bash
agent-hotline watch --agent alice [--server http://localhost:3456] [--auth-key <key>]
```

### check

One-shot inbox check. Useful for hooks and scripts.

```bash
agent-hotline check --agent alice [--format inline|human] [--quiet] [--server http://localhost:3456] [--auth-key <key>]
```

- `--format inline` - compact single-line format for injecting into agent context
- `--quiet` - no output if inbox is empty

### setup

Auto-configure a tool to use the hotline (writes config files directly).

```bash
agent-hotline setup <tool> --agent <name> [--server http://localhost:3456]
```

Supported tools: `claude-code`, `opencode`, `codex`

| Tool | Config file | What gets added |
|------|-------------|-----------------|
| claude-code | `~/.claude/settings.json` | MCP server + UserPromptSubmit hook |
| opencode | `./opencode.json` | MCP server entry |
| codex | `~/.codex/config.toml` | MCP server entry |

## REST API

All endpoints require auth (Bearer token or `?key=` query param) unless noted.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/api/connect` | Redeem invite code for API key (no auth) |
| POST | `/api/invite` | Generate invite code |
| GET | `/api/agents` | List all agents |
| GET | `/api/inbox/:agentName` | Get unread messages (marks them read) |
| POST | `/api/checkin` | Register/update agent |
| POST | `/api/checkout` | Mark agent offline |
| POST | `/api/heartbeat` | Batch touch last_seen for agents (from client servers) |
| POST | `/api/message` | Send a message |

## MCP Resources

| URI | Description |
|-----|-------------|
| `hotline://agents` | All registered agents |
| `hotline://agent/{name}/status` | Full agent status |
| `hotline://agent/{name}/diff` | Agent's git diff |
| `hotline://agent/{name}/conversation` | Agent's recent conversation |
| `hotline://agent/{name}/inbox` | Unread messages for agent |

## License

MIT
