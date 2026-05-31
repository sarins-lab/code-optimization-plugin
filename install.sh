#!/bin/sh
# install.sh — Install @sarins-lab/code-optimization-plugin for Claude Code
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sarins-lab/code-optimization-plugin/main/install.sh | sh
#   # or clone the repo and run:
#   sh install.sh

set -e

SETTINGS="$HOME/.claude/settings.json"

# Node is required (already present on any machine running Claude Code)
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required but not found on PATH." >&2
  exit 1
fi

mkdir -p "$HOME/.claude"

node <<EOF
const fs = require('fs');
const p = '$SETTINGS';

let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}

// Marketplace entry
s.extraKnownMarketplaces = s.extraKnownMarketplaces || {};
s.extraKnownMarketplaces['sarins-lab'] = {
  source: { source: 'github', repo: 'sarins-lab/code-optimization-plugin' }
};

// Enable plugin
s.enabledPlugins = s.enabledPlugins || {};
s['enabledPlugins']['code-optimization-plugin@sarins-lab'] = true;

// UserPromptSubmit hook — reminds Claude to use plugin tools for cost questions
s.hooks = s.hooks || {};
s.hooks['UserPromptSubmit'] = s.hooks['UserPromptSubmit'] || [];
const MATCHER = 'cost|token|optim|spend|usage|efficien|how much|waste|redundant|cache hit|session log|what did we';
const already = s.hooks['UserPromptSubmit'].some(h => h.matcher === MATCHER);
if (!already) {
  s.hooks['UserPromptSubmit'].push({
    matcher: MATCHER,
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
echo "  Restart Claude Code to activate the plugin."
echo ""
echo "  Tools available after restart:"
echo "    cost_summary · cost_trend · suggest_optimizations"
echo "    file_read_analysis · top_repeated_tasks · summarise"
