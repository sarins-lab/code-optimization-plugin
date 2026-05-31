#!/usr/bin/env node
/**
 * PreToolUse:Read hook — warns when a file is re-read without an intervening edit.
 *
 * Claude Code pipes the tool call as JSON to stdin:
 *   { "tool_name": "Read", "tool_input": { "file_path": "..." } }
 *
 * Any text written to stdout is injected as a system reminder before the tool runs.
 * Exit 0 always — this hook warns, it does not block.
 *
 * State: ~/.claude/cost-analysis-read-tracker.json
 *   Resets automatically when the last activity is >4 hours ago (new session heuristic).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TRACKER = path.join(
  os.homedir(),
  ".claude",
  "cost-analysis-read-tracker.json",
);
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours → treat as new session

function load() {
  try {
    const t = JSON.parse(fs.readFileSync(TRACKER, "utf8"));
    if (Date.now() - new Date(t.sessionStart).getTime() > SESSION_TTL_MS)
      return fresh();
    return t;
  } catch {
    return fresh();
  }
}

function fresh() {
  return { sessionStart: new Date().toISOString(), reads: {} };
}

function save(t) {
  try {
    fs.mkdirSync(path.dirname(TRACKER), { recursive: true });
    fs.writeFileSync(TRACKER, JSON.stringify(t, null, 2));
  } catch {
    /* non-fatal */
  }
}

let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  try {
    const { tool_input } = JSON.parse(raw);
    const fp = tool_input?.file_path;
    if (!fp) {
      process.exit(0);
    }

    const tracker = load();
    const entry = tracker.reads[fp];

    if (entry && !entry.editedSinceRead && entry.count > 0) {
      process.stdout.write(
        `⚠️  REDUNDANT READ: "${path.basename(fp)}" already in context ` +
          `(read ${entry.count}× this session, no edit since last read). ` +
          `Use Grep or codegraph for targeted lookups instead of re-reading the full file.`,
      );
    }

    tracker.reads[fp] = {
      count: (entry?.count ?? 0) + 1,
      editedSinceRead: false,
      lastRead: new Date().toISOString(),
    };
    save(tracker);
  } catch {
    /* never crash the hook */
  }
  process.exit(0);
});
