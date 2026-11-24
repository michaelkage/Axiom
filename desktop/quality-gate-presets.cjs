"use strict";

const fs = require("node:fs");
const path = require("node:path");

function detectQualityGatePresets(workspaceRoot, changedPaths = []) {
  const root = path.resolve(workspaceRoot);
  const exists = relative => fs.existsSync(path.join(root, relative));
  const readJson = relative => {
    try { return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")); }
    catch { return null; }
  };
  const commands = [];
  const suggestions = [];
  const paths = Array.isArray(changedPaths) ? changedPaths.filter(value => typeof value === "string") : [];
  const changed = extension => paths.some(file => file.toLowerCase().endsWith(extension));
  const add = (name, command, args, timeout = 180000) => commands.push({ name, command, args, timeout });

  if (exists("package.json")) {
    const manifest = readJson("package.json");
    const scripts = manifest && manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
    const manager = exists("pnpm-lock.yaml") ? "pnpm" : exists("yarn.lock") ? "yarn" : exists("bun.lockb") || exists("bun.lock") ? "bun" : "npm";
    const runScript = (script, name, timeout) => {
      if (typeof scripts[script] !== "string" || !scripts[script].trim()) return;
      const command = manager === "npm" ? "npm" : manager;
      const args = manager === "npm" ? ["run", script] : ["run", script];
      add(name, command, args, timeout);
    };
    if (changed(".js") || changed(".jsx") || changed(".ts") || changed(".tsx")) {
      runScript("lint", "JavaScript/TypeScript lint", 180000);
      runScript("typecheck", "TypeScript type check", 180000);
      if (!scripts.typecheck) runScript("check", "Project check", 180000);
      if (scripts.build) runScript("build", "Project build", 240000);
    }
    if (paths.some(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))) {
      const testPaths = paths.filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && exists(file));
      if (testPaths.length && manager === "pnpm" && exists("node_modules/.bin/vitest")) add("Targeted unit tests", "pnpm", ["exec", "vitest", "run", ...testPaths], 180000);
      else if (testPaths.length && manager === "npm" && exists("node_modules/.bin/vitest")) add("Targeted unit tests", "npm", ["exec", "--", "vitest", "run", ...testPaths], 180000);
      else runScript("test", "Project tests", 240000);
    }
  }

  if (exists("Cargo.toml") && changed(".rs")) {
    add("Rust workspace tests", "cargo", ["test", "--workspace"], 300000);
    add("Rust Clippy", "cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], 300000);
  }

  if (exists("pyproject.toml") && changed(".py")) {
    let config = "";
    try { config = fs.readFileSync(path.join(root, "pyproject.toml"), "utf8"); } catch {}
    if (exists("tests") || paths.some(file => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(file))) {
      add("Python tests", "python", ["-m", "pytest"], 300000);
    } else if (/\[tool\.pytest(?:\.ini_options)?\]/.test(config)) {
      add("Python tests", "python", ["-m", "pytest"], 300000);
    }
    if (/\[tool\.ruff\]/.test(config) || exists("ruff.toml") || exists(".ruff.toml")) {
      add("Python Ruff lint", "ruff", ["check", "."], 180000);
    }
  }

  if (exists("Android.bp") && (changed(".java") || changed(".kt") || changed(".cpp") || changed(".h") || changed(".bp"))) {
    suggestions.push({ name: "Android build/tests", command: "atest", args: [], reason: "Android.bp detected. Run atest from an initialized Android build environment; Axiom does not assume that environment is installed." });
  }

  return { commands, suggestions };
}

module.exports = { detectQualityGatePresets };
