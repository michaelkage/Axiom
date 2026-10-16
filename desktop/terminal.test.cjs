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
