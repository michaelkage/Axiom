"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createExecutionArtifactStore } = require("./execution-artifacts.cjs");

test("stores project-scoped artifacts with content integrity and bounded metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-artifacts-"));
  try {
    const store = createExecutionArtifactStore({ root });
    const record = await store.put({ projectId: "project-a", taskId: "task-1", kind: "report", name: "Verification", data: "all checks passed", metadata: { exitCode: 0 } });
    assert.equal((await store.list("project-a")).length, 1);
    const read = await store.read("project-a", record.id);
    assert.equal(read.data.toString(), "all checks passed");
    assert.equal(await store.remove("project-a", record.id), true);
    assert.equal((await store.list("project-a")).length, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("does not expose artifacts across project boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-artifacts-"));
  try {
    const store = createExecutionArtifactStore({ root });
    const record = await store.put({ projectId: "project-a", kind: "log", name: "Worker", data: "log" });
    await assert.rejects(() => store.read("project-b", record.id), /not found/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
