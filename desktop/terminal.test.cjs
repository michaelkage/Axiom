"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createTerminalRunner } = require("./terminal.cjs");

test("terminal executes a command in the selected project and streams output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-"));
  try {
    const runner = createTerminalRunner({ workspaceRoot: root, platform: process.platform });
    const chunks = [];
    const result = await runner.run({
      requestId: "test-run",
      command: process.platform === "win32" ? "Write-Output 'terminal works'" : "printf 'terminal works\\n'",
      onOutput: chunk => chunks.push(chunk.text)
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.cwd, root);
    assert.match(chunks.join(""), /terminal works/);
    assert.equal(runner.activeCount(), 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("terminal rejects absolute and parent-traversal working directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-"));
  try {
    const runner = createTerminalRunner({ workspaceRoot: root, platform: "linux" });
    assert.throws(() => runner.resolveCwd("../outside"), /inside the project/);
    assert.throws(() => runner.resolveCwd(path.resolve(root, "..")), /relative project path|inside the project/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("terminal rejects symlink working directories that escape the project", { skip: process.platform === "win32" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-outside-"));
  try {
    await fs.symlink(outside, path.join(root, "outside-link"), "dir");
    const runner = createTerminalRunner({ workspaceRoot: root, platform: "linux" });
    assert.throws(() => runner.resolveCwd("outside-link"), /symbolic links/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("terminal rejects malformed commands and request IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-"));
  try {
    const runner = createTerminalRunner({ workspaceRoot: root, platform: "linux" });
    assert.throws(() => runner.run({ requestId: "bad id", command: "pwd" }), /request ID/);
    assert.throws(() => runner.run({ requestId: "valid", command: " " }), /Enter a command/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("terminal cancellation reaps a running process and clears its active request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-"));
  try {
    const runner = createTerminalRunner({ workspaceRoot: root });
    const pending = runner.run({ requestId: "cancel-run", command: 'node -e "setTimeout(() => {}, 10000)"' });
    const deadline = Date.now() + 3000;
    while (runner.activeCount() === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runner.activeCount(), 1);
    assert.equal(await runner.cancel("cancel-run"), true);
    const result = await pending;
    assert.notEqual(result.exitCode, 0);
    assert.equal(runner.activeCount(), 0);
    assert.equal(await runner.cancel("cancel-run"), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("terminal shutdown cancels every active request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-terminal-"));
  try {
    const runner = createTerminalRunner({ workspaceRoot: root });
    const command = 'node -e "setTimeout(() => {}, 10000)"';
    const first = runner.run({ requestId: "shutdown-one", command });
    const second = runner.run({ requestId: "shutdown-two", command });
    const deadline = Date.now() + 3000;
    while (runner.activeCount() < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runner.activeCount(), 2);
    await runner.stopAll();
    await Promise.all([first, second]);
    assert.equal(runner.activeCount(), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
