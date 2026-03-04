#!/bin/bash
# Agent Hotline hook - runs on every UserPromptSubmit
# Optimized: ~30ms server up, ~5ms server down
#
# Config: ~/.agent-hotline/config (optional)
#   HOTLINE_SERVER=http://localhost:3456
#   HOTLINE_AGENT=my-custom-name
#   HOTLINE_AUTH_KEY=your-api-key
#
# Agent name resolution (first match wins):
#   1. $HOTLINE_AGENT env var or config
#   2. tmux session name
#   3. basename of cwd
#
# Agent type detection:
#   $CLAUDECODE=1 -> claude-code
#   $CODEX=1      -> codex
#   else          -> unknown
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

# Read stdin JSON (Claude Code passes {"cwd": "..."} on UserPromptSubmit)
STDIN_JSON=""
if read -t 0.01 -r STDIN_JSON 2>/dev/null; then
  HOOK_CWD=$(echo "$STDIN_JSON" | jq -r '.cwd // empty' 2>/dev/null)
fi
CWD="${HOOK_CWD:-$(pwd)}"

# Resolve agent name
if [ -z "$HOTLINE_AGENT" ]; then
  if [ -n "$TMUX" ]; then
    HOTLINE_AGENT=$(tmux display-message -p '#S' 2>/dev/null)
  fi
fi
AGENT="${HOTLINE_AGENT:-$(basename "$CWD")}"

# Detect agent type
if [ -n "$CLAUDECODE" ]; then
  AGENT_TYPE="claude-code"
elif [ -n "$CODEX" ]; then
  AGENT_TYPE="codex"
else
  AGENT_TYPE="unknown"
fi

# Gather terminal metadata
TERMINAL_NAME=""
if [ -n "$TMUX" ]; then
  TERMINAL_NAME=$(tmux display-message -p '#S' 2>/dev/null)
elif [ -n "$TERM_PROGRAM" ]; then
  TERMINAL_NAME="$TERM_PROGRAM"
fi

# Session/process metadata - use parent PID (the claude process) not our own
AGENT_PID=${PPID:-$$}

# Check inbox first (doubles as server health check)
MSGS=$(hotline_curl -sf --connect-timeout 0.15 --max-time 0.5 "$SERVER/api/inbox/$AGENT" 2>/dev/null) || true

# Print messages if any (skip jq for empty inbox)
if [ -n "$MSGS" ] && [ "$MSGS" != "[]" ]; then
  echo "$MSGS" | jq -r '.[] | "[\(.from_agent)] \(.content)"' 2>/dev/null
fi

# Checkin synchronously (curl timeouts keep it fast; avoids orphan process issues)
BRANCH="$(git -C "$CWD" branch --show-current 2>/dev/null)"
REMOTE="$(git -C "$CWD" remote get-url origin 2>/dev/null)"
DIRTY=$(git -C "$CWD" diff --name-only 2>/dev/null; git -C "$CWD" diff --staged --name-only 2>/dev/null)
DIRTY_JSON="[]"
if [ -n "$DIRTY" ]; then
  DIRTY_JSON=$(printf '%s\n' "$DIRTY" | sort -u | jq -Rsc 'split("\n") | map(select(. != ""))')
fi
hotline_curl -sf --connect-timeout 0.2 --max-time 1 \
  -X POST "$SERVER/api/checkin" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"$AGENT\",\"agent_type\":\"$AGENT_TYPE\",\"machine\":\"$(hostname -s)\",\"cwd\":\"$CWD\",\"branch\":\"${BRANCH:-unknown}\",\"cwd_remote\":\"$REMOTE\",\"dirty_files\":$DIRTY_JSON,\"terminal\":\"$TERMINAL_NAME\",\"pid\":$AGENT_PID}" \
  >/dev/null 2>&1 || true
