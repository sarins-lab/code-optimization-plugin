#!/usr/bin/env node
/**
 * UserPromptSubmit hook — track turns and enforce /compact at turn 20.
 *
 * State: ~/.claude/cost-analysis-turn-counter.json
 * Resets on session TTL (4 hours). Also reset by cost_analysis reset tool.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const COUNTER_FILE = path.join(os.homedir(), ".claude", "cost-analysis-turn-counter.json");
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const COMPACT_THRESHOLD = 20;

function load() {
  try {
    const t = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
    if (Date.now() - new Date(t.sessionStart).getTime() > SESSION_TTL_MS) return fresh();
    return t;
  } catch {
    return fresh();
  }
}

function fresh() {
  return { sessionStart: new Date().toISOString(), turns: 0 };
}

function save(t) {
  try {
    fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(t, null, 2));
  } catch {}
}

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  const tracker = load();
  tracker.turns += 1;
  save(tracker);

  const n = tracker.turns;
  if (n >= COMPACT_THRESHOLD) {
    const tag = n >= 30 ? "🚨 CRITICAL" : "⚠️  MANDATORY";
    process.stdout.write(
      `${tag} — Turn ${n}. You MUST run /compact before responding. ` +
      `Do NOT answer the user first. Type /compact as your immediate next action. ` +
      `Context bloat multiplies cost 3-5× per turn beyond this point. ` +
      `This is non-negotiable — acknowledge with /compact only.`
    );
  }
  process.exit(0);
});
