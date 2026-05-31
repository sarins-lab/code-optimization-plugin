# install.ps1 — Install @sarins-lab/code-optimization-plugin for Claude Code
#
# Usage (from PowerShell):
#   irm https://raw.githubusercontent.com/sarins-lab/code-optimization-plugin/main/install.ps1 | iex
#   # or clone the repo and run:
#   .\install.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Node is required (already present on any machine running Claude Code)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node is required but not found on PATH."
  exit 1
}

$ClaudeDir  = Join-Path $HOME ".claude"
$SettingsPath = Join-Path $ClaudeDir "settings.json"

New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null

# Use Node for JSON manipulation to avoid PowerShell JSON edge cases
$Script = @'
const fs = require('fs');
const p  = process.argv[1];

let s = {};
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}

// Marketplace entry
s.extraKnownMarketplaces = s.extraKnownMarketplaces || {};
s.extraKnownMarketplaces['sarins-lab'] = {
  source: { source: 'github', repo: 'sarins-lab/code-optimization-plugin' }
};

// Enable plugin
s.enabledPlugins = s.enabledPlugins || {};
s.enabledPlugins['code-optimization-plugin@sarins-lab'] = true;

// UserPromptSubmit hook
s.hooks = s.hooks || {};
s.hooks['UserPromptSubmit'] = s.hooks['UserPromptSubmit'] || [];
const MATCHER = 'cost|token|optim|spend|usage|efficien|how much|waste|redundant|cache hit|session log|what did we';
const already = s.hooks['UserPromptSubmit'].some(h => h.matcher === MATCHER);
if (!already) {
  s.hooks['UserPromptSubmit'].push({
    matcher: MATCHER,
    hooks: [{
      type: 'command',
      command: "node -e \"process.stdout.write('REMINDER: Answer cost/token/efficiency questions using the lab-analysis MCP plugin tools FIRST: cost_summary, suggest_optimizations, file_read_analysis, cost_trend, summarise. Do NOT read manual session logs or cost_tracking.md.');\""
    }]
  });
}

fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
'@

node -e $Script $SettingsPath

Write-Host ""
Write-Host "✓ code-optimization-plugin installed." -ForegroundColor Green
Write-Host "  Restart Claude Code to activate the plugin."
Write-Host ""
Write-Host "  Tools available after restart:"
Write-Host "    cost_summary · cost_trend · suggest_optimizations"
Write-Host "    file_read_analysis · top_repeated_tasks · summarise"
