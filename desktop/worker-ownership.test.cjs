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
