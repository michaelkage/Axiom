"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyWorkspaceDrift } = require("./workspace-drift.cjs");
test("allows integration when task and workspace share the same base revision", () => {
  assert.deepEqual(classifyWorkspaceDrift({ taskBaseBlob: "blob-a", workspaceHeadBlob: "blob-a" }), { safe: true, reason: null });
});
test("blocks integration when a pull or another committed change advanced the destination file", () => {
  const result = classifyWorkspaceDrift({ taskBaseBlob: "old-blob", workspaceHeadBlob: "new-blob" });
  assert.equal(result.safe, false);
  assert.match(result.reason, /changed after this worker started/);
});
test("blocks integration when the destination has uncommitted local edits", () => {
  const result = classifyWorkspaceDrift({ taskBaseBlob: "blob-a", workspaceHeadBlob: "blob-a", destinationDirty: true });
  assert.equal(result.safe, false);
  assert.match(result.reason, /uncommitted local changes/);
});
test("blocks creation over an untracked destination file", () => {
  const result = classifyWorkspaceDrift({ taskBaseBlob: null, workspaceHeadBlob: null, destinationExists: true });
  assert.equal(result.safe, false);
  assert.match(result.reason, /untracked or ignored/);
});
test("allows a new file when neither base nor destination has a file", () => {
  assert.deepEqual(classifyWorkspaceDrift({ taskBaseBlob: null, workspaceHeadBlob: null }), { safe: true, reason: null });
});
