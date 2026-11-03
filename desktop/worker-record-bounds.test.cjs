"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore, MAX_LOG_LINES, MAX_LOG_LINE_LENGTH, MAX_TITLE_LENGTH, MAX_DIAGNOSTIC_LENGTH, MAX_ERROR_LENGTH } = require("./worker-state.cjs");

test("worker records persist bounded titles, diagnostics, errors, and recent logs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-bounds-"));
  try {
    const store = createWorkerStateStore(root, path.join(root, "workspace"));
    const record = await store.record({
      taskId: "bounded-task",
      title: "T".repeat(MAX_TITLE_LENGTH + 50),
      status: "failed",
      attempt: 1,
      sessionId: "S".repeat(MAX_DIAGNOSTIC_LENGTH + 50),
      error: "E".repeat(MAX_ERROR_LENGTH + 50),
      logs: Array.from({ length: MAX_LOG_LINES + 20 }, (_, i) => `line-${i}-` + "L".repeat(MAX_LOG_LINE_LENGTH + 20))
    });
    assert.equal(record.title.length, MAX_TITLE_LENGTH);
    assert.equal(record.sessionId.length, MAX_DIAGNOSTIC_LENGTH);
    assert.equal(record.error.length, MAX_ERROR_LENGTH);
    assert.equal(record.logs.length, MAX_LOG_LINES);
    assert.ok(record.logs.every(line => line.length === MAX_LOG_LINE_LENGTH));
    assert.match(record.logs[0], /^line-20-/);
    const persisted = (await store.list())[0];
    assert.deepEqual(persisted, record);
    const files = await fs.readdir(path.join(root, "worker-state"));
    const state = JSON.parse(await fs.readFile(path.join(root, "worker-state", files[0]), "utf8"));
    assert.equal(state.tasks[0].logs.length, MAX_LOG_LINES);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
