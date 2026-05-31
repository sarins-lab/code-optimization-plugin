#!/usr/bin/env node
/**
 * Lab Analysis MCP Server (stdio)
 * Tools: suggest_optimizations | top_repeated_tasks | file_read_analysis | cost_summary | cost_trend | summarise
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const { version: SERVER_VERSION } = JSON.parse(
  fs.readFileSync(path.join(fileURLToPath(import.meta.url), "..", "..", "package.json"), "utf8")
);

// ─── State persistence (snapshot per tool for vsLastRun / summarise) ──────────

const STATE_FILE = path.join(os.homedir(), ".claude", "lab-analysis-state.json");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function getSnapshot(toolName) {
  return loadState()[toolName] ?? null;
}

function setSnapshot(toolName, data) {
  const state = loadState();
  state[toolName] = { timestamp: new Date().toISOString(), data };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Compute delta between current and previous snapshot values.
// Returns { delta, pct, improved } for each shared numeric key.
function diffSnapshots(current, previous, lowerBetterKeys = []) {
  const out = {};
  for (const key of Object.keys(current)) {
    const cur = current[key], prv = previous?.[key];
    if (typeof cur !== "number" || typeof prv !== "number") continue;
    const delta = cur - prv;
    const pct = prv !== 0 ? Math.round((delta / prv) * 1000) / 10 : null;
    const lowerBetter = lowerBetterKeys.includes(key);
    const improved = lowerBetter ? delta < 0 : delta > 0;
    out[key] = { prev: prv, cur, delta, pct, improved };
  }
  return out;
}

// ─── MCP transport ────────────────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "suggest_optimizations",
    description:
      "Analyses JSONL transcripts and returns prioritised optimisation suggestions: repeated reads, rework loops, large-context turns, tool balance.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project slug (e.g. D--github-project-lab-setup). Omit to analyse all projects.",
        },
      },
    },
  },
  {
    name: "top_repeated_tasks",
    description:
      "Finds the top-N repeated task patterns across sessions using bigram clustering on human messages.",
    inputSchema: {
      type: "object",
      properties: {
        n: {
          type: "number",
          description: "How many tasks to return (default 10).",
        },
        project: {
          type: "string",
          description: "Project slug. Omit for all projects.",
        },
      },
    },
  },
  {
    name: "file_read_analysis",
    description:
      "Shows which files are read most, how many reads are redundant within a session, and whether re-reads follow edits.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project slug. Omit for all projects.",
        },
      },
    },
  },
  {
    name: "cost_summary",
    description:
      "Actual token usage from usage fields in the JSONL — by session, date, and grand total. Breaks out input / cache_write / cache_read / output.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Rolling window in days (default 30).",
        },
        project: {
          type: "string",
          description: "Project slug. Omit for all projects.",
        },
      },
    },
  },
  {
    name: "summarise",
    description:
      "Computes a before/after health report against the last time summarise was called. Pure computation — no LLM. Returns verdict (IMPROVING/DECLINING/MIXED), what went well, what needs work, and stable metrics. Other tools also show vsLastRun deltas each time they are called.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project slug. Omit for all projects.",
        },
      },
    },
  },
  {
    name: "cost_trend",
    description:
      "Week-over-week token and waste comparison. Use this to answer 'how much cost optimization did we achieve?' — returns per-week totals, deltas, and percentage changes for tokens, redundant reads, large-context turns, and fix loops.",
    inputSchema: {
      type: "object",
      properties: {
        weeks: {
          type: "number",
          description: "Number of weeks of history to return (default 2).",
        },
        project: {
          type: "string",
          description: "Project slug. Omit for all projects.",
        },
      },
    },
  },
];

// ─── JSONL loading ────────────────────────────────────────────────────────────

function loadSessions(projectFilter) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  const sessions = [];
  const slugs = fs.readdirSync(projectsDir).filter((slug) => {
    const full = path.join(projectsDir, slug);
    if (!fs.statSync(full).isDirectory()) return false;
    return projectFilter ? slug === projectFilter : true;
  });

  for (const slug of slugs) {
    const slugDir = path.join(projectsDir, slug);
    for (const file of fs
      .readdirSync(slugDir)
      .filter((f) => f.endsWith(".jsonl"))) {
      const filePath = path.join(slugDir, file);
      try {
        const stat = fs.statSync(filePath);
        const lines = fs
          .readFileSync(filePath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean);
        const entries = lines.flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
        sessions.push({
          slug,
          sessionId: file.replace(".jsonl", ""),
          mtime: stat.mtime,
          entries,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return sessions;
}

// ─── Turn extraction ──────────────────────────────────────────────────────────

const SKIP = new Set(["attachment", "queue-operation", "mode", "last-prompt"]);

function extractTurns(session) {
  const turns = [];
  let cur = null;

  for (const e of session.entries) {
    if (SKIP.has(e.type)) continue;

    if (e.type === "user") {
      const content = e.message?.content;
      const isToolResult =
        Array.isArray(content) && content[0]?.type === "tool_result";
      if (!isToolResult) {
        if (cur) turns.push(cur);
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? (content.find((b) => b.type === "text")?.text ?? "")
              : "";
        cur = {
          humanMessage: text.slice(0, 300),
          toolCalls: [],
          lastText: "",
          usage: { input: 0, cache_creation: 0, cache_read: 0, output: 0 },
        };
      }
      continue;
    }

    if (e.type === "assistant" && cur) {
      const u = e.message?.usage;
      if (u) {
        cur.usage.input += u.input_tokens ?? 0;
        cur.usage.cache_creation += u.cache_creation_input_tokens ?? 0;
        cur.usage.cache_read += u.cache_read_input_tokens ?? 0;
        cur.usage.output += u.output_tokens ?? 0;
      }
      for (const block of Array.isArray(e.message?.content)
        ? e.message.content
        : []) {
        if (block.type === "tool_use")
          cur.toolCalls.push({ name: block.name, input: block.input ?? {} });
        if (block.type === "text") cur.lastText = block.text.slice(0, 200);
      }
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

function turnTotal(u) {
  return u.input + u.cache_creation + u.cache_read + u.output;
}

// ─── Shared metrics capture (last 7 days) ────────────────────────────────────
// Used by summarise and as the snapshot source for vsLastRun on all tools.

function captureMetrics(project) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sessions = loadSessions(project).filter((s) => s.mtime >= cutoff);

  let totalTokens = 0, cacheRead = 0, largeTurns = 0, fixLoops = 0;
  let readCount = 0, grepCount = 0, redundantReads = 0, totalTurns = 0;

  for (const session of sessions) {
    const turns = extractTurns(session);
    totalTurns += turns.length;
    const seen = {};
    for (const t of turns) {
      const tok = turnTotal(t.usage);
      totalTokens += tok;
      cacheRead += t.usage.cache_read;
      if (t.usage.cache_read > 100_000) largeTurns++;
      if (t.toolCalls.length > 8) fixLoops++;
      for (const tc of t.toolCalls) {
        if (tc.name === "Read") { readCount++; }
        if (tc.name === "Grep") { grepCount++; }
        if (tc.name === "Read" && tc.input.file_path) {
          if (seen[tc.input.file_path]) redundantReads++;
          seen[tc.input.file_path] = true;
        }
      }
    }
  }

  return {
    sessions: sessions.length,
    turns: totalTurns,
    totalTokens,
    cacheHitRatio: totalTokens > 0 ? Math.round((cacheRead / totalTokens) * 1000) / 10 : 0,
    redundantReads,
    largeTurns,
    fixLoops,
    readToGrepRatio: grepCount > 0 ? Math.round((readCount / grepCount) * 10) / 10 : readCount,
  };
}

// ─── Tool: suggest_optimizations ─────────────────────────────────────────────

function suggestOptimizations({ project } = {}) {
  const sessions = loadSessions(project);
  const allTurns = sessions.flatMap((s) => extractTurns(s));

  const suggestions = [];

  // 1. Cross-session file read frequency
  const xsReads = {};
  const redundantReads = {};

  for (const session of sessions) {
    const seen = {};
    for (const turn of extractTurns(session)) {
      for (const tc of turn.toolCalls) {
        if (tc.name !== "Read" || !tc.input.file_path) continue;
        const fp = tc.input.file_path;
        xsReads[fp] = (xsReads[fp] ?? 0) + 1;
        if (seen[fp]) redundantReads[fp] = (redundantReads[fp] ?? 0) + 1;
        seen[fp] = true;
      }
    }
  }

  const topFiles = Object.entries(xsReads)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topFiles.length) {
    suggestions.push({
      priority: "HIGH",
      category: "Repeated File Reads",
      finding: topFiles.map(([f, n]) => `${path.basename(f)} ×${n}`).join(", "),
      action:
        "Use Grep/offset reads for partial lookups. Read full files only once per session; reuse context already in window.",
    });
  }

  const totalRedundant = Object.values(redundantReads).reduce(
    (s, n) => s + n,
    0,
  );
  if (totalRedundant > 5) {
    suggestions.push({
      priority: "HIGH",
      category: "Intra-Session Redundant Reads",
      finding: `${totalRedundant} re-reads of files already in context (no edit between reads)`,
      action:
        "Do not re-read unless an edit was made. Verify with focused checks, not full rereads.",
    });
  }

  // 2. Large-context turns (cache_read > 100K)
  const largeTurns = allTurns.filter((t) => t.usage.cache_read > 100_000);
  if (largeTurns.length > 3) {
    const avg = Math.round(
      largeTurns.reduce((s, t) => s + t.usage.cache_read, 0) /
        largeTurns.length,
    );
    suggestions.push({
      priority: "MEDIUM",
      category: "Large Context Turns",
      finding: `${largeTurns.length} turns with >100K cache_read tokens (avg ${avg.toLocaleString()})`,
      action:
        "Use /compact when context grows large. Start fresh sessions for unrelated tasks.",
    });
  }

  // 3. High tool-call turns (likely retry/fix loops)
  const highToolTurns = allTurns.filter((t) => t.toolCalls.length > 8);
  if (highToolTurns.length > 2) {
    suggestions.push({
      priority: "MEDIUM",
      category: "Retry / Fix Loops",
      finding: `${highToolTurns.length} turns with >8 tool calls`,
      action:
        "Diagnose root cause before attempting fixes. Avoid blind retry loops.",
    });
  }

  // 4. Read vs Grep balance
  const toolCounts = {};
  for (const t of allTurns)
    for (const tc of t.toolCalls)
      toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
  const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);

  suggestions.push({
    priority: "INFO",
    category: "Tool Usage",
    finding: topTools
      .slice(0, 8)
      .map(([n, c]) => `${n}(${c})`)
      .join("  "),
    action:
      (toolCounts["Read"] ?? 0) > (toolCounts["Grep"] ?? 0) * 2
        ? "Read dominates over Grep — prefer Grep for symbol/pattern lookups."
        : "Read/Grep balance looks reasonable.",
  });

  const snap = {
    redundantReads: totalRedundant,
    largeTurns: largeTurns.length,
    fixLoops: highToolTurns.length,
    readToGrepRatio: Math.round(((toolCounts["Read"] ?? 0) / Math.max(toolCounts["Grep"] ?? 1, 1)) * 10) / 10,
  };
  const prev = getSnapshot("suggest_optimizations");
  setSnapshot("suggest_optimizations", snap);
  const vsLastRun = prev
    ? diffSnapshots(snap, prev.data, ["redundantReads", "largeTurns", "fixLoops", "readToGrepRatio"])
    : { note: "First run — baseline captured." };

  return {
    sessionsAnalyzed: sessions.length,
    turnsAnalyzed: allTurns.length,
    suggestions,
    vsLastRun,
  };
}

// ─── Tool: top_repeated_tasks ─────────────────────────────────────────────────

const STOP = new Set(
  "the a an and or to in for of is it this that with on at by from be was are we i you can do not have need how what why also let now will just".split(
    " ",
  ),
);

function topRepeatedTasks({ n = 10, project } = {}) {
  const sessions = loadSessions(project);
  const allTurns = sessions.flatMap((s) => extractTurns(s));

  const counts = {},
    tokens = {},
    examples = {};

  for (const turn of allTurns) {
    const msg = turn.humanMessage;
    if (!msg) continue;
    const words = msg
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w));
    const total = turnTotal(turn.usage);
    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`;
      counts[bg] = (counts[bg] ?? 0) + 1;
      tokens[bg] = (tokens[bg] ?? 0) + total;
      if (!examples[bg]) examples[bg] = msg.slice(0, 120);
    }
  }

  const tasks = Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([phrase, count]) => ({
      phrase,
      occurrences: count,
      totalTokens: tokens[phrase],
      avgTokensPerOccurrence: Math.round(tokens[phrase] / count),
      example: examples[phrase],
    }));

  return { totalTurns: allTurns.length, topTasks: tasks };
}

// ─── Tool: file_read_analysis ─────────────────────────────────────────────────

function fileReadAnalysis({ project } = {}) {
  const sessions = loadSessions(project);

  const xsReads = {},
    redundant = {};
  let rereadAfterEdit = 0,
    rereadWithoutEdit = 0;

  for (const session of sessions) {
    const seen = {};
    let lastEdited = null;

    for (const turn of extractTurns(session)) {
      const editTargets = turn.toolCalls
        .filter((tc) => ["Edit", "Write", "MultiEdit"].includes(tc.name))
        .map((tc) => tc.input.file_path ?? tc.input.notebook_path)
        .filter(Boolean);
      if (editTargets.length) lastEdited = editTargets[editTargets.length - 1];

      for (const tc of turn.toolCalls) {
        if (tc.name !== "Read" || !tc.input.file_path) continue;
        const fp = tc.input.file_path;
        xsReads[fp] = (xsReads[fp] ?? 0) + 1;
        if (seen[fp]) {
          redundant[fp] = (redundant[fp] ?? 0) + 1;
          lastEdited === fp ? rereadAfterEdit++ : rereadWithoutEdit++;
        }
        seen[fp] = true;
      }
    }
  }

  const top = Object.entries(xsReads)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([file, reads]) => ({
      file: file.replace(os.homedir(), "~"),
      totalReads: reads,
      redundantInSession: redundant[file] ?? 0,
    }));

  const totalRedundant = Object.values(redundant).reduce((s, n) => s + n, 0);

  const recommendations = [];
  if (totalRedundant > 5)
    recommendations.push(
      `${totalRedundant} redundant re-reads detected. Re-read only after an edit to that file.`,
    );
  if (rereadWithoutEdit > rereadAfterEdit)
    recommendations.push(
      `${rereadWithoutEdit} re-reads had no prior edit to that file — likely unnecessary.`,
    );
  if (top[0]?.totalReads > 10)
    recommendations.push(
      `"${path.basename(top[0].file)}" read ${top[0].totalReads}× across sessions — load once at session start or use Grep for partial lookups.`,
    );

  const snap = { totalRedundant, rereadWithoutEdit, rereadAfterEdit };
  const prev = getSnapshot("file_read_analysis");
  setSnapshot("file_read_analysis", snap);
  const vsLastRun = prev
    ? diffSnapshots(snap, prev.data, ["totalRedundant", "rereadWithoutEdit", "rereadAfterEdit"])
    : { note: "First run — baseline captured." };

  return {
    topReadFiles: top,
    totalRedundantReads: totalRedundant,
    rereadAfterEdit,
    rereadWithoutEdit,
    recommendations,
    vsLastRun,
  };
}

// ─── Tool: cost_summary ───────────────────────────────────────────────────────

function costSummary({ days = 30, project } = {}) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sessions = loadSessions(project).filter((s) => s.mtime >= cutoff);

  const grand = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
  const bySession = [];

  for (const session of sessions) {
    const turns = extractTurns(session);
    const tot = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
    for (const t of turns) {
      tot.input += t.usage.input;
      tot.cache_creation += t.usage.cache_creation;
      tot.cache_read += t.usage.cache_read;
      tot.output += t.usage.output;
    }
    for (const k of Object.keys(grand)) grand[k] += tot[k];
    bySession.push({
      project: session.slug,
      sessionId: session.sessionId.slice(0, 8) + "…",
      date: session.mtime.toISOString().slice(0, 10),
      turns: turns.length,
      total: turnTotal(tot),
      ...tot,
    });
  }

  bySession.sort((a, b) => b.total - a.total);

  const grandTotal = turnTotal(grand);
  const snap = {
    totalTokens: grandTotal,
    sessions: sessions.length,
    cacheHitRatio: grandTotal > 0 ? Math.round((grand.cache_read / grandTotal) * 1000) / 10 : 0,
  };
  const prev = getSnapshot("cost_summary");
  setSnapshot("cost_summary", snap);
  const vsLastRun = prev
    ? diffSnapshots(snap, prev.data, ["totalTokens"])
    : { note: "First run — baseline captured." };

  return {
    periodDays: days,
    sessionsAnalyzed: sessions.length,
    grandTotal: { ...grand, total: grandTotal },
    topSessionsByTokens: bySession.slice(0, 10),
    vsLastRun,
  };
}

// ─── Tool: cost_trend ────────────────────────────────────────────────────────

function costTrend({ weeks = 2, project } = {}) {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const allSessions = loadSessions(project);

  // Build per-week buckets (week 0 = most recent)
  const buckets = Array.from({ length: weeks }, (_, i) => ({
    label: i === 0 ? "this_week" : i === 1 ? "last_week" : `${i}_weeks_ago`,
    start: new Date(now - (i + 1) * MS_PER_WEEK),
    end: new Date(now - i * MS_PER_WEEK),
    sessions: 0,
    turns: 0,
    tokens: { input: 0, cache_creation: 0, cache_read: 0, output: 0, total: 0 },
    redundantReads: 0,
    largeContextTurns: 0,
    fixLoopTurns: 0,
  }));

  for (const session of allSessions) {
    const bucket = buckets.find(
      (b) => session.mtime >= b.start && session.mtime < b.end,
    );
    if (!bucket) continue;

    bucket.sessions++;
    const turns = extractTurns(session);
    bucket.turns += turns.length;

    // Token totals
    for (const t of turns) {
      bucket.tokens.input += t.usage.input;
      bucket.tokens.cache_creation += t.usage.cache_creation;
      bucket.tokens.cache_read += t.usage.cache_read;
      bucket.tokens.output += t.usage.output;
      bucket.tokens.total += turnTotal(t.usage);
      if (t.usage.cache_read > 100_000) bucket.largeContextTurns++;
      if (t.toolCalls.length > 8) bucket.fixLoopTurns++;
    }

    // Redundant reads within this session
    const seen = {};
    for (const t of turns) {
      for (const tc of t.toolCalls) {
        if (tc.name !== "Read" || !tc.input.file_path) continue;
        const fp = tc.input.file_path;
        if (seen[fp]) bucket.redundantReads++;
        seen[fp] = true;
      }
    }
  }

  // Compute deltas between consecutive weeks (index 0 vs index 1, etc.)
  const weekData = buckets.map((b) => ({
    label: b.label,
    period: `${b.start.toISOString().slice(0, 10)} – ${b.end.toISOString().slice(0, 10)}`,
    sessions: b.sessions,
    turns: b.turns,
    totalTokens: b.tokens.total,
    cacheReadTokens: b.tokens.cache_read,
    cacheHitRatio:
      b.tokens.total > 0
        ? Math.round((b.tokens.cache_read / b.tokens.total) * 1000) / 10
        : null,
    redundantReads: b.redundantReads,
    largeContextTurns: b.largeContextTurns,
    fixLoopTurns: b.fixLoopTurns,
  }));

  // Delta: this_week vs last_week
  const delta =
    weekData.length >= 2
      ? (() => {
          const cur = weekData[0];
          const prev = weekData[1];
          const pct = (c, p) =>
            p === 0 ? null : Math.round(((c - p) / p) * 1000) / 10;
          return {
            totalTokens: {
              delta: cur.totalTokens - prev.totalTokens,
              pctChange: pct(cur.totalTokens, prev.totalTokens),
            },
            redundantReads: {
              delta: cur.redundantReads - prev.redundantReads,
              pctChange: pct(cur.redundantReads, prev.redundantReads),
            },
            largeContextTurns: {
              delta: cur.largeContextTurns - prev.largeContextTurns,
              pctChange: pct(cur.largeContextTurns, prev.largeContextTurns),
            },
            fixLoopTurns: {
              delta: cur.fixLoopTurns - prev.fixLoopTurns,
              pctChange: pct(cur.fixLoopTurns, prev.fixLoopTurns),
            },
            cacheHitRatio: {
              delta:
                cur.cacheHitRatio !== null && prev.cacheHitRatio !== null
                  ? Math.round((cur.cacheHitRatio - prev.cacheHitRatio) * 10) / 10
                  : null,
            },
            interpretation: (() => {
              const lines = [];
              if (pct(cur.totalTokens, prev.totalTokens) < 0)
                lines.push(`✓ Token usage down ${Math.abs(pct(cur.totalTokens, prev.totalTokens))}%`);
              else if (pct(cur.totalTokens, prev.totalTokens) > 0)
                lines.push(`✗ Token usage up ${pct(cur.totalTokens, prev.totalTokens)}%`);
              if (pct(cur.redundantReads, prev.redundantReads) < 0)
                lines.push(`✓ Redundant reads down ${Math.abs(pct(cur.redundantReads, prev.redundantReads))}%`);
              else if (pct(cur.redundantReads, prev.redundantReads) > 0)
                lines.push(`✗ Redundant reads up ${pct(cur.redundantReads, prev.redundantReads)}%`);
              if (pct(cur.largeContextTurns, prev.largeContextTurns) < 0)
                lines.push(`✓ Large-context turns down ${Math.abs(pct(cur.largeContextTurns, prev.largeContextTurns))}%`);
              if (pct(cur.fixLoopTurns, prev.fixLoopTurns) < 0)
                lines.push(`✓ Fix-loop turns down ${Math.abs(pct(cur.fixLoopTurns, prev.fixLoopTurns))}%`);
              return lines.length ? lines.join("; ") : "No significant change detected.";
            })(),
          };
        })()
      : null;

  return { weeks: weekData, delta };
}

// ─── Tool: summarise ─────────────────────────────────────────────────────────

const LOWER_BETTER = ["totalTokens", "redundantReads", "largeTurns", "fixLoops", "readToGrepRatio"];
const METRIC_LABELS = {
  totalTokens:     "Total tokens",
  cacheHitRatio:   "Cache hit ratio",
  redundantReads:  "Redundant reads",
  largeTurns:      "Large-context turns",
  fixLoops:        "Fix-loop turns",
  readToGrepRatio: "Read/Grep ratio",
};
const THRESHOLD = 0.05; // 5% change needed to count as improved/regressed

function summarise({ project } = {}) {
  const current = captureMetrics(project);
  const prev = getSnapshot("summarise");
  setSnapshot("summarise", current);

  if (!prev) {
    return {
      verdict: "BASELINE_SET",
      message: "No prior snapshot found. Baseline captured now — call summarise again later to see what improved.",
      baseline: current,
    };
  }

  const sinceMs = Date.now() - new Date(prev.timestamp).getTime();
  const sinceDays = Math.max(1, Math.round(sinceMs / (24 * 60 * 60 * 1000)));
  const sinceLastRun = sinceDays === 1 ? "1 day ago" : `${sinceDays} days ago`;

  const wentWell = [], needsWork = [], unchanged = [];

  for (const key of Object.keys(METRIC_LABELS)) {
    const cur = current[key], prv = prev.data[key];
    const label = METRIC_LABELS[key];
    if (prv == null || typeof prv !== "number") { unchanged.push(`${label}: no prior value`); continue; }
    if (prv === 0) { unchanged.push(`${label}: was 0, now ${cur}`); continue; }

    const pct = (cur - prv) / prv;
    const absPct = Math.round(Math.abs(pct) * 1000) / 10;
    const lowerBetter = LOWER_BETTER.includes(key);
    const improved  = lowerBetter ? pct < -THRESHOLD : pct >  THRESHOLD;
    const regressed = lowerBetter ? pct >  THRESHOLD : pct < -THRESHOLD;
    const arrow = cur < prv ? "↓" : cur > prv ? "↑" : "→";

    if      (improved)  wentWell.push( `${label}: ${arrow} ${absPct}%  (${prv} → ${cur})`);
    else if (regressed) needsWork.push(`${label}: ${arrow} ${absPct}%  (${prv} → ${cur})`);
    else                unchanged.push(`${label}: stable  (${cur})`);
  }

  const verdict =
    needsWork.length === 0 && wentWell.length > 0 ? "IMPROVING" :
    wentWell.length  === 0 && needsWork.length > 0 ? "DECLINING" :
    wentWell.length  >  needsWork.length           ? "MOSTLY_IMPROVING" :
    needsWork.length >  wentWell.length            ? "MOSTLY_DECLINING" : "MIXED";

  return { verdict, sinceLastRun, wentWell, needsWork, unchanged, current };
}

// ─── Request router ───────────────────────────────────────────────────────────

function handle(req) {
  const { id, method, params = {} } = req;
  if (method === "initialize") {
    return respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "lab-analysis", version: SERVER_VERSION },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") return respond(id, { tools: TOOLS });
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params;
    try {
      const fns = {
        suggest_optimizations: suggestOptimizations,
        top_repeated_tasks: topRepeatedTasks,
        file_read_analysis: fileReadAnalysis,
        cost_summary: costSummary,
        cost_trend: costTrend,
        summarise: summarise,
      };
      if (!fns[name]) return fail(id, -32601, `Unknown tool: ${name}`);
      const result = fns[name](args);
      return respond(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      return fail(id, -32603, e.message);
    }
  }
  fail(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  try {
    handle(JSON.parse(t));
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }
});
