#!/usr/bin/env node
/**
 * PostToolUse:Edit,Write hook — marks a file as edited in the read tracker.
 *
 * When a file is edited, the next Read of that file is legitimate (verifying
 * the change), so we reset its editedSinceRead flag to true.
 *
 * Claude Code pipes the tool result as JSON to stdin:
 *   { "tool_name": "Edit", "tool_input": { "file_path": "..." }, "tool_response": ... }
 *
 * Exit 0 always — this hook is state-maintenance only.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TRACKER = path.join(
  os.homedir(),
  ".claude",
  "cost-analysis-read-tracker.json",
);

let raw = "";
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  try {
    const { tool_input } = JSON.parse(raw);
    // Edit uses file_path, NotebookEdit uses notebook_path
    const fp = tool_input?.file_path ?? tool_input?.notebook_path;
    if (!fp) {
      process.exit(0);
    }

    const tracker = JSON.parse(fs.readFileSync(TRACKER, "utf8"));
    if (tracker.reads[fp]) {
      tracker.reads[fp].editedSinceRead = true;
    }
    fs.writeFileSync(TRACKER, JSON.stringify(tracker, null, 2));
  } catch {
    /* non-fatal — tracker may not exist yet */
  }
  process.exit(0);
});
