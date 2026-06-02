#!/usr/bin/env node
/**
 * PreToolUse:Read hook
 *
 * On every Read:
 *   - First read of a file → gentle friction: suggest Grep/codegraph
 *   - Redundant read (no edit since last read) → hard directive: MUST use Grep/codegraph
 *
 * State: ~/.claude/cost-analysis-read-tracker.json
 * Resets when last activity is >4 hours ago (new session heuristic).
 * Override: call cost_analysis reset(target:"tracker") to clear tracker.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TRACKER = path.join(os.homedir(), ".claude", "cost-analysis-read-tracker.json");
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function load() {
  try {
    const t = JSON.parse(fs.readFileSync(TRACKER, "utf8"));
    if (Date.now() - new Date(t.sessionStart).getTime() > SESSION_TTL_MS) return fresh();
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
  } catch {}
}

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const { tool_input } = JSON.parse(raw);
    const fp = tool_input?.file_path;
    if (!fp) process.exit(0);

    const tracker = load();
    const entry = tracker.reads[fp];
    const name = path.basename(fp);

    if (entry && !entry.editedSinceRead && entry.count > 0) {
      process.stdout.write(
        `⛔ REDUNDANT READ — "${name}" already in context ` +
        `(read ${entry.count}× this session, no edit since last read). ` +
        `You MUST use Grep or codegraph_context instead. ` +
        `Only proceed if you truly need the full file. ` +
        `Run reset(target:"tracker") to silence this if re-read is intentional.`
      );
    } else {
      process.stdout.write(
        `💡 READ CHECK — "${name}": have you tried Grep or codegraph_context first? ` +
        `Read only if you need the full file content.`
      );
    }

    tracker.reads[fp] = {
      count: (entry?.count ?? 0) + 1,
      editedSinceRead: false,
      lastRead: new Date().toISOString(),
    };
    save(tracker);
  } catch {}
  process.exit(0);
});
