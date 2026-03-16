#!/bin/bash
set -euo pipefail

# ============================================================================
# Agent Launcher — spawns an isolated pi agent in a tmux session
# Usage: .pi/agents/launch.sh <agent-name>
# ============================================================================

AGENT_NAME="${1:?Usage: $0 <agent-name>}"
AGENT_NAME_LOWER="$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')"

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENT_DIR="$SCRIPT_DIR/$AGENT_NAME_LOWER"
HOME_DIR="$AGENT_DIR/home"

# ── Validate ─────────────────────────────────────────────────────────────────
if [ ! -d "$AGENT_DIR" ]; then
  echo "❌ Agent not found: $AGENT_DIR"
  echo "Available agents:"
  ls -d "$SCRIPT_DIR"/*/agent.json 2>/dev/null | xargs -I{} dirname {} | xargs -I{} basename {} || echo "  (none)"
  exit 1
fi

if [ ! -f "$AGENT_DIR/agent.json" ]; then
  echo "❌ Missing agent.json in $AGENT_DIR"
  exit 1
fi

if [ ! -f "$AGENT_DIR/SYSTEM.md" ]; then
  echo "❌ Missing SYSTEM.md in $AGENT_DIR"
  exit 1
fi

# ── Read agent config ────────────────────────────────────────────────────────
PROVIDER="$(jq -r '.provider' "$AGENT_DIR/agent.json")"
MODEL="$(jq -r '.model' "$AGENT_DIR/agent.json")"
THINKING="$(jq -r '.thinking' "$AGENT_DIR/agent.json")"
CUTOFF_PCT="$(jq -r '.context_cutoff_pct // empty' "$AGENT_DIR/agent.json")"
AGENT_EXT="$(jq -r '.agent_extension // true' "$AGENT_DIR/agent.json")"

# ── Prepare home directory ───────────────────────────────────────────────────
mkdir -p "$HOME_DIR"

# Copy auth for subscription access
if [ -f ~/.pi/agent/auth.json ]; then
  cp ~/.pi/agent/auth.json "$HOME_DIR/auth.json"
else
  echo "⚠️  ~/.pi/agent/auth.json not found — agent may not have subscription access"
fi

# Generate settings.json (compaction disabled — we use context cutoff instead)
cat > "$HOME_DIR/settings.json" << 'SETTINGS'
{
  "compaction": {
    "enabled": false
  }
}
SETTINGS

# Generate package.json from agent.json extensions list
EXTENSIONS_JSON="[]"
if [ "$AGENT_EXT" = "true" ]; then
  EXTENSIONS_JSON=$(jq -n --arg agent "$SCRIPT_DIR/agent" '[$agent]')
fi
# Merge with extensions from agent.json
AGENT_EXTENSIONS=$(jq -r '.extensions // [] | .[]' "$AGENT_DIR/agent.json" 2>/dev/null)
if [ -n "$AGENT_EXTENSIONS" ]; then
  while IFS= read -r ext; do
    EXTENSIONS_JSON=$(echo "$EXTENSIONS_JSON" | jq --arg e "$ext" '. + [$e]')
  done <<< "$AGENT_EXTENSIONS"
fi

jq -n --argjson exts "$EXTENSIONS_JSON" --arg name "$AGENT_NAME_LOWER-agent" \
  '{name: $name, keywords: ["pi-package"], pi: {extensions: $exts}}' \
  > "$HOME_DIR/package.json"

# ── Compose system prompt ────────────────────────────────────────────────────
PROMPT_FILE="/tmp/pi-agent-prompt-$AGENT_NAME_LOWER.md"

# SYSTEM.md is the complete, self-contained prompt
cat "$AGENT_DIR/SYSTEM.md" > "$PROMPT_FILE"

# Append mutable AGENTS.md if it exists
if [ -f "$AGENT_DIR/AGENTS.md" ]; then
  echo "" >> "$PROMPT_FILE"
  cat "$AGENT_DIR/AGENTS.md" >> "$PROMPT_FILE"
fi

# ── Launch ───────────────────────────────────────────────────────────────────
echo "🚀 Launching agent: $AGENT_NAME_LOWER"
echo "   Provider: $PROVIDER"
echo "   Model:    $MODEL"
echo "   Thinking: $THINKING"
echo "   Home:     $HOME_DIR"
echo "   Relay:    /tmp/pi-relay-$AGENT_NAME_LOWER.json"
echo ""

# Rename current tmux session to the agent name (if inside tmux)
if [ -n "${TMUX:-}" ]; then
  tmux rename-session "$AGENT_NAME_LOWER" 2>/dev/null || true
fi

# Set env vars and exec pi directly in current shell
# Run this from inside a tmux session — the launcher NEVER creates tmux sessions
export PI_CODING_AGENT_DIR="$HOME_DIR"
export AGENT_NAME="$AGENT_NAME_LOWER"
export PI_RELAY_ID="$AGENT_NAME_LOWER"
export AGENT_DIR="$AGENT_DIR"
export AGENTS_DIR="$SCRIPT_DIR"
${CUTOFF_PCT:+export CONTEXT_CUTOFF_PCT="$CUTOFF_PCT"}

cd "$PROJECT_ROOT"
exec pi --provider "$PROVIDER" --model "$MODEL" --thinking "$THINKING" \
  --no-extensions --no-skills --no-prompt-templates --no-themes \
  -e "$HOME_DIR" \
  --append-system-prompt "$PROMPT_FILE"
