"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore, MAX_LOG_LINES, MAX_LOG_LINE_LENGTH, MAX_LOG_TOTAL_LENGTH, MAX_TITLE_LENGTH, MAX_DIAGNOSTIC_LENGTH, MAX_ERROR_LENGTH, MAX_RESULT_LENGTH } = require("./worker-state.cjs");

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
    assert.ok(record.logs.length <= Math.min(MAX_LOG_LINES, Math.floor(MAX_LOG_TOTAL_LENGTH / MAX_LOG_LINE_LENGTH)));
    assert.ok(record.logs.every(line => line.length === MAX_LOG_LINE_LENGTH));
    assert.ok(record.logs.reduce((sum, line) => sum + line.length, 0) <= MAX_LOG_TOTAL_LENGTH);
    assert.match(record.logs[0], /^line-212-/);
    const persisted = (await store.list())[0];
    assert.deepEqual(persisted, record);
    const files = await fs.readdir(path.join(root, "worker-state"));
    const state = JSON.parse(await fs.readFile(path.join(root, "worker-state", files[0]), "utf8"));
    assert.equal(state.tasks[0].logs.length, record.logs.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("worker logs stay within a total character budget while retaining the newest tail", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-log-total-"));
  try {
    const store = createWorkerStateStore(root, path.join(root, "workspace"));
    const logs = Array.from({ length: 20 }, (_, i) => `entry-${i}-` + "X".repeat(3000));
    const record = await store.record({ taskId: "bounded-logs", title: "Bounded logs", status: "running", logs });
    assert.ok(record.logs.reduce((sum, line) => sum + line.length, 0) <= MAX_LOG_TOTAL_LENGTH);
    assert.match(record.logs.at(-1), /^entry-19-/);
    assert.equal(record.logs[0].length, MAX_LOG_TOTAL_LENGTH - 10 * logs[19].length);
    assert.match(record.logs[1], /^entry-10-/);
    assert.deepEqual((await store.list())[0].logs, record.logs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("worker records discard unrecognized fields before persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-extra-fields-"));
  try {
    const store = createWorkerStateStore(root, path.join(root, "workspace"));
    const record = await store.record({
      taskId: "known-fields-only",
      title: "Known fields",
      status: "running",
      arbitraryPayload: "X".repeat(100000)
    });
    assert.equal(Object.hasOwn(record, "arbitraryPayload"), false);
    const listed = (await store.list())[0];
    assert.equal(Object.hasOwn(listed, "arbitraryPayload"), false);
    const files = await fs.readdir(path.join(root, "worker-state"));
    const persisted = JSON.parse(await fs.readFile(path.join(root, "worker-state", files[0]), "utf8"));
    assert.equal(Object.hasOwn(persisted.tasks[0], "arbitraryPayload"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("worker results are bounded and non-serializable values are represented safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-result-bounds-"));
  try {
    const store = createWorkerStateStore(root, path.join(root, "workspace"));
    const oversized = { payload: "R".repeat(MAX_RESULT_LENGTH + 100) };
    const large = await store.record({
      taskId: "large-result",
      title: "Large result",
      status: "succeeded",
      result: oversized
    });
    assert.equal(large.result.truncated, true);
    assert.equal(large.result.preview.length, MAX_RESULT_LENGTH);
    assert.match(large.result.preview, /^{"payload":"R/);

    const circular = { label: "circular" };
    circular.self = circular;
    const unavailable = await store.record({
      taskId: "circular-result",
      title: "Circular result",
      status: "failed",
      result: circular
    });
    assert.deepEqual(unavailable.result, {
      unavailable: true,
      reason: "Worker result was not JSON-serializable."
    });

    const listed = await store.list();
    assert.deepEqual(listed.find(task => task.taskId === "large-result").result, large.result);
    assert.deepEqual(listed.find(task => task.taskId === "circular-result").result, unavailable.result);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
