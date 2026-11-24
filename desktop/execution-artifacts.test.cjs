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
test("serializes concurrent writes from independent store instances without losing index records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-artifacts-concurrent-"));
  try {
    const stores = Array.from({ length: 12 }, () => createExecutionArtifactStore({ root }));
    const records = await Promise.all(stores.map((store, index) => store.put({
      projectId: "shared-project",
      kind: "log",
      name: "Concurrent " + index,
      data: "output-" + index,
      metadata: { index }
    })));
    const listed = await createExecutionArtifactStore({ root }).list("shared-project");
    assert.equal(records.length, 12);
    assert.equal(listed.length, 12);
    assert.deepEqual(new Set(listed.map(record => record.id)), new Set(records.map(record => record.id)));
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

test("redacts credential material from text artifacts and metadata before persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-artifacts-"));
  try {
    const store = createExecutionArtifactStore({ root });
    const record = await store.put({
      projectId: "project-redaction",
      kind: "log",
      name: "Sensitive output",
      data: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      metadata: { note: "api_key=super-secret-value" }
    });
    const stored = await store.read("project-redaction", record.id);
    assert.doesNotMatch(stored.data.toString(), /abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.doesNotMatch(JSON.stringify(record.metadata), /super-secret-value/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
