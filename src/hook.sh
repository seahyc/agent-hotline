#!/bin/bash
# Agent Hotline hook - runs on every UserPromptSubmit
# Optimized: ~30ms server up, ~5ms server down
#
# Usage: HOTLINE_AGENT=name HOTLINE_SERVER=url bash hook.sh

AGENT="${HOTLINE_AGENT:-my-agent}"
SERVER="${HOTLINE_SERVER:-http://localhost:3456}"

# Check inbox first (if this fails, server is down - bail)
MSGS=$(curl -sf --connect-timeout 0.15 --max-time 0.5 "$SERVER/api/inbox/$AGENT" 2>/dev/null) || exit 0

# Print messages if any (avoid jq spawn for empty inbox)
if [ -n "$MSGS" ] && [ "$MSGS" != "[]" ]; then
  echo "$MSGS" | jq -r '.[] | "[\(.from_agent)] \(.content)"' 2>/dev/null
fi

# Checkin in background (don't block the prompt)
{
  CWD="$(pwd)"
  BRANCH="$(git branch --show-current 2>/dev/null)"
  REMOTE="$(git remote get-url origin 2>/dev/null)"
  DIRTY=$(git diff --name-only 2>/dev/null; git diff --staged --name-only 2>/dev/null)
  DIRTY_JSON="[]"
  if [ -n "$DIRTY" ]; then
    DIRTY_JSON=$(printf '%s\n' "$DIRTY" | sort -u | jq -Rsc 'split("\n") | map(select(. != ""))')
  fi
  curl -sf --connect-timeout 0.5 --max-time 2 \
    -X POST "$SERVER/api/checkin" \
    -H "Content-Type: application/json" \
    -d "{\"agent_name\":\"$AGENT\",\"agent_type\":\"claude-code\",\"machine\":\"$(hostname -s)\",\"cwd\":\"$CWD\",\"branch\":\"${BRANCH:-unknown}\",\"cwd_remote\":\"$REMOTE\",\"dirty_files\":$DIRTY_JSON}" \
    >/dev/null 2>&1
} &

# Don't wait for background checkin - let prompt proceed immediately
exit 0
