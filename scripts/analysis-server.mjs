#!/usr/bin/env node
/**
 * Lab Analysis MCP Server (stdio)
 * Tools: suggest_optimizations | top_repeated_tasks | file_read_analysis | cost_summary
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";

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

  return {
    sessionsAnalyzed: sessions.length,
    turnsAnalyzed: allTurns.length,
    suggestions,
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

  return {
    topReadFiles: top,
    totalRedundantReads: totalRedundant,
    rereadAfterEdit,
    rereadWithoutEdit,
    recommendations,
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

  return {
    periodDays: days,
    sessionsAnalyzed: sessions.length,
    grandTotal: { ...grand, total: turnTotal(grand) },
    topSessionsByTokens: bySession.slice(0, 10),
  };
}

// ─── Request router ───────────────────────────────────────────────────────────

function handle(req) {
  const { id, method, params = {} } = req;
  if (method === "initialize") {
    return respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "lab-analysis", version: "1.0.0" },
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
