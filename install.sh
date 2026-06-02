#!/bin/sh
# install.sh — Install @sarins-lab/code-optimization-plugin for Claude Code
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sarins-lab/code-optimization-plugin/main/install.sh | sh
#   # or clone the repo and run:
#   sh install.sh

set -e

SETTINGS="$HOME/.claude/settings.json"
HOOKS_DIR="$HOME/.claude/hooks"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Node is required (already present on any machine running Claude Code)
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required but not found on PATH." >&2
  exit 1
fi

mkdir -p "$HOME/.claude"
mkdir -p "$HOOKS_DIR"

# Copy hook scripts to stable location referenced by settings.json
cp "$SCRIPT_DIR/scripts/hooks/pre-read.mjs"    "$HOOKS_DIR/pre-read.mjs"
cp "$SCRIPT_DIR/scripts/hooks/post-edit.mjs"   "$HOOKS_DIR/post-edit.mjs"
cp "$SCRIPT_DIR/scripts/hooks/turn-counter.mjs" "$HOOKS_DIR/turn-counter.mjs"

node <<EOF
const fs = require('fs');
const os = require('os');
const p = '$SETTINGS';
const hooksDir = os.homedir().replace(/\\\\/g, '/') + '/.claude/hooks';

let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}

// ── Marketplace + plugin ──────────────────────────────────────────────────
s.extraKnownMarketplaces = s.extraKnownMarketplaces || {};
s.extraKnownMarketplaces['sarins-lab'] = {
  source: { source: 'github', repo: 'sarins-lab/code-optimization-plugin' }
};
s.enabledPlugins = s.enabledPlugins || {};
s['enabledPlugins']['code-optimization-plugin@sarins-lab'] = true;

// ── Hooks ─────────────────────────────────────────────────────────────────
s.hooks = s.hooks || {};

// PreToolUse: Read — friction + redundant read detection
s.hooks['PreToolUse'] = s.hooks['PreToolUse'] || [];
const preReadExists = s.hooks['PreToolUse'].some(h => h.matcher === 'Read');
if (!preReadExists) {
  s.hooks['PreToolUse'].push({
    matcher: 'Read',
    hooks: [{ type: 'command', command: 'node "' + hooksDir + '/pre-read.mjs"' }]
  });
}

// PostToolUse: Edit|Write|MultiEdit — mark file as edited in tracker
s.hooks['PostToolUse'] = s.hooks['PostToolUse'] || [];
const postEditExists = s.hooks['PostToolUse'].some(h => h.matcher === 'Edit|Write|MultiEdit');
if (!postEditExists) {
  s.hooks['PostToolUse'].push({
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: 'node "' + hooksDir + '/post-edit.mjs"' }]
  });
}

s.hooks['UserPromptSubmit'] = s.hooks['UserPromptSubmit'] || [];

// UserPromptSubmit: turn counter — mandatory /compact at turn 20
const turnCounterExists = s.hooks['UserPromptSubmit'].some(h => h.matcher === '.*');
if (!turnCounterExists) {
  s.hooks['UserPromptSubmit'].push({
    matcher: '.*',
    hooks: [{ type: 'command', command: 'node "' + hooksDir + '/turn-counter.mjs"' }]
  });
}

// UserPromptSubmit: diagnose trigger
const DIAGNOSE_MATCHER = "is broken|isn't working|not working|doesn't work|keeps failing|throwing|throws an error|getting an error|seeing an error|weird behavior|unexpected behavior|can't figure out|what's wrong|debug this|diagnose this|bug in|regression|broken since|error in|failing test|test fails";
const diagnoseExists = s.hooks['UserPromptSubmit'].some(h => h.matcher === DIAGNOSE_MATCHER);
if (!diagnoseExists) {
  s.hooks['UserPromptSubmit'].push({
    matcher: DIAGNOSE_MATCHER,
    hooks: [{
      type: 'command',
      command: "node -e \"process.stdout.write('⛔ DEBUGGING TASK DETECTED — You MUST invoke the /diagnose skill before any tool calls. Your first action must be: Skill({ skill: \\\"diagnose\\\" }). Do not run Read/Grep/Bash until /diagnose has reproduced and minimised the issue.');\""
    }]
  });
}

// UserPromptSubmit: cost/efficiency reminder
const COST_MATCHER = 'cost|token|optim|spend|usage|efficien|how much|waste|redundant|cache hit|session log|what did we';
const costExists = s.hooks['UserPromptSubmit'].some(h => h.matcher === COST_MATCHER);
if (!costExists) {
  s.hooks['UserPromptSubmit'].push({
    matcher: COST_MATCHER,
    hooks: [{
      type: 'command',
      command: "node -e \"process.stdout.write('REMINDER: Answer cost/token/efficiency questions using the cost-analysis MCP plugin tools FIRST: cost_summary, suggest_optimizations, file_read_analysis, cost_trend, summarise. Do NOT read manual session logs or cost_tracking.md.');\""
    }]
  });
}

fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
EOF

echo ""
echo "✓ code-optimization-plugin installed."
echo "  Hook scripts installed to: $HOOKS_DIR"
echo "  Restart Claude Code to activate all hooks."
echo ""
echo "  Tools available after restart:"
echo "    cost_summary · cost_trend · suggest_optimizations"
echo "    file_read_analysis · top_repeated_tasks · summarise · reset"
echo ""
echo "  Active hooks:"
echo "    PreToolUse:Read           — friction + redundant read warning"
echo "    PostToolUse:Edit|Write    — mark file edited in tracker"
echo "    UserPromptSubmit (all)    — turn counter, /compact at turn 20"
echo "    UserPromptSubmit (debug)  — mandate /diagnose for bug reports"
echo "    UserPromptSubmit (cost)   — redirect to MCP plugin tools"
