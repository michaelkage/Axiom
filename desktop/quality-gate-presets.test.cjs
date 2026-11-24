"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectQualityGatePresets } = require("./quality-gate-presets.cjs");

test("detects JavaScript scripts and respects the repository package manager", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-quality-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" } }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const result = detectQualityGatePresets(root, ["src/app.ts"]);
    assert.deepEqual(result.commands.map(item => item.name), ["JavaScript/TypeScript lint", "TypeScript type check", "Project build"]);
    assert.equal(result.commands[0].command, "pnpm");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("detects Rust and Python checks from their project manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-quality-"));
  try {
    await fs.writeFile(path.join(root, "Cargo.toml"), "[workspace]");
    await fs.writeFile(path.join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n[tool.ruff]");
    await fs.mkdir(path.join(root, "tests"));
    const rust = detectQualityGatePresets(root, ["src/lib.rs"]);
    assert.deepEqual(rust.commands.map(item => item.name), ["Rust workspace tests", "Rust Clippy"]);
    const python = detectQualityGatePresets(root, ["app/main.py"]);
    assert.deepEqual(python.commands.map(item => item.name), ["Python tests", "Python Ruff lint"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("suggests Android atest without executing it outside an Android build environment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-quality-"));
  try {
    await fs.writeFile(path.join(root, "Android.bp"), "android_app { name: \"example\" }");
    const result = detectQualityGatePresets(root, ["app/MainActivity.kt"]);
    assert.equal(result.commands.length, 0);
    assert.equal(result.suggestions[0].command, "atest");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("does not follow symlinked project manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-quality-"));
  const outside = path.join(root, "outside-package.json");
  try {
    await fs.writeFile(outside, JSON.stringify({ scripts: { lint: "echo unsafe" } }));
    await fs.symlink(outside, path.join(root, "package.json"));
    const result = detectQualityGatePresets(root, ["src/app.ts"]);
    assert.equal(result.commands.length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
