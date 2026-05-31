#!/usr/bin/env node
/**
 * Increments the patch segment of the semver in package.json and
 * .claude-plugin/plugin.json, keeping both in sync.
 *
 * Usage:
 *   node scripts/bump-version.mjs          # patch bump (default)
 *   node scripts/bump-version.mjs minor    # minor bump
 *   node scripts/bump-version.mjs major    # major bump
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const pkgPath = path.join(root, "package.json");
const pluginPath = path.join(root, ".claude-plugin", "plugin.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));

const segment = process.argv[2] ?? "patch";
let [major, minor, patch] = pkg.version.split(".").map(Number);

if (segment === "major") {
  major++;
  minor = 0;
  patch = 0;
} else if (segment === "minor") {
  minor++;
  patch = 0;
} else {
  patch++;
}

const prev = pkg.version;
const next = `${major}.${minor}.${patch}`;

pkg.version = next;
plugin.version = next;

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");

process.stdout.write(`version bumped: ${prev} → ${next}\n`);
