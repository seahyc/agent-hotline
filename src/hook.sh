#!/bin/bash
# Agent Hotline hook — wired to Claude Code SessionStart, UserPromptSubmit, and Stop.
#
#   SessionStart      register immediately, capture tab title, greet the agent with
#                     its identity + unread messages (stdout becomes session context)
#   UserPromptSubmit  heartbeat + surface unread messages
#   Stop              if unread messages exist, block the stop (exit 2) so the agent
#                     handles them before going idle
#
# Config: ~/.agent-hotline/config (optional)
#   HOTLINE_SERVER=http://localhost:3456
#   HOTLINE_AUTH_KEY=your-api-key
#
# Failures are logged to ~/.agent-hotline/hook.log for debugging.

[ -f ~/.agent-hotline/config ] && source ~/.agent-hotline/config

SERVER="${HOTLINE_SERVER:-http://localhost:3456}"
HOOK_LOG=~/.agent-hotline/hook.log

hlog() {
  # Rotate at ~1MB so the log never grows unbounded
  if [ -f "$HOOK_LOG" ] && [ "$(wc -c < "$HOOK_LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv "$HOOK_LOG" "$HOOK_LOG.1" 2>/dev/null
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$HOOK_LOG" 2>/dev/null
}

hotline_curl() {
  if [ -n "$HOTLINE_AUTH_KEY" ]; then
    curl -H "Authorization: Bearer $HOTLINE_AUTH_KEY" "$@"
  else
    curl "$@"
  fi
}

# Claude Code passes hook input as JSON on stdin
STDIN_JSON=$(cat 2>/dev/null || true)
HOOK_SESSION=$(echo "$STDIN_JSON" | jq -r '.session_id // empty' 2>/dev/null)
EVENT=$(echo "$STDIN_JSON" | jq -r '.hook_event_name // empty' 2>/dev/null)
HOOK_CWD=$(echo "$STDIN_JSON" | jq -r '.cwd // empty' 2>/dev/null)

if [ -z "$HOOK_SESSION" ]; then
  exit 0
fi

# Parent PID is the claude process itself
AGENT_PID=${PPID:-$$}

# Capture the terminal tab name so the agent gets a legible identity.
# tmux works everywhere (incl. ssh/VMs); iTerm2 via AppleScript; Ghostty has no
# title-query API, so it falls back to folder-based naming server-side.
get_tab_title() {
  if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
    tmux display-message -p '#{window_name}' 2>/dev/null
    return
  fi
  if [ "$1" = "full" ] && [ -n "$ITERM_SESSION_ID" ] && command -v osascript >/dev/null 2>&1; then
    local sid="${ITERM_SESSION_ID#*:}"
    osascript 2>/dev/null <<EOS
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s contains "$sid" then return name of s
      end repeat
    end repeat
  end repeat
end tell
EOS
  fi
}

send_heartbeat() {
  local title="$1" max_time="$2"
  local payload
  payload=$(jq -cn \
    --arg sid "$HOOK_SESSION" \
    --arg title "$title" \
    --arg cwd "$HOOK_CWD" \
    --argjson pid "$AGENT_PID" \
    '{session_id:$sid, pid:$pid} + (if $title != "" then {title:$title} else {} end) + (if $cwd != "" then {cwd:$cwd} else {} end)' 2>/dev/null)
  hotline_curl -sf --connect-timeout 0.3 --max-time "$max_time" \
    -X POST "$SERVER/api/heartbeat" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null
}

print_inbox() {
  # Fetch unread (marks them read) and print one line per message
  local msgs
  msgs=$(hotline_curl -sf --connect-timeout 0.3 --max-time 2 "$SERVER/api/inbox/$HOOK_SESSION" 2>/dev/null) || return 1
  if [ -n "$msgs" ] && [ "$msgs" != "[]" ]; then
    echo "$msgs" | jq -r '.[] | "[agent-hotline msg from \(.from_agent)] \(.content)"' 2>/dev/null
    return 0
  fi
  return 1
}

case "$EVENT" in
  SessionStart)
    TITLE=$(get_tab_title full | head -1)
    HB=$(send_heartbeat "$TITLE" 3)
    if [ -z "$HB" ]; then
      hlog "SessionStart: heartbeat failed (server unreachable at $SERVER) session=$HOOK_SESSION"
      exit 0
    fi
    NAME=$(echo "$HB" | jq -r '.name // empty' 2>/dev/null)
    UNREAD=$(echo "$HB" | jq -r '.unread // 0' 2>/dev/null)
    ONLINE=$(echo "$HB" | jq -r '[.online[]? | (.name // .id[0:8]) + (if .machine then "@" + .machine else "" end)] | join(", ")' 2>/dev/null)

    echo "[agent-hotline] You are \"${NAME:-$HOOK_SESSION}\" on Agent Hotline (cross-machine agent chat)."
    if [ -n "$ONLINE" ]; then
      echo "[agent-hotline] Other agents online: $ONLINE"
    fi
    echo "[agent-hotline] Use: agent-hotline status | who | send <agent|#room|*> <msg> | check. To get woken on incoming messages, run 'agent-hotline wait' as a background task and re-arm it after each wake."
    if [ "${UNREAD:-0}" -gt 0 ] 2>/dev/null; then
      print_inbox
    fi
    ;;

  Stop)
    STOP_ACTIVE=$(echo "$STDIN_JSON" | jq -r '.stop_hook_active // false' 2>/dev/null)
    if [ "$STOP_ACTIVE" = "true" ]; then
      exit 0
    fi
    MSGS=$(hotline_curl -sf --connect-timeout 0.2 --max-time 1 "$SERVER/api/inbox/$HOOK_SESSION" 2>/dev/null) || exit 0
    if [ -n "$MSGS" ] && [ "$MSGS" != "[]" ]; then
      {
        echo "Agent Hotline messages arrived while you were working. Handle them now (reply with: agent-hotline send <agent> \"...\"):"
        echo "$MSGS" | jq -r '.[] | "[\(.from_agent)] \(.content)"' 2>/dev/null
      } >&2
      exit 2
    fi
    ;;

  *)
    # UserPromptSubmit (and any other event): surface inbox, heartbeat.
    # Keep timeouts tight — this runs on every prompt.
    print_inbox
    TITLE=$(get_tab_title | head -1)  # tmux only; osascript is too slow for every prompt
    send_heartbeat "$TITLE" 1 >/dev/null || hlog "$EVENT: heartbeat failed (server unreachable at $SERVER) session=$HOOK_SESSION"
    ;;
esac

exit 0
