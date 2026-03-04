#!/bin/bash
# Agent Hotline hook - runs on every UserPromptSubmit
# Lightweight: inbox check + heartbeat only. Context is pulled by the server on demand.
#
# Config: ~/.agent-hotline/config (optional)
#   HOTLINE_SERVER=http://localhost:3456
#   HOTLINE_AUTH_KEY=your-api-key
#
# Usage in hooks (no hardcoded names or URLs):
#   "command": "bash ~/.agent-hotline/hook.sh"

# Load config if exists
[ -f ~/.agent-hotline/config ] && source ~/.agent-hotline/config

SERVER="${HOTLINE_SERVER:-http://localhost:3456}"

# Auth-aware curl wrapper
hotline_curl() {
  if [ -n "$HOTLINE_AUTH_KEY" ]; then
    curl -H "Authorization: Bearer $HOTLINE_AUTH_KEY" "$@"
  else
    curl "$@"
  fi
}

# Read stdin JSON (Claude Code passes {"session_id", "cwd", ...} on UserPromptSubmit)
STDIN_JSON=""
if read -t 0.01 -r STDIN_JSON 2>/dev/null; then
  HOOK_SESSION=$(echo "$STDIN_JSON" | jq -r '.session_id // empty' 2>/dev/null)
fi

# session_id is required - bail if not available
if [ -z "$HOOK_SESSION" ]; then
  exit 0
fi
AGENT="$HOOK_SESSION"

# Session/process metadata - use parent PID (the claude process) not our own
AGENT_PID=${PPID:-$$}

# Check inbox (doubles as server health check)
MSGS=$(hotline_curl -sf --connect-timeout 0.15 --max-time 0.5 "$SERVER/api/inbox/$AGENT" 2>/dev/null) || true

# Print messages if any (skip jq for empty inbox)
if [ -n "$MSGS" ] && [ "$MSGS" != "[]" ]; then
  echo "$MSGS" | jq -r '.[] | "[\(.from_agent)] \(.content)"' 2>/dev/null
fi

# Heartbeat: just session_id + PID. Server derives the rest on demand.
hotline_curl -sf --connect-timeout 0.2 --max-time 1 \
  -X POST "$SERVER/api/heartbeat" \
  -H "Content-Type: application/json" \
  -d "{\"session_id\":\"$AGENT\",\"pid\":$AGENT_PID}" \
  >/dev/null 2>&1 || true
