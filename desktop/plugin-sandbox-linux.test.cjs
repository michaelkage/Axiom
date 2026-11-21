"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLinuxBubblewrapAdapter } = require("./plugin-sandbox-linux.cjs");

test("builds a fail-closed namespace with read-only plugin and workspace mounts", () => {
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-sandbox-"));
  const plugin = path.join(root, "plugin");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(plugin);
  fs.mkdirSync(workspace);
  try {
    const adapter = createLinuxBubblewrapAdapter();
    const args = adapter.buildArgs({
      executable: process.execPath,
      args: ["--version", path.join(plugin, "index.cjs")],
      cwd: plugin,
      pluginRoot: plugin,
      workspaceRoot: workspace,
      env: { AXIOM_PLUGIN_ID: "sample" },
      limits: { filesystem: ["project.read"], network: false }
    });
    assert.ok(args.includes("--unshare-all"));
    assert.ok(args.includes("--cap-drop"));
    assert.ok(args.includes("--ro-bind"));
    assert.ok(!args.includes("--share-net"));
    assert.ok(args.includes("--chdir"));
    assert.ok(args.includes(workspace));
    assert.ok(args.includes("/workspace"));
    assert.ok(args.includes("/opt/axiom-plugin/index.cjs"));
    assert.ok(args.includes("/opt/axiom-plugin"));
    const writeArgs = adapter.buildArgs({
      executable: process.execPath, args: [], cwd: plugin, pluginRoot: plugin,
      workspaceRoot: workspace, limits: { filesystem: ["project.write"], network: true }
    });
    assert.ok(writeArgs.includes("--bind"));
    assert.ok(writeArgs.includes("--share-net"));
    assert.ok(writeArgs.includes("/workspace"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects workspace and working-directory escapes", () => {
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-plugin-sandbox-"));
  const plugin = path.join(root, "plugin");
  fs.mkdirSync(plugin);
  try {
    const adapter = createLinuxBubblewrapAdapter();
    assert.throws(() => adapter.buildArgs({ executable: process.execPath, args: [], pluginRoot: plugin, cwd: root }), /escaped/);
    assert.throws(() => adapter.buildArgs({ executable: "node", args: [], pluginRoot: plugin, cwd: plugin }), /absolute/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to construct the Linux adapter on other operating systems", () => {
  if (process.platform === "linux") return;
  assert.throws(() => createLinuxBubblewrapAdapter(), /only on Linux/);
});
