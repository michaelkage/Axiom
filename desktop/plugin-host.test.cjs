"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPluginHost } = require("./plugin-host.cjs");

test("lists only valid installed plugins and runs the trusted on-disk manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-host-"));
  const plugin = path.join(root, "sample.plugin");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(plugin);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(plugin, "manifest.json"), JSON.stringify({
    apiVersion: 1, id: "sample.plugin", name: "Sample Plugin", entry: "index.cjs",
    capabilities: ["project.read"], resources: { timeoutMs: 5000, memoryMb: 64 }
  }));
  fs.writeFileSync(path.join(plugin, "index.cjs"), "process.stdin.resume();");
  let captured;
  try {
    const host = createPluginHost({
      root,
      authorize: async () => true,
      spawnSandbox: async request => { captured = request; return { exitCode: 0, stdout: "ok", stderr: "" }; }
    });
    assert.deepEqual(host.list().map(item => item.id), ["sample.plugin"]);
    const result = await host.run("sample.plugin", { workspaceRoot: workspace, args: ["hello"] });
    assert.equal(result.exitCode, 0);
    assert.equal(captured.workspaceRoot, workspace);
    assert.deepEqual(captured.limits.filesystem, ["project.read"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not list or follow symlinked plugin installations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-host-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, "linked.plugin"), "dir");
    const host = createPluginHost({ root, authorize: async () => true, spawnSandbox: async () => ({ exitCode: 0 }) });
    assert.deepEqual(host.list(), []);
    await assert.rejects(host.run("linked.plugin"), /ENOENT|invalid/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
