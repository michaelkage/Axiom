"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePluginManifest } = require("./plugin-runtime.cjs");

test("accepts a bounded manifest and canonicalizes capabilities", () => {
  const manifest = validatePluginManifest({ apiVersion: 1, id: "sample.plugin", name: "Sample", entry: "index.cjs", capabilities: ["project.read"], resources: { timeoutMs: 5000, memoryMb: 64 } });
  assert.equal(manifest.id, "sample.plugin");
  assert.deepEqual(manifest.capabilities, ["project.read"]);
});
test("rejects traversal, unknown capabilities and unbounded resources", () => {
  const base = { apiVersion: 1, id: "sample.plugin", name: "Sample", entry: "index.cjs", capabilities: [] };
  assert.throws(() => validatePluginManifest({ ...base, entry: "../index.cjs" }), /relative/);
  assert.throws(() => validatePluginManifest({ ...base, capabilities: ["filesystem.root"] }), /capabilities/);
  assert.throws(() => validatePluginManifest({ ...base, resources: { timeoutMs: 999999 } }), /resource/);
});


test("passes only authorized workspace capabilities into the sandbox boundary", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createPluginRuntime } = require("./plugin-runtime.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-runtime-"));
  const pluginRoot = path.join(root, "plugins");
  const pluginDir = path.join(pluginRoot, "sample.plugin");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(pluginDir, "index.cjs"), "process.exit(0);");
  let captured;
  try {
    const runtime = createPluginRuntime({
      pluginRoot,
      authorize: async () => true,
      spawnSandbox: async request => {
        captured = request;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    });
    const result = await runtime.run({
      apiVersion: 1, id: "sample.plugin", name: "Sample", entry: "index.cjs",
      capabilities: ["project.read"], resources: { timeoutMs: 5000, memoryMb: 64 }
    }, { workspaceRoot: workspace });
    assert.equal(result.exitCode, 0);
    assert.equal(captured.pluginRoot, pluginDir);
    assert.equal(captured.workspaceRoot, workspace);
    assert.deepEqual(captured.limits.filesystem, ["project.read"]);
    assert.equal(captured.limits.network, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects plugin entry symlinks that escape the installation directory", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { createPluginRuntime } = require("./plugin-runtime.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-runtime-"));
  const pluginRoot = path.join(root, "plugins");
  const pluginDir = path.join(pluginRoot, "sample.plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const outside = path.join(root, "outside.cjs");
  fs.writeFileSync(outside, "process.exit(0);");
  fs.symlinkSync(outside, path.join(pluginDir, "index.cjs"));
  try {
    const runtime = createPluginRuntime({
      pluginRoot, authorize: async () => true,
      spawnSandbox: async () => ({ exitCode: 0 })
    });
    await assert.rejects(runtime.run({
      apiVersion: 1, id: "sample.plugin", name: "Sample", entry: "index.cjs", capabilities: []
    }), /escaped/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
