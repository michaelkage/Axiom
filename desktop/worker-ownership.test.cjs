"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkerOwnershipRegistry } = require("./worker-ownership.cjs");

test("prevents overlapping worker ownership and rejects out-of-scope changes", () => {
  const registry = createWorkerOwnershipRegistry();
  registry.claim("task-a", ["src/a"]);
  assert.throws(() => registry.claim("task-b", ["src/a/file.ts"]), /conflict/);
  registry.claim("task-b", ["src/b"]);
  assert.deepEqual(registry.validateChanges("task-a", ["src/a/file.ts"]).allowed, true);
  assert.deepEqual(registry.validateChanges("task-a", ["src/b/file.ts"]).violations, ["src/b/file.ts"]);
});
test("normalizes paths and releases ownership explicitly", () => {
  const registry = createWorkerOwnershipRegistry();
  registry.claim("task-a", ["src\\one"]);
  assert.equal(registry.release("task-a"), true);
  assert.equal(registry.release("task-a"), false);
  assert.throws(() => registry.claim("task-b", ["../outside"]), /relative|traversal/i);
});

test("persists ownership and restores claims after a process restart", t => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "claims.json");
  const first = createWorkerOwnershipRegistry({ filePath, workspaceRoot: root });
  first.claim("task-persisted", ["src/owned"]);
  const restored = createWorkerOwnershipRegistry({ filePath, workspaceRoot: root });
  assert.equal(restored.validateChanges("task-persisted", ["src/owned/file.ts"]).allowed, true);
  assert.throws(() => restored.claim("other-task", ["src/owned/file.ts"]), /conflict/);
  assert.equal(restored.release("task-persisted"), true);
  assert.throws(() => createWorkerOwnershipRegistry({ filePath, workspaceRoot: root }).validateChanges("task-persisted", []), /no registered/);
});

test("fails closed for ownership state belonging to another workspace", t => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-ownership-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "claims.json");
  createWorkerOwnershipRegistry({ filePath, workspaceRoot: path.join(root, "one") }).claim("task-a", ["src/a"]);
  assert.throws(() => createWorkerOwnershipRegistry({ filePath, workspaceRoot: path.join(root, "two") }), /does not match/);
});

test("reconciles stale claims without touching active task ownership", () => {
  const registry = createWorkerOwnershipRegistry();
  registry.claim("active-task", ["src/active"]);
  registry.claim("stale-task", ["src/stale"]);
  assert.deepEqual(registry.reconcile(["active-task"]).removed, ["stale-task"]);
  assert.equal(registry.validateChanges("active-task", ["src/active/a.ts"]).allowed, true);
  assert.throws(() => registry.validateChanges("stale-task", []), /no registered/);
});
