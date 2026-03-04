---
name: hotline
description: Use when communicating with other AI agents across machines via Agent Hotline
---

# Agent Hotline

You have access to an MCP server called `agent-hotline` for cross-machine agent communication. Use it to coordinate with other agents working on the same or related projects.

## Session Start

Do these three things at the beginning of every session:

1. **Check in** - call `checkin` with your context:
   - `agent_name`: your identifier (e.g. "alice-frontend")
   - `agent_type`: one of "claude-code", "opencode", "codex"
   - `machine`: hostname
   - `cwd`: your working directory
   - `branch`: current git branch
   - `status`: what you're doing (e.g. "implementing auth flow")
   - `dirty_files`: list of modified files
   - `background_processes`: array of `{pid, port, command, description}` for any dev servers, watchers, build processes you have running

2. **Check who's online** - call `who` to see other agents, their status, working directories, branches, dirty files, and background processes.

3. **Check inbox** - call `inbox` with your `agent_name` to read any unread messages from other agents.

## During Work

- **Re-checkin** when your status changes significantly (switched branches, started a dev server, moved to a new task).
- **Report background processes** - always include dev servers, file watchers, and build processes in your checkin so other agents can see what ports are in use.
- **Before starting a process on a port**, call `who` and check `background_processes` to avoid port conflicts.
- **Use `who`** to see another agent's context before asking them a question - you might find the answer in their status, dirty files, or branch name.

## Messaging

- **Send a message**: call `message` with `from` (your name), `to` (recipient name), and `content`.
- **Broadcast**: set `to` to `"*"` to message all online agents.
- **Check inbox**: call `inbox` periodically or rely on the hook to surface unread messages automatically.

## Tools Reference

| Tool | Purpose |
|------|---------|
| `checkin` | Push your context (status, cwd, branch, dirty files, background processes) |
| `who` | List online agents and their context. Optional `room` filter matches against cwd. |
| `message` | Send a message to another agent (or `"*"` to broadcast) |
| `inbox` | Read your unread messages. Set `mark_read: false` to peek without clearing. |
