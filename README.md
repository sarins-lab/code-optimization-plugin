# Code Optimization Plugin

A Claude Code plugin that analyses your actual session transcripts (JSONL) to surface real token costs, waste patterns, and week-over-week improvement trends — no manual tracking required.

## Tools

1. `cost_summary`

   Actual token usage from JSONL transcripts, broken out by session, date, and grand total.
   - Input / cache_creation / cache_read / output tokens per session
   - Top sessions by total token consumption
   - Configurable rolling window (`days`, default 30)
   - Filter by `project` slug or across all projects

   **When to use:** "How many tokens did we use this week?" / "Which session was most expensive?"

2. `cost_trend`

   Week-over-week comparison of token usage and waste metrics.
   - Per-week totals: tokens, redundant reads, large-context turns, fix-loop turns, cache hit ratio
   - Delta and % change between this week and last week
   - Plain-English interpretation: `✓ Token usage down 18%` / `✗ Redundant reads up 12%`
   - Configurable number of weeks (`weeks`, default 2)

   **When to use:** "How much cost optimization did we achieve?" / "Are we improving week over week?"

3. `suggest_optimizations`

   Analyses transcripts and returns prioritised actionable suggestions.
   - **HIGH** — Repeated file reads (top files read across sessions)
   - **HIGH** — Intra-session redundant reads (re-reads with no edit between)
   - **MEDIUM** — Large-context turns (cache_read > 100K tokens)
   - **MEDIUM** — Retry/fix loops (turns with >8 tool calls)
   - **INFO** — Read vs Grep tool balance

   **When to use:** "What are the biggest waste patterns?" / "What should I fix first?"

4. `file_read_analysis`

   Deep-dive on file read behaviour across sessions.
   - Top 15 most-read files with redundant read counts
   - Total redundant reads, split by: re-read after edit (valid) vs re-read without edit (waste)
   - Targeted recommendations per file

   **When to use:** "Which files am I re-reading unnecessarily?" / "Is the redundant read problem getting better?"

5. `top_repeated_tasks`

   Finds recurring task patterns across sessions using bigram clustering on human messages.
   - Top-N phrase pairs by occurrence frequency
   - Token cost attributed to each repeated pattern
   - Example message for each cluster

   **When to use:** "What work keeps coming back?" / "What should we automate or template?"

6. `summarise`

   Pure-computation before/after health report against the last time `summarise` was called. No LLM involved — all classification is rule-based with a 5% change threshold.
   - Verdict:
     - `IMPROVING`
     - `MOSTLY_IMPROVING`
     - `MIXED`
     - `MOSTLY_DECLINING`
     - `DECLINING`
     - `BASELINE_SET`
   - **Went well** — metrics that improved by >5% since last run
   - **Needs work** — metrics that regressed by >5%
   - **Unchanged** — stable metrics
   - Tracks: total tokens, cache hit ratio, redundant reads, large-context turns, fix-loop turns, Read/Grep ratio
   - Snapshot persisted to `~/.claude/lab-analysis-state.json` — survives across sessions

   > First call captures the baseline and returns `BASELINE_SET`. Subsequent calls compare against it.

**All other tools** (`cost_summary`, `suggest_optimizations`, `file_read_analysis`) also emit a `vsLastRun` field showing key deltas from their own previous call — same state file, per-tool snapshots.

**When to use:** "Are things better or worse than last time?" / End-of-week retrospective.

---

## Hooks

The plugin registers a `UserPromptSubmit` hook that fires whenever your message contains cost/token/efficiency keywords:

- `cost`
- `token`
- `optim`
- `spend`
- `usage`
- `efficien`
- `how much`
- `waste`
- `redundant`
- `cache hit`
- `session log`
- `what did we`

It injects a reminder to use the plugin tools before reading manual files.

---

## Installation

### Option a — One-Liner Installer (Recommended)

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/sarins-lab/code-optimization-plugin/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/sarins-lab/code-optimization-plugin/main/install.ps1 | iex
```

Both scripts automatically update `~/.claude/settings.json` with the marketplace entry, enable the plugin, and wire the cost-keyword reminder hook. Restart Claude Code after running.

---

### Option B — Manual Claude Code Marketplace

Add to `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "sarins-lab": {
    "source": { "source": "github", "repo": "sarins-lab/code-optimization-plugin" }
  }
},
"enabledPlugins": {
  "code-optimization-plugin@sarins-lab": true
}
```

### Option C — Direct MCP via Npm (no Marketplace Needed)

Add to your `.mcp.json` or Claude Code MCP settings:

```json
{
  "mcpServers": {
    "lab-analysis": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sarins-lab/code-optimization-plugin"]
    }
  }
}
```

Claude Code will pull the latest version from npm automatically on each start.

### Option D — from Within Claude Code (no Terminal Needed)

1. Open Claude Code
2. Run `/plugins` → Navigate to `Marketplace` tab → select **Add MarketPlace**
3. Enter: `sarins-lab/code-optimization-plugin`
4. Navigate to `Disover` tab and enable the plugin
5. Restart Claude Code

This is equivalent to Option B but done entirely inside Claude Code without editing any files.

---

## Adding New Tools

All tools live in `scripts/analysis-server.mjs`. To add a new tool:

1. Add the tool definition to the `TOOLS` array (name, description, inputSchema)
2. Implement the function — use `loadSessions(project)` and `extractTurns(session)` as the data layer
3. Register it in the `fns` map inside the request router
4. Bump the version in `package.json` and `.claude-plugin/plugin.json`
