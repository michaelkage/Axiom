"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore, MAX_TASKS } = require("./worker-state.cjs");

test("history eviction retains recently updated tasks over untouched older records", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-history-retention-"));
  try {
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    const store = createWorkerStateStore(path.join(temp, "user"), workspace);
    for (let index = 0; index < MAX_TASKS; index++) {
      await store.record({ taskId: "task-" + index, title: "Task " + index, status: "queued" });
    }
    await store.record({ taskId: "task-0", title: "Task 0", status: "running", logs: ["recently active"] });
    await store.record({ taskId: "new-task", title: "New task", status: "queued" });
    const tasks = await store.list();
    assert.equal(tasks.length, MAX_TASKS);
    assert.equal(tasks.some(task => task.taskId === "task-0"), true);
    assert.equal(tasks.some(task => task.taskId === "task-1"), false);
    assert.equal(tasks.at(-1).taskId, "new-task");
    assert.equal(tasks.find(task => task.taskId === "task-0").status, "running");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
