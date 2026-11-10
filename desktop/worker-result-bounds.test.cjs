"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore, MAX_RESULT_LENGTH } = require("./worker-state.cjs");

test("worker result payloads are bounded before persistence and on read", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-result-bounds-"));
  try {
    const store = createWorkerStateStore(root, path.join(root, "workspace"));
    const result = { output: "R".repeat(MAX_RESULT_LENGTH + 500) };
    const record = await store.record({ taskId: "large-result", title: "Large result", status: "succeeded", attempt: 1, result });
    assert.equal(record.result.truncated, true);
    assert.equal(record.result.preview.length, MAX_RESULT_LENGTH);
    assert.equal((await store.list())[0].result.preview.length, MAX_RESULT_LENGTH);
    const files = await fs.readdir(path.join(root, "worker-state"));
    const state = JSON.parse(await fs.readFile(path.join(root, "worker-state", files[0]), "utf8"));
    assert.equal(state.tasks[0].result.preview.length, MAX_RESULT_LENGTH);
    assert.ok((await fs.stat(path.join(root, "worker-state", files[0]))).size < MAX_RESULT_LENGTH + 2000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-JSON-serializable worker results are replaced with a diagnostic", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-result-invalid-"));
  try {
    const store = createWorkerStateStore(root, path.join(root, "workspace"));
    const circular = {}; circular.self = circular;
    const record = await store.record({ taskId: "circular-result", title: "Circular result", status: "failed", result: circular });
    assert.deepEqual(record.result, { unavailable: true, reason: "Worker result was not JSON-serializable." });
    assert.deepEqual((await store.list())[0].result, record.result);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
