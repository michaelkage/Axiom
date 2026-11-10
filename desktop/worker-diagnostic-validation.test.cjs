"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidTask } = require("./worker-state.cjs");

const valid = { taskId: "task-1", title: "Build app", status: "running", attempt: 1 };
test("worker task identity and diagnostic fields have valid shapes", () => {
  assert.equal(isValidTask(valid), true);
  for (const taskId of ["", "   ", "x".repeat(129)]) assert.equal(isValidTask({ ...valid, taskId }), false);
  assert.equal(isValidTask({ ...valid, title: "   " }), false);
  for (const field of ["sessionId", "worktreePath", "workerType", "integrationId", "toolName", "error"]) {
    assert.equal(isValidTask({ ...valid, [field]: 42 }), false, field);
  }
  for (const logs of ["not-an-array", [1], [null]]) assert.equal(isValidTask({ ...valid, logs }), false);
  for (const timestamp of [NaN, Infinity, "100"]) assert.equal(isValidTask({ ...valid, startedAt: timestamp }), false);
  assert.equal(isValidTask({ ...valid, updatedAt: "not-a-date" }), false);
  assert.equal(isValidTask({ ...valid, logs: ["worker started"], startedAt: 100, updatedAt: new Date(100).toISOString() }), true);
});
