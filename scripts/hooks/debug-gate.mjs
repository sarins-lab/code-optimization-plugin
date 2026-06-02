#!/usr/bin/env node
import process from "node:process";

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  process.stdout.write(
    "⛔ DEBUGGING TASK DETECTED — You MUST invoke the /diagnose skill before any tool calls. Your first action must be: Skill({ skill: diagnose }). Do not run Read/Grep/Bash until /diagnose has reproduced and minimised the issue."
  );
  process.exit(0);
});
